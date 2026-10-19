import moment from "moment";
import { z } from "zod";
import db from "../../modules/db";
import type { DbOperations, TableDef } from "../db/contract";
import { fieldMeta, fieldsFromSchema } from "../db/table_def";
import { HttpError } from "../http_error";
import { relation } from "./data_type/relation";
import { text } from "./data_type/text";
import { UniqueConstraintError } from "./errors";
import { runAfterHooks, runBeforeDestroyHooks, runBeforeHooks } from "./hooks";
import type { DraftOptions, makeModel, ReadMeta, ReadOptions } from "./index";
import {
  assertLocale,
  isEmpty,
  isOneLocale,
  linksOf,
  localeMapSchema,
  localizeLinks,
  registerLocalizedSource,
  settings,
  stable,
  translationTableName,
} from "./localized";

// A model made with `i18n: true` is two tables behind one model:
//
//   <prefix>        what is the same in every language (and the id every other model links to)
//   <prefix>__i18n  one row per record and language, id "<recordId>.<locale>". It holds the
//                   `localized` fields — and a copy of the shared columns, kept in step by the
//                   writes below, so a query for one language filters, sorts and searches any
//                   field with plain column access on this one table.
//
// Any field — an array included — is shared unless it says `localized: true`. A shared array
// is stored once on the shared table and copied, like the other shared columns, onto every
// language's row (its child table is owned by that row). Every read goes through the existing
// makeModel() machinery, once on each table, so filters, search, sort, select, populate and
// pagination behave exactly as on any other model.
//
// With `draftable: true` the translation table is itself a draftable model: each language of a
// record has its own status, and its own published copy in `_published_<prefix>__i18n` — a row
// per record and language, so publishing "en" leaves "id" as it was.

type Rec = Record<string, any>;

// The part of a plain model this file relies on.
type Plain = {
  def: TableDef;
  prefix: string;
  validation: z.ZodObject;
  read(options?: Rec): Promise<{ data: Rec[]; meta: ReadMeta }>;
  assertUnique(data: Rec, excludeId?: string): Promise<void>;
  // Only when the model is draftable.
  publishedDef?: TableDef;
  published?: {
    read(options?: Rec): Promise<{ data: Rec[]; meta: ReadMeta }>;
  };
  publishIn?(tx: DbOperations, id: string, now?: string): Promise<Rec>;
  unpublishIn?(tx: DbOperations, id: string): Promise<Rec>;
  backfillPublished?(): Promise<number>;
};

export type I18nReadOptions = Omit<ReadOptions, "select"> & {
  // A locale code for one language (rows come back flat, `id` is the record's id), or "all" /
  // nothing for every language of each record (a localized field is `{ locale: value }`).
  locale?: string;
  // With a locale: fill a field the language has no value for from the default locale.
  // Defaults to true.
  fallback?: boolean;
  select?: readonly string[];
};

export type I18nModel = {
  name: string;
  prefix: string;
  // The table of what is shared by every language.
  def: TableDef;
  // The table with one row per record and language.
  i18nDef: TableDef;
  // Localized fields are `{ locale: value }` maps in this schema.
  validation: z.ZodObject;
  searchFields: string[];
  create(data: Rec): Promise<Rec>;
  update(id: string, data: Rec): Promise<Rec | null>;
  destroy(id: string): Promise<Rec | undefined>;
  read(options?: I18nReadOptions): Promise<{ data: Rec[]; meta: ReadMeta }>;
  show(
    id: string,
    options?: { locale?: string; fallback?: boolean },
  ): Promise<Rec | undefined>;
  // Deletes one language of a record. The last one cannot be removed — delete the record.
  removeLocale(id: string, locale: string): Promise<Rec>;
  assertUnique(data: Rec, excludeId?: string): Promise<void>;
};

