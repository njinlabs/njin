import moment from "moment";
import { z } from "zod";
import db from "../../modules/db";
import type { DbOperations } from "../db/contract";
import { varsPublishedTable, varsTable } from "../db/internal";
import { fieldMeta, fieldsFromSchema } from "../db/table_def";
import { HttpError } from "../http_error";
import { runAfterHooks, runBeforeHooks } from "../model/hooks";
import type { DraftOptions } from "../model/index";
import {
  assertLocale,
  isOneLocale,
  localeMapSchema,
  settings,
  stable,
} from "../model/localized";

// One shared physical table for every VARS group — rows are keyed by each
// group's own prefix as the record id, not one table per group (see varsTable).
//
// A group made with `i18n: true` keeps its `localized` fields once per language, as a
// `{ locale: value }` map inside that same document: a group is only ever read and written as a
// whole, so there is nothing to filter or sort on and no table of translations is needed. A map
// is always written out in full — databases do not agree on how a partial nested object merges.
//
// A group made with `draftable: true` has a second document, in `vars_published`: the live copy.
// get() is the working copy (what the admin panel edits); `published.get()` is what is live.
// Status is worked out by comparing the two, so there is nothing to keep in step.
type Values<T> = T;
type Rec = Record<string, any>;

export type VarsStatus = "draft" | "published" | "changed";

export type VarsGetOptions = {
  // i18n groups: a locale code for one language as flat fields, or "all" / nothing for every
  // language ({ locale: value } for a localized field).
  locale?: string;
  // With a locale: a value the language has none of takes the default language's. Defaults to true.
  fallback?: boolean;
};

const hasValue = (value: unknown) =>
  !(value === null || value === undefined || value === "") &&
  stable(value) !== null;

// What the document holds for a localized field in one language, if anything.
const storedIn = (
  doc: Rec | null | undefined,
  name: string,
  locale: string,
) => {
  const map = doc?.[name];
  return map && typeof map === "object" ? map[locale] : undefined;
};

// What the API and MCP need from a draftable group without knowing its field types.
export type VarsDraftActions = {
  published: { get(options?: VarsGetOptions): Promise<unknown> };
  publish(options?: DraftOptions): Promise<unknown>;
  unpublish(options?: DraftOptions): Promise<unknown>;
  discard(options?: DraftOptions): Promise<unknown>;
  backfillPublished(): Promise<number>;
};

export const isDraftableVars = <G extends object>(
  group: G,
): group is G & VarsDraftActions =>
  "publish" in group && "published" in group && "discard" in group;

export const isI18nVars = (group: object) =>
  (group as { i18n?: unknown }).i18n === true;

export const makeVars = <
  Rules extends z.ZodObject,
  const I18n extends boolean = false,
  const Draftable extends boolean = false,