// On an i18n model with `draftable: true`. Each language of a record is published on its own;
// `locale` names one language or a list, and leaving it out means every language that exists.
export type I18nDraftApi = {
  // What is live, one language at a time: `article.published.read({ locale: "en" })`.
  published: {
    read(
      options: I18nReadOptions & { locale: string },
    ): Promise<{ data: Rec[]; meta: ReadMeta }>;
    show(
      id: string,
      options: { locale: string; fallback?: boolean },
    ): Promise<Rec | undefined>;
  };
  publishedDef: TableDef;
  publish(id: string, options?: DraftOptions): Promise<Rec>;
  unpublish(id: string, options?: DraftOptions): Promise<Rec>;
  // Throws a language's unpublished edits away (its localized fields go back to what is live).
  discard(id: string, options?: DraftOptions): Promise<Rec>;
  backfillPublished(): Promise<number>;
};

const rowId = (id: string, locale: string) => `${id}.${locale}`;

export const makeI18nModel = (
  prefix: string,
  config: {
    schema: z.ZodObject;
    name: string;
    searchFields: string[];
    draftable?: boolean;
  },
  deps: {
    makeModel: typeof makeModel;
    registerSchema: (prefix: string, schema: z.ZodObject) => void;
    registerLocalizedFields: (
      prefix: string,
      fields: ReadonlySet<string>,
    ) => void;
  },
): I18nModel & Partial<I18nDraftApi> => {
  const shape = config.schema.shape as Record<string, z.ZodType>;
  const where = `Model "${config.name}"`;
  const draftable = config.draftable === true;

  for (const reserved of ["locale", "article_id"]) {
    if (reserved in shape) {
      throw new Error(`${where}: "${reserved}" is reserved on an i18n model.`);
    }
  }

  // ---- which fields are per language ---------------------------------------------------

  const localized = new Set<string>();
  const shared = new Set<string>();
  const uniqueLocalized: string[] = [];
  const requiredLocalized: string[] = [];

  for (const field of fieldsFromSchema(config.schema)) {
    const meta = fieldMeta(shape[field.name]!);
    const flagged = meta.localized === true;

    // A relation takes on the language of the model it points at (see localizeLinks), so the
    // field itself is never per language. A file or a list of files can be.
    if (
      flagged &&
      (meta.renderAs === "relation" || meta.renderAs === "multi_relation")
    ) {
      throw new Error(
        `${where}: "${field.name}" is a relation, which takes on the language of the model it points at, so it cannot be localized itself; leave it shared.`,
      );
    }

    if (flagged) {
      localized.add(field.name);
      if (meta.unique === true) uniqueLocalized.push(field.name);
      if (!shape[field.name]!.safeParse(undefined).success) {
        requiredLocalized.push(field.name);
      }
    } else {
      shared.add(field.name);
    }
  }

  if (localized.size === 0) {
    throw new Error(
      `${where}: i18n: true needs at least one field with \`localized: true\`.`,
    );
  }

  const localizedList = [...localized];
  const sharedList = [...shared];
  // Fields that link to another model: relations, files, and lists of them.
  const linkKinds = new Map(
    fieldsFromSchema(config.schema).map((f) => [f.name, f.kind]),
  );
  const isLink = (name: string) =>
    linkKinds.get(name) === "one" || linkKinds.get(name) === "many";
  const sharedRelations = sharedList.filter(isLink);
  const localizedRelations = localizedList.filter(isLink);
  const allRelations = [...sharedRelations, ...localizedRelations];
  // The relations that may point at an i18n model, whose records are read in a language.
  const links = linksOf(config.schema);

  // The links to expand, from what the caller asked for (all of them when it asked for nothing).
  const expand = (option: readonly string[] | "none" | undefined) => {
    const wanted = option === "none" ? [] : (option ?? allRelations);
    return {
      shared: wanted.filter((name) => sharedRelations.includes(name)),
      localized: wanted.filter((name) => localizedRelations.includes(name)),
      all: wanted.filter((name) => allRelations.includes(name)),
    };
  };

  // What differs per language and is read from the language's row when listing every language:
  // the localized fields and, on a draftable model, the status of each language.
  const perLanguage = draftable
    ? [...localizedList, "status", "publishedAt"]
    : localizedList;
  const perLanguageSet = new Set(perLanguage);

  const pick = (source: Rec, keys: Iterable<string>) => {
    const out: Rec = {};
    for (const key of keys) if (key in source) out[key] = source[key];
    return out;
  };

  // ---- the two tables ------------------------------------------------------------------

  const sharedSchema = z.object(
    Object.fromEntries(sharedList.map((name) => [name, shape[name]!])),
  );

  const main = deps.makeModel(prefix, {
    name: config.name,
    schema: sharedSchema,
    searchFields: config.searchFields.filter((entry) =>
      shared.has(entry.split(".")[0]!),
    ),
  }) as unknown as Plain;
  // Other models' searchFields ("category.name") must see the localized fields too.
  deps.registerSchema(prefix, config.schema);
  deps.registerLocalizedFields(prefix, localized);

  const translations = deps.makeModel(translationTableName(prefix), {
    name: `${config.name} (translations)`,
    schema: z.object({
      article_id: relation({ label: "Record" }, main as never),
      locale: text({ label: "Locale" }),
      ...shape,
    }),
    searchFields: config.searchFields,
    enforceUnique: false,
    draftable,
  }) as unknown as Plain;

  // ---- what the API and agents are given -------------------------------------------------

  const validation = z.object(
    Object.fromEntries(
      Object.keys(shape).map((name) => [
        name,
        localized.has(name) ? localeMapSchema(shape[name]!) : shape[name]!,
      ]),
    ),
  );

  // ---- helpers -------------------------------------------------------------------------

  // { title: { en: "A", id: "B" }, author: "u1" } -> shared part + one object per locale
  const split = (input: Rec) => {
    const sharedPart: Rec = {};
    const byLocale = new Map<string, Rec>();

    for (const [key, value] of Object.entries(input)) {
      if (shared.has(key)) {
        sharedPart[key] = value;
        continue;
      }
      if (!localized.has(key) || value === undefined) continue;

      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError(
          422,
          `"${key}" is per language: give it as an object keyed by locale, e.g. { "${settings().defaultLocale}": ... }`,
        );
      }

      for (const [locale, localeValue] of Object.entries(value)) {
        assertLocale(locale);
        if (localeValue === undefined) continue;
        const values = byLocale.get(locale) ?? {};
        values[key] = localeValue;
        byLocale.set(locale, values);
      }
    }

    return { sharedPart, byLocale };
  };

  const assertComplete = (locale: string, values: Rec) => {
    for (const name of requiredLocalized) {
      if (values[name] === undefined || values[name] === null) {
        throw new HttpError(422, `${locale}: "${name}" is required`);
      }
    }
  };

  const assertNotCleared = (locale: string, values: Rec) => {
    for (const name of requiredLocalized) {
      if (name in values && values[name] === null) {
        throw new HttpError(422, `${locale}: "${name}" is required`);
      }
    }
  };

  // A localized field is unique within its language, not across them.
  const assertLocalizedUnique = async (
    byLocale: Map<string, Rec>,
    excludeId?: string,
  ) => {
    for (const [locale, values] of byLocale) {
      for (const name of uniqueLocalized) {
        const value = values[name];
        if (value === undefined || value === null) continue;

        const taken = await db().count(translations.def, [
          { field: name, op: "$eq", value },
          { field: "locale", op: "$eq", value: locale },
          ...(excludeId
            ? [{ field: "article_id", op: "$ne" as const, value: excludeId }]
            : []),
        ]);
        if (taken > 0) throw new UniqueConstraintError(name, value);
      }
    }
  };

  // A language that was published stops matching what is live as soon as it is edited.
  const afterEdit = (row: Rec | null | undefined): Rec =>
    draftable && row?.status === "published" ? { status: "changed" } : {};

  // Whether two rows of one language hold the same content (every field of the model).
  const sameContent = (a: Rec, b: Rec) =>
    Object.keys(shape).every(
      (name) =>
        JSON.stringify(stable(a[name])) === JSON.stringify(stable(b[name])),
    );

  // The language rows of one record, as { field: { locale: value } }.
  const attachTranslations = async (
    row: Rec,
    fields: string[],
    populate: readonly string[] = localizedRelations,
  ) => {
    const { locales } = settings();
    const rows = await Promise.all(
      locales.map((locale) =>
        db().find(translations.def, rowId(row.id, locale), {
          populate: populate.filter((name) => fields.includes(name)),
        }),
      ),
    );

    const out: Rec = { ...row };
    for (const name of fields) {
      const map: Rec = {};
      rows.forEach((translation, index) => {
        if (translation) map[locales[index]!] = translation[name] ?? null;
      });
      out[name] = map;
    }
    return out;
  };

  // Every language of a record. The relations are expanded as the caller asked; one that points
  // at an i18n model is that record in the default language, since no language is being read.
  const showAll = async (
    id: string,
    populate?: readonly string[] | "none",
    fields: string[] = perLanguage,
  ) => {
    const lists = expand(populate);
    const row = await db().find(main.def, id, { populate: lists.shared });
    if (!row) return undefined;

    await localizeLinks(
      [row],
      links.filter((link) => lists.shared.includes(link.name)),
      undefined,
    );
    return attachTranslations(row, fields, lists.localized);
  };

  // Turns a row of the translation table into the record of that language.
  const flatten = (row: Rec) => {
    const { article_id, id: _rowId, ...rest } = row;
    return {
      ...rest,
      id: typeof article_id === "object" ? article_id.id : article_id,
    } as Rec;
  };

  // A field the language has no value for takes the default language's (from the same side,
  // working or published, as the rows being filled).
  const fillFromDefault = async (
    rows: Rec[],
    locale: string,
    fields: string[],
    table: TableDef = translations.def,
    // The links among `fields` the rows were read with expanded: a value taken from the default
    // language has to be expanded the same way.
    populate: readonly string[] = [],
  ) => {
    const { defaultLocale } = settings();
    if (locale === defaultLocale || fields.length === 0) return;

    const needy = rows.filter((row) => fields.some((f) => isEmpty(row[f])));
    const defaults = await Promise.all(
      needy.map((row) =>
        db().find(table, rowId(row.id, defaultLocale), {
          populate: populate.filter((name) => fields.includes(name)),
        }),
      ),
    );

    needy.forEach((row, index) => {
      const fallback = defaults[index];
      if (!fallback) return;
      for (const name of fields) {
        if (isEmpty(row[name]) && !isEmpty(fallback[name])) {
          row[name] = fallback[name];
        }
      }
    });
  };

  // A relation from another model to this one is read in the language being read: the record of
  // that language, or the default language's when it has none (unless `fallback` is off).
  registerLocalizedSource(prefix, {
    records: async (ids, locale, fallback) => {
      const { defaultLocale } = settings();
      const found = new Map<string, Rec>();

      const rows = await Promise.all(
        ids.map((id) =>
          db().find(translations.def, rowId(id, locale), { populate: [] }),
        ),
      );
      const missing: string[] = [];
      rows.forEach((row, index) => {
        if (row) found.set(ids[index]!, flatten(row));
        else missing.push(ids[index]!);
      });

      if (fallback && locale !== defaultLocale && missing.length > 0) {
        const defaults = await Promise.all(
          missing.map((id) =>
            db().find(translations.def, rowId(id, defaultLocale), {
              populate: [],
            }),
          ),
        );
        defaults.forEach((row, index) => {
          if (row) found.set(missing[index]!, flatten(row));
        });
      }

      if (fallback) {
        await fillFromDefault([...found.values()], locale, localizedList);
      }
      return found;
    },
  });

  // ---- reading -------------------------------------------------------------------------

  // `published` reads what is live instead of the working copies.
  const readLocale = async (
    locale: string,
    options: Omit<I18nReadOptions, "locale" | "fallback">,
    fallback: boolean,
    published = false,
  ) => {
    assertLocale(locale);

    const populate =
      options.populate === "none"
        ? ("none" as const)
        : expand(options.populate).all;
    const select = options.select?.length
      ? [...new Set([...options.select, "article_id", "locale"])]
      : undefined;

    // `locale` is also what the related records of other i18n models are read in.
    const source = published ? translations.published! : translations;
    const result = await source.read({
      ...options,
      populate,
      select,
      locale,
      fallback,
      filters: { ...options.filters, locale },
    });

    const data = result.data.map(flatten);
    if (fallback) {
      const wanted = options.select?.length
        ? localizedList.filter((name) => options.select!.includes(name))
        : localizedList;
      await fillFromDefault(
        data,
        locale,
        wanted,
        published ? translations.publishedDef! : translations.def,
        populate === "none" ? [] : populate,
      );
    }

    return { data, meta: result.meta };
  };

  const readAll = async (
    options: Omit<I18nReadOptions, "locale" | "fallback">,
  ) => {
    const selected = options.select?.length
      ? new Set(options.select)
      : undefined;
    const wantedPerLanguage = selected
      ? perLanguage.filter((name) => selected.has(name))
      : perLanguage;

    const touchesLanguages =
      Boolean(options.search?.trim()) ||
      Object.keys(options.filters ?? {}).some((key) =>
        perLanguageSet.has(key),
      ) ||
      (options.sort !== undefined && perLanguageSet.has(options.sort));

    if (!touchesLanguages) {
      const sharedSelect = options.select?.filter(
        (name) => !perLanguageSet.has(name),
      );
      const result = await main.read({
        ...options,
        select: sharedSelect?.length ? sharedSelect : undefined,
      });
      const localizedLinks = expand(options.populate).localized;
      return {
        data: await Promise.all(
          result.data.map((row) =>
            attachTranslations(row, wantedPerLanguage, localizedLinks),
          ),
        ),
        meta: result.meta,
      };
    }

    // A condition on something that is per language is answered by the translation table; a
    // record that matches in several languages is listed once (a page can come up short).
    const found = await translations.read({
      search: options.search,
      filters: options.filters,
      sort: options.sort,
      order: options.order,
      page: options.page,
      limit: options.limit,
      populate: "none",
      select: ["article_id"],
    });
    const ids = [...new Set(found.data.map((row) => String(row.article_id)))];
    const records = await Promise.all(
      ids.map((id) => showAll(id, options.populate, wantedPerLanguage)),
    );
    return {
      data: records.filter((record): record is Rec => record !== undefined),
      meta: found.meta,
    };
  };

  const read = (options: I18nReadOptions = {}) => {
    const { locale, fallback, ...rest } = options;
    return isOneLocale(locale)
      ? readLocale(locale, rest, fallback !== false)
      : readAll(rest);
  };

  const showLocale = async (
    id: string,
    locale: string,
    fallback: boolean,
    published: boolean,
  ) => {
    assertLocale(locale);
    const table = published ? translations.publishedDef! : translations.def;

    const row = await db().find(table, rowId(id, locale), {
      populate: allRelations,
    });
    if (!row) return undefined;

    await localizeLinks([row], links, locale, fallback);
    const record = flatten(row);
    if (fallback) {
      await fillFromDefault(
        [record],
        locale,
        localizedList,
        table,
        localizedRelations,
      );
    }
    return record;
  };

  const show = async (
    id: string,
    options: { locale?: string; fallback?: boolean } = {},
  ) =>
    isOneLocale(options.locale)
      ? showLocale(id, options.locale, options.fallback !== false, false)
      : showAll(id);

  // ---- writing -------------------------------------------------------------------------

  const create = async (data: Rec) => {
    const merged = (await runBeforeHooks(
      "beforeCreate",
      prefix,
      data,
      {},
    )) as Rec;
    const { sharedPart, byLocale } = split(merged);

    if (byLocale.size === 0) {
      throw new HttpError(422, "At least one language is needed");
    }
    for (const [locale, values] of byLocale) assertComplete(locale, values);

    await main.assertUnique(sharedPart);
    await assertLocalizedUnique(byLocale);

    const now = moment().toISOString();
    const id = await db().transaction(async (tx) => {
      const row = await tx.insert(main.def, {
        ...sharedPart,
        createdAt: now,
        updatedAt: now,
      });

      const mirror = pick(row, sharedList);
      for (const [locale, values] of byLocale) {
        await tx.insert(
          translations.def,
          {
            ...values,
            ...mirror,
            ...(draftable ? { status: "draft", publishedAt: null } : {}),
            article_id: row.id,
            locale,
            createdAt: now,
            updatedAt: now,
          },
          { id: rowId(row.id, locale) },
        );
      }
      return row.id;
    });

    const record = (await showAll(id))!;
    await runAfterHooks("afterCreate", prefix, record);
    return record;
  };

  const update = async (id: string, data: Rec) => {
    const merged = (await runBeforeHooks("beforeUpdate", prefix, data, {
      id,
    })) as Rec;
    const { sharedPart, byLocale } = split(merged);

    for (const [locale, values] of byLocale) assertNotCleared(locale, values);
    await main.assertUnique(sharedPart, id);
    await assertLocalizedUnique(byLocale, id);

    const now = moment().toISOString();
    const found = await db().transaction(async (tx) => {
      if (!(await tx.find(main.def, id, { populate: [] }))) return false;

      const row = (await tx.update(main.def, id, {
        ...sharedPart,
        updatedAt: now,
      }))!;
      const mirror = pick(row, sharedList);

      // A change to a shared field reaches every language that has a row.
      if (Object.keys(sharedPart).length > 0) {
        const changed = pick(row, Object.keys(sharedPart));
        for (const locale of settings().locales) {
          const rid = rowId(id, locale);
          const current = draftable
            ? await tx.find(translations.def, rid, { populate: [] })
            : null;
          await tx.update(translations.def, rid, {
            ...changed,
            updatedAt: now,
            ...afterEdit(current),
          });
        }
      }

      for (const [locale, values] of byLocale) {
        const rid = rowId(id, locale);
        const existing = await tx.find(translations.def, rid, {
          populate: [],
        });
        if (existing) {
          await tx.update(translations.def, rid, {
            ...values,
            updatedAt: now,
            ...afterEdit(existing),
          });
          continue;
        }

        assertComplete(locale, values);
        await tx.insert(
          translations.def,
          {
            ...values,
            ...mirror,
            ...(draftable ? { status: "draft", publishedAt: null } : {}),
            article_id: id,
            locale,
            createdAt: row.createdAt,
            updatedAt: now,
          },
          { id: rid },
        );
      }
      return true;
    });
    if (!found) return null;

    const record = (await showAll(id))!;
    await runAfterHooks("afterUpdate", prefix, record);
    return record;
  };

  const destroy = async (id: string) => {
    await runBeforeDestroyHooks(prefix, id);

    const record = await showAll(id);
    await db().transaction(async (tx) => {
      // What is live goes with the record.
      if (translations.publishedDef) {
        await tx.removeWhere(translations.publishedDef, [
          { field: "article_id", op: "$eq", value: id },
        ]);
      }
      await tx.removeWhere(translations.def, [
        { field: "article_id", op: "$eq", value: id },
      ]);
      await tx.remove(main.def, id);
    });

    if (record) await runAfterHooks("afterDestroy", prefix, record);
    return record;
  };

  const removeLocale = async (id: string, locale: string) => {
    assertLocale(locale);

    await db().transaction(async (tx) => {
      const existing = await tx.find(translations.def, rowId(id, locale), {
        populate: [],
      });
      if (!existing) {
        throw new HttpError(404, `${config.name} has no "${locale}" version`);
      }
      const remaining = await tx.count(translations.def, [
        { field: "article_id", op: "$eq", value: id },
      ]);
      if (remaining <= 1) {
        throw new HttpError(
          409,
          `"${locale}" is the only language left — delete the record instead`,
        );
      }

      if (translations.publishedDef) {
        await tx.remove(translations.publishedDef, rowId(id, locale));
      }
      await tx.remove(translations.def, rowId(id, locale));
      await tx.update(main.def, id, { updatedAt: moment().toISOString() });
    });

    return (await showAll(id))!;
  };

  // ---- publishing, one language at a time ------------------------------------------------

  // The languages a draft action is about, among those the record has: the ones named, or all.
  // A language that is named but missing is a 404; so is a record with none.
  const languagesOf = async (
    tx: DbOperations,
    id: string,
    option: DraftOptions["locale"],
  ) => {
    if (!(await tx.find(main.def, id, { populate: [] }))) {
      throw new HttpError(404, `${config.name} not found`);
    }

    const explicit = option !== undefined;
    const wanted = explicit ? [option].flat() : [...settings().locales];

    const present: string[] = [];
    for (const locale of wanted) {
      assertLocale(locale);
      const row = await tx.find(translations.def, rowId(id, locale), {
        populate: [],
      });
      if (row) present.push(locale);
      else if (explicit) {
        throw new HttpError(404, `${config.name} has no "${locale}" version`);
      }
    }
    if (present.length === 0) {
      throw new HttpError(404, `${config.name} has no language to act on`);
    }
    return { present, explicit };
  };

  // The shared columns of the languages that stay live are brought level with the shared table
  // (they are one value for the record), and a language that only differed in those is no
  // longer "changed".
  const syncLiveLanguages = async (
    tx: DbOperations,
    id: string,
    skip: readonly string[],
  ) => {
    const mainRow = (await tx.find(main.def, id, { populate: [] }))!;
    const sharedValues = pick(mainRow, sharedList);

    for (const locale of settings().locales) {
      if (skip.includes(locale)) continue;
      const rid = rowId(id, locale);

      const live = await tx.find(translations.publishedDef!, rid, {
        populate: [],
      });
      if (!live) continue;

      const refreshed = (await tx.update(
        translations.publishedDef!,
        rid,
        sharedValues,
      ))!;
      const working = await tx.find(translations.def, rid, { populate: [] });
      if (working?.status === "changed" && sameContent(working, refreshed)) {
        await tx.update(translations.def, rid, { status: "published" });
      }
    }
  };

  const publish = async (id: string, options: DraftOptions = {}) => {
    const now = moment().toISOString();

    await db().transaction(async (tx) => {
      const { present } = await languagesOf(tx, id, options.locale);
      for (const locale of present) {
        await translations.publishIn!(tx, rowId(id, locale), now);
      }
      await syncLiveLanguages(tx, id, present);
    });

    const record = (await showAll(id))!;
    await runAfterHooks("afterPublish", prefix, record);
    return record;
  };

  const unpublish = async (id: string, options: DraftOptions = {}) => {
    await db().transaction(async (tx) => {
      const { present } = await languagesOf(tx, id, options.locale);
      for (const locale of present) {
        await translations.unpublishIn!(tx, rowId(id, locale));
      }
    });

    const record = (await showAll(id))!;
    await runAfterHooks("afterUnpublish", prefix, record);
    return record;
  };

  const discard = async (id: string, options: DraftOptions = {}) => {
    await db().transaction(async (tx) => {
      const { present, explicit } = await languagesOf(tx, id, options.locale);

      let restored = 0;
      for (const locale of present) {
        const rid = rowId(id, locale);
        const live = await tx.find(translations.publishedDef!, rid, {
          populate: [],
        });
        if (!live) {
          if (explicit) {
            throw new HttpError(
              409,
              `${config.name} is not published in "${locale}", nothing to discard`,
            );
          }
          continue;
        }

        const back: Rec = {};
        for (const name of localizedList) back[name] = live[name] ?? null;
        const working = (await tx.update(translations.def, rid, {
          ...back,
          publishedAt: live.publishedAt ?? null,
        }))!;
        await tx.update(translations.def, rid, {
          status: sameContent(working, live) ? "published" : "changed",
        });
        restored += 1;
      }

      if (restored === 0) {
        throw new HttpError(
          409,
          `${config.name} is not published, nothing to discard`,
        );
      }
    });

    return (await showAll(id))!;
  };

  const draftApi: I18nDraftApi | undefined = draftable
    ? {
        published: {
          read: (options) => {
            const { locale, fallback, ...rest } = options;
            if (!isOneLocale(locale)) {
              throw new Error(
                "published.read() needs a locale — what is live is read one language at a time.",
              );
            }
            return readLocale(locale, rest, fallback !== false, true);
          },
          show: (id, options) =>
            showLocale(id, options.locale, options.fallback !== false, true),
        },
        publishedDef: translations.publishedDef!,
        publish,
        unpublish,
        discard,
        backfillPublished: () => translations.backfillPublished!(),
      }
    : undefined;

  return {
    name: config.name,
    prefix,
    def: main.def,
    i18nDef: translations.def,
    validation,
    searchFields: config.searchFields,
    create,
    update,
    destroy,
    read,
    show,
    removeLocale,
    assertUnique: main.assertUnique,
    ...draftApi,
  };
};