>(
  prefix: string,
  config: {
    schema: Rules;
    name: string;
    // Keep the fields marked `localized: true` once per language (config.i18n).
    i18n?: I18n;
    // Keep a live copy apart from the working copy; see `publish()`.
    draftable?: Draftable;
  },
) => {
  type Data = z.infer<Rules>;
  type Base = I18n extends true ? Rec : Data;
  type Returning = Base & { updatedAt: string | null } & (Draftable extends true
      ? {
          status: VarsStatus | Record<string, VarsStatus>;
          publishedAt: string | null | Record<string, string | null>;
        }
      : unknown);

  const i18n = config.i18n === true;
  const draftable = config.draftable === true;
  const shape = config.schema.shape as Record<string, z.ZodType>;
  const where = `Vars group "${config.name}"`;

  if (draftable) {
    for (const reserved of ["status", "publishedAt"]) {
      if (reserved in shape) {
        throw new Error(
          `${where}: field "${reserved}" is reserved on a draftable group.`,
        );
      }
    }
  }

  // ---- which fields are per language -------------------------------------------------

  const localized = new Set<string>();
  for (const field of fieldsFromSchema(config.schema)) {
    if (fieldMeta(shape[field.name]!).localized !== true) continue;

    if (!i18n) {
      throw new Error(
        `${where}: "${field.name}" is \`localized\`, so the group needs \`i18n: true\`.`,
      );
    }
    // A relation takes on the language of the model it points at; a file can differ per language.
    const renderAs = fieldMeta(shape[field.name]!).renderAs;
    if (renderAs === "relation" || renderAs === "multi_relation") {
      throw new Error(
        `${where}: "${field.name}" is a relation, which takes on the language of the model it points at, so it cannot be localized itself; leave it shared.`,
      );
    }
    localized.add(field.name);
  }
  if (i18n && localized.size === 0) {
    throw new Error(
      `${where}: i18n: true needs at least one field with \`localized: true\`.`,
    );
  }

  const localizedList = [...localized];
  const sharedList = Object.keys(shape).filter((name) => !localized.has(name));
  const sharedSchema = z.object(
    Object.fromEntries(sharedList.map((name) => [name, shape[name]!])),
  );

  // Localized fields are `{ locale: value }` maps in what the API and agents are given.
  const validation = (
    i18n
      ? z.object(
          Object.fromEntries(
            Object.keys(shape).map((name) => [
              name,
              localized.has(name)
                ? localeMapSchema(shape[name]!)
                : shape[name]!,
            ]),
          ),
        )
      : config.schema
  ) as Rules;

  // ---- reading a document ---------------------------------------------------------------

  const withoutMeta = (doc: Rec | null | undefined): Rec => {
    const { id: _id, updatedAt: _u, publishedAt: _p, ...rest } = doc ?? {};
    return rest;
  };

  // The value of a localized field in one language, its own default filled in.
  const valueIn = (
    doc: Rec | null | undefined,
    name: string,
    locale: string,
  ) => {
    const stored = storedIn(doc, name, locale);
    return shape[name]!.parse(stored === null ? undefined : stored);
  };

  // A document as the group's values. Without a locale every localized field is a map with
  // every configured language in it; with one, flat — and a language without a value of its own
  // borrows the default language's, when `fallback` allows.
  const valuesOf = (
    doc: Rec | null | undefined,
    options: VarsGetOptions = {},
  ): Rec => {
    if (!i18n) return config.schema.parse(withoutMeta(doc)) as Rec;

    const values: Rec = sharedSchema.parse(withoutMeta(doc));
    const { locales, defaultLocale } = settings();

    if (!isOneLocale(options.locale)) {
      for (const name of localizedList) {
        values[name] = Object.fromEntries(
          locales.map((locale) => [locale, valueIn(doc, name, locale)]),
        );
      }
      return values;
    }

    assertLocale(options.locale);
    for (const name of localizedList) {
      const own = storedIn(doc, name, options.locale);
      const borrow =
        options.fallback !== false &&
        options.locale !== defaultLocale &&
        !hasValue(own) &&
        hasValue(storedIn(doc, name, defaultLocale));
      values[name] = valueIn(
        doc,
        name,
        borrow ? defaultLocale : options.locale,
      );
    }
    return values;
  };

  // The languages a document is live in (i18n), keyed by when they went live.
  const liveWhen = (published: Rec | null): Record<string, string> => {
    const map = published?.publishedAt;
    if (!map || typeof map !== "object") return {};
    return Object.fromEntries(
      Object.entries(map).filter(([, at]) => typeof at === "string"),
    ) as Record<string, string>;
  };

  // Whether a language (or, without i18n, the group) is live and still equal to the working copy.
  const sameAsLive = (
    working: Rec | null,
    published: Rec | null,
    locale?: string,
  ) => {
    const flat = (doc: Rec | null) =>
      stable(valuesOf(doc, locale ? { locale, fallback: false } : {}));
    return JSON.stringify(flat(working)) === JSON.stringify(flat(published));
  };

  const draftMeta = (working: Rec | null, published: Rec | null) => {
    if (!i18n) {
      const at = published?.publishedAt;
      const live = typeof at === "string";
      return {
        status: !live
          ? "draft"
          : sameAsLive(working, published)
            ? "published"
            : "changed",
        publishedAt: live ? at : null,
      };
    }

    const when = liveWhen(published);
    const status: Record<string, VarsStatus> = {};
    const publishedAt: Record<string, string | null> = {};
    for (const locale of settings().locales) {
      const live = locale in when;
      status[locale] = !live
        ? "draft"
        : sameAsLive(working, published, locale)
          ? "published"
          : "changed";
      publishedAt[locale] = when[locale] ?? null;
    }
    return { status, publishedAt };
  };

  const read = async (x: DbOperations = db()) => {
    const working = (await x.find(varsTable, prefix)) as Rec | null;
    const published = draftable
      ? ((await x.find(varsPublishedTable, prefix)) as Rec | null)
      : null;
    return { working, published };
  };

  // Every field's value, ready to be written (a value that is not there is written as null, so
  // a database that merges documents does not keep the old one).
  const writable = (values: Rec) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, value ?? null]),
    );

  // schema.parse() fills in every field's .default() for anything missing —
  // including the row never having been saved at all — so get() always
  // returns a complete, valid object. Every VARS field is expected to
  // declare a .default(...) for this reason.
  const get = async (options: VarsGetOptions = {}): Promise<Returning> => {
    const { working, published } = await read();

    return {
      ...valuesOf(working, options),
      updatedAt: working?.updatedAt ?? null,
      ...(draftable ? draftMeta(working, published) : {}),
    } as Returning;
  };

  // ---- writing --------------------------------------------------------------------------

  // { tagline: { en: "x" }, phone: "1" } -> the shared part, and per localized field the
  // languages given.
  const split = (input: Rec) => {
    const sharedPart: Rec = {};
    const byField: Record<string, Rec> = {};

    for (const [key, value] of Object.entries(input)) {
      if (!localized.has(key)) {
        sharedPart[key] = value;
        continue;
      }
      if (value === undefined) continue;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError(
          422,
          `"${key}" is per language: give it as an object keyed by locale, e.g. { "${settings().defaultLocale}": ... }`,
        );
      }
      for (const locale of Object.keys(value)) assertLocale(locale);
      byField[key] = value as Rec;
    }
    return { sharedPart, byField };
  };

  // Upsert, not update — the row may not exist yet on first save.
  const update = async (
    data: I18n extends true ? Rec : Values<Partial<Data>>,
  ): Promise<Returning> => {
    const merged = (await runBeforeHooks(
      "beforeVarsUpdate",
      prefix,
      data as Record<string, unknown>,
      {},
    )) as Rec;

    await db().transaction(async (tx) => {
      const patch: Rec = {};
      if (!i18n) {
        Object.assign(patch, merged);
      } else {
        const current = (await tx.find(varsTable, prefix)) as Rec | null;
        const { sharedPart, byField } = split(merged);
        Object.assign(patch, sharedPart);
        for (const [name, incoming] of Object.entries(byField)) {
          // the whole map, current languages included
          const existing = current?.[name];
          patch[name] = {
            ...(existing && typeof existing === "object" ? existing : {}),
            ...incoming,
          };
        }
      }

      await tx.upsert(varsTable, prefix, {
        ...patch,
        updatedAt: moment().toISOString(),
      });
    });

    const result = await get();
    await runAfterHooks("afterVarsUpdate", prefix, result);

    return result;
  };

  // ---- publishing -----------------------------------------------------------------------

  // The languages a draft action is about: the ones named, or all of them.
  const chosen = (option: DraftOptions["locale"]) => {
    const locales =
      option === undefined ? [...settings().locales] : [option].flat();
    for (const locale of locales) assertLocale(locale);
    return locales;
  };

  const publish = async (options: DraftOptions = {}): Promise<Returning> => {
    const now = moment().toISOString();

    await db().transaction(async (tx) => {
      const { working, published } = await read(tx);

      if (!i18n) {
        await tx.upsert(varsPublishedTable, prefix, {
          ...writable(valuesOf(working)),
          publishedAt: now,
        });
        return;
      }

      const targets = chosen(options.locale);
      const doc: Rec = writable(sharedSchema.parse(withoutMeta(working)));
      for (const name of localizedList) {
        const map: Rec = { ...(published?.[name] ?? {}) };
        for (const locale of targets)
          map[locale] = storedIn(working, name, locale) ?? null;
        doc[name] = map;
      }
      doc.publishedAt = {
        ...liveWhen(published),
        ...Object.fromEntries(targets.map((locale) => [locale, now])),
      };
      await tx.upsert(varsPublishedTable, prefix, doc);
    });

    const result = await get();
    await runAfterHooks("afterVarsPublish", prefix, result);
    return result;
  };

  const unpublish = async (options: DraftOptions = {}): Promise<Returning> => {
    await db().transaction(async (tx) => {
      const { published } = await read(tx);
      if (!published) return;

      if (!i18n) {
        await tx.remove(varsPublishedTable, prefix);
        return;
      }

      const targets = chosen(options.locale);
      const when = liveWhen(published);
      for (const locale of targets) delete when[locale];

      // Nothing live in any language: the document goes.
      if (Object.keys(when).length === 0) {
        await tx.remove(varsPublishedTable, prefix);
        return;
      }

      const doc: Rec = {};
      for (const name of localizedList) {
        const map: Rec = { ...(published[name] ?? {}) };
        for (const locale of targets) map[locale] = null;
        doc[name] = map;
      }
      doc.publishedAt = {
        ...Object.fromEntries(targets.map((locale) => [locale, null])),
        ...when,
      };
      await tx.upsert(varsPublishedTable, prefix, doc);
    });

    const result = await get();
    await runAfterHooks("afterVarsUnpublish", prefix, result);
    return result;
  };

  // Throws the unpublished edits away: the working copy goes back to what is live. On an i18n
  // group only the localized fields of the languages named come back — what is shared by every
  // language is not touched.
  const discard = async (options: DraftOptions = {}): Promise<Returning> => {
    await db().transaction(async (tx) => {
      const { working, published } = await read(tx);
      const now = moment().toISOString();

      if (!i18n) {
        if (typeof published?.publishedAt !== "string") {
          throw new HttpError(
            409,
            `${config.name} is not published, nothing to discard`,
          );
        }
        await tx.upsert(varsTable, prefix, {
          ...writable(valuesOf(published)),
          updatedAt: now,
        });
        return;
      }

      const when = liveWhen(published);
      const targets = chosen(options.locale);
      const live = targets.filter((locale) => locale in when);
      if (options.locale !== undefined && live.length < targets.length) {
        const missing = targets.find((locale) => !(locale in when));
        throw new HttpError(
          409,
          `${config.name} is not published in "${missing}", nothing to discard`,
        );
      }
      if (live.length === 0) {
        throw new HttpError(
          409,
          `${config.name} is not published, nothing to discard`,
        );
      }

      const doc: Rec = {};
      for (const name of localizedList) {
        const map: Rec = { ...(working?.[name] ?? {}) };
        for (const locale of live)
          map[locale] = storedIn(published, name, locale) ?? null;
        doc[name] = map;
      }
      await tx.upsert(varsTable, prefix, { ...doc, updatedAt: now });
    });

    return get();
  };

  // Turning `draftable` on for a group that already has saved values: those are live content.
  // The values are copied to the live document once, if there is none yet. Returns whether it did.
  const backfillPublished = async () => {
    if (!draftable) return 0;

    const { working, published } = await read();
    if (!working || published) return 0;

    const now = moment().toISOString();
    await db().transaction(async (tx) => {
      if (!i18n) {
        await tx.upsert(varsPublishedTable, prefix, {
          ...writable(valuesOf(working)),
          publishedAt: now,
        });
        return;
      }
      const doc: Rec = writable(sharedSchema.parse(withoutMeta(working)));
      for (const name of localizedList) {
        doc[name] = Object.fromEntries(
          settings().locales.map((locale) => [
            locale,
            storedIn(working, name, locale) ?? null,
          ]),
        );
      }
      doc.publishedAt = Object.fromEntries(
        settings().locales.map((locale) => [locale, now]),
      );
      await tx.upsert(varsPublishedTable, prefix, doc);
    });
    return 1;
  };

  const group = {
    name: config.name,
    prefix,
    i18n,
    draftable,
    validation,
    get,
    update,
  };

  type DraftApi = {
    // What is live: `site.published.get({ locale })`.
    published: {
      get(options?: VarsGetOptions): Promise<Rec>;
    };
    publish(options?: DraftOptions): Promise<Returning>;
    unpublish(options?: DraftOptions): Promise<Returning>;
    discard(options?: DraftOptions): Promise<Returning>;
    backfillPublished(): Promise<number>;
  };

  if (!draftable)
    return group as typeof group &
      (Draftable extends true ? DraftApi : unknown);

  const draftApi: DraftApi = {
    published: {
      get: async (options = {}) => {
        const { published } = await read();
        const at = published?.publishedAt;
        return {
          ...valuesOf(published, options),
          publishedAt: i18n
            ? Object.fromEntries(
                settings().locales.map((locale) => [
                  locale,
                  liveWhen(published)[locale] ?? null,
                ]),
              )
            : typeof at === "string"
              ? at
              : null,
        };
      },
    },
    publish,
    unpublish,
    discard,
    backfillPublished,
  };

  return Object.assign(group, draftApi) as unknown as typeof group &
    (Draftable extends true ? DraftApi : unknown);
};
