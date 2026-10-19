import moment from "moment";
import { z } from "zod";
import db from "../../modules/db";
import type {
  Condition,
  DbOperations,
  FieldDef,
  ListQuery,
  SearchTarget,
  TableDef,
} from "../db/contract";
import { fieldsFromSchema } from "../db/table_def";
import { HttpError } from "../http_error";
import { UniqueConstraintError } from "./errors";
import { runAfterHooks, runBeforeDestroyHooks, runBeforeHooks } from "./hooks";
import { type I18nDraftApi, type I18nModel, makeI18nModel } from "./i18n";
import {
  hasLocalizedSource,
  isOneLocale,
  linksOf,
  localizeLinks,
  TRANSLATION_KEY,
  TRANSLATION_LOCALE,
  translationTableName,
} from "./localized";

// Input shape of create()/update(): the schema's own data, with relation fields given as plain
// id strings.
type Values<T> = T;

export type FormMeta = {
  label: string;
  unique?: boolean;
  hideForm?: boolean;
  // On a model made with `i18n: true`: keep one value of this field per locale (see
  // config.i18n) instead of one for the whole record.
  localized?: boolean;
};

export { UniqueConstraintError } from "./errors";

export type ReadMeta = {
  total: number;
  page: number;
  limit: number;
  pageCount: number;
};

type FilterScalar = string | number | boolean;

export type FilterValue =
  | FilterScalar
  | Partial<Record<FilterOperator, FilterScalar>>
  | null
  | undefined;

// Query-string shape for `filters[field]=v` / `filters[field][$op]=v`. Deliberately z.string()
// and not z.coerce.string(): coercion would turn an operator object into "[object Object]".
export const filtersQuerySchema = z.record(
  z.string(),
  z.union([z.string(), z.record(z.string(), z.string())]),
);

// Anything that isn't a plain positive integer is replaced with the fallback.
const toPositiveInt = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

const unwrapSchema = (schema: z.ZodType): z.ZodType => {
  let current = schema as any;
  while (current?.def?.innerType && !current.meta()?.renderAs) {
    current = current.def.innerType;
  }
  return current;
};

export type FilterOperator =
  | "$eq"
  | "$ne"
  | "$gt"
  | "$gte"
  | "$lt"
  | "$lte"
  | "$contains"
  | "$startsWith"
  | "$in";

export type ReadOptions = {
  search?: string;
  page?: number;
  limit?: number;
  sort?: string;
  order?: "asc" | "desc";
  populate?: string[] | "none";
  // Fields to return (`id` is always included). A relation's own fields can be picked with
  // "relation.field" (one level). Unknown names are dropped; if none are valid the full
  // record is returned.
  select?: readonly string[];
  filters?: Record<string, FilterValue>;
  // A relation takes on the language of the model it points at. Where that model has i18n, a
  // populated related record is its record in this language — the default language's when it
  // has none, unless `fallback` is false — and in the default language when no locale is given.
  // A relation to a model without i18n is the same in every language. Nothing else is affected.
  locale?: string;
  fallback?: boolean;
};

// A record narrowed to the selected fields. `select` typed as a plain string[] (e.g. coming from
// a query string) can't be narrowed at compile time, so it falls back to the full record type.
type Selected<T, S> = S extends readonly (infer K)[]
  ? string extends K
    ? T
    : Pick<T, Extract<RelationRoot<K> | "id", keyof T>>
  : T;

// "author.name" narrows the record's `author` property (its inner shape isn't tracked).
type RelationRoot<K> = K extends `${infer Root}.${string}` ? Root : K;

// On top of the schema whitelist, field names must be plain identifiers.
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Present on every record but not part of the user-defined schema shape.
const RECORD_META_FIELDS = ["id", "createdAt", "updatedAt"];

// What a draftable model adds to every record, on top of RECORD_META_FIELDS. "draft": never
// published (or unpublished since); "published": the working copy equals the published one;
// "changed": published, but the working copy has edits that are not live yet.
export type DraftStatus = "draft" | "published" | "changed";
export type DraftMeta = { status: DraftStatus; publishedAt: string | null };

const DRAFT_META_FIELDS = ["status", "publishedAt"];

const DRAFT_FIELDS: FieldDef[] = [
  {
    kind: "scalar",
    name: "status",
    type: "string",
    options: ["draft", "published", "changed"],
  },
  { kind: "scalar", name: "publishedAt", type: "datetime" },
];

// Physical table holding the published copies of a draftable model. The leading underscore
// keeps it clear of any model prefix and of the `<table>__<field>` child tables of arrays.
// What modules (API, MCP, db sync) need from a draftable model without knowing its row type.
// On an i18n model a draft action can name the language(s) it applies to (all of them when it
// does not); a model without i18n ignores it.
export type DraftOptions = { locale?: string | readonly string[] };

export type DraftActions = {
  publishedDef: TableDef;
  publish(id: string, options?: DraftOptions): Promise<unknown>;
  unpublish(id: string, options?: DraftOptions): Promise<unknown>;
  discard(id: string, options?: DraftOptions): Promise<unknown>;
  backfillPublished(): Promise<number>;
};

export const isDraftable = <M extends object>(
  model: M,
): model is M & DraftActions => "publishedDef" in model;

export const isI18n = <M extends object>(model: M): model is M & I18nModel =>
  "i18nDef" in model;

export const publishedTableName = (prefix: string) => `_published_${prefix}`;

// Whitelist of operators — unknown operators are silently dropped, never passed on.
const OPERATORS = new Set<FilterOperator>([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$contains",
  "$startsWith",
  "$in",
]);

// Query strings only carry text, but the database compares strictly by type — so numeric and
// boolean fields need their filter value converted. Returns undefined when it can't be
// converted, and the caller drops that condition instead of matching nothing by accident.
const coerceFilterValue = (
  renderAs: string | undefined,
  value: FilterScalar,
): FilterScalar | undefined => {
  if (typeof value !== "string") return value;

  if (renderAs === "numeric") {
    const n = value.trim() === "" ? Number.NaN : Number(value);
    return Number.isNaN(n) ? undefined : n;
  }

  if (renderAs === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  }

  return value;
};

const RELATION_RENDER_AS = ["relation", "multi_relation", "file", "multi_file"];

// Every makeModel() call registers its own schema here before returning — since
// relation()/relationMany() require the actual built target Model as an argument,
// the target's makeModel() is guaranteed to have already run (and registered itself)
// by the time a field referencing it via relation() can even be constructed. Used
// only for the opportunistic target-field check in resolveSearchPlan below.
const schemaRegistry = new Map<string, z.ZodObject>();

// A model whose table holds only part of its fields (an i18n model keeps its localized fields
// in a second table) registers the full schema here, so searchFields of other models can still
// reach every field.
export const registerSchema = (prefix: string, schema: z.ZodObject) => {
  schemaRegistry.set(prefix, schema);
};

// The fields of an i18n model that live in its translation table. A relation from another model
// reaches the shared table only, so searching or projecting through it cannot see these.
const localizedFieldRegistry = new Map<string, ReadonlySet<string>>();

export const registerLocalizedFields = (
  prefix: string,
  fields: ReadonlySet<string>,
) => {
  localizedFieldRegistry.set(prefix, fields);
};

export type ResolvedSearchField =
  | { kind: "flat"; field: string }
  | {
      kind: "nested";
      local: string;
      targetPrefix: string;
      targetField: string;
      multi: boolean;
      // The field is localized on an i18n target: its text is in the target's translation table.
      translated: boolean;
    };

// Parses searchFields entries into flat field names and single-hop nested
// "relationField.targetField" references, validating relation-family fields and
// (when the target model has already registered itself) the target field's existence
// synchronously — so a bad reference throws at model-definition time, not per-request.
export const resolveSearchPlan = (
  schema: z.ZodObject,
  searchFields: string[],
  modelName: string,
): ResolvedSearchField[] => {
  return searchFields.map((raw): ResolvedSearchField => {
    const dot = raw.indexOf(".");
    if (dot === -1) return { kind: "flat", field: raw };

    if (raw.indexOf(".", dot + 1) !== -1) {
      throw new Error(
        `Model "${modelName}": searchFields entry "${raw}" has more than one level of nesting — only a single relation hop is supported.`,
      );
    }

    const local = raw.slice(0, dot);
    const targetField = raw.slice(dot + 1);
    const meta = (schema.shape[local] as z.ZodType | undefined)?.meta() as any;

    if (!meta || !RELATION_RENDER_AS.includes(meta.renderAs)) {
      throw new Error(
        `Model "${modelName}": searchFields entry "${raw}" references "${local}", which is not a relation/file field on this model's schema.`,
      );
    }

    const targetPrefix = meta.model as string;
    const targetSchema = schemaRegistry.get(targetPrefix);
    if (targetSchema && !(targetField in targetSchema.shape)) {
      throw new Error(
        `Model "${modelName}": searchFields entry "${raw}" references field "${targetField}", which does not exist on model "${targetPrefix}".`,
      );
    }

    return {
      kind: "nested",
      translated:
        localizedFieldRegistry.get(targetPrefix)?.has(targetField) === true,
      local,
      targetPrefix,
      targetField,
      multi:
        meta.renderAs === "multi_relation" || meta.renderAs === "multi_file",
    };
  });
};

export const makeModel = <
  Rules extends z.ZodObject,
  const Draftable extends boolean = false,
  const I18n extends boolean = false,
>(
  prefix: string,
  config: {
    schema: Rules;
    name: string;
    searchFields: string[];
    // Adds a status ("draft" | "published" | "changed") and publishedAt to every record, and a
    // second table of published copies. Edits go to the working copy (what read()/show() see);
    // publish() copies it to the published table, which is what `model.published.read()` reads
    // — so editing a published record never takes it offline.
    draftable?: Draftable;
    // Keeps the fields marked `localized: true` once per locale (config.i18n) in a second table,
    // `<prefix>__i18n`. Arrays and objects holding arrays are always per locale. Read a language
    // with `read({ locale })`; `read()` returns every language of each record.
    i18n?: I18n;
    // Internal (used by i18n models for their translation table): false skips the unique checks
    // and indexes, because there a field is unique per locale, not per table.
    enforceUnique?: boolean;
  },
) => {
  type Data = z.infer<Rules>;
  type Returning = Data & {
    id: string;
    createdAt: string;
    updatedAt: string;
  } & (Draftable extends true ? DraftMeta : unknown);

  const draftable = config.draftable === true;

  if (config.i18n === true) {
    return makeI18nModel(prefix, config, {
      makeModel,
      registerSchema,
      registerLocalizedFields,
    }) as unknown as Model;
  }

  if (draftable) {
    for (const name of DRAFT_META_FIELDS) {
      if (name in config.schema.shape) {
        throw new Error(
          `Model "${config.name}": field "${name}" is reserved on a draftable model.`,
        );
      }
    }
  }

  schemaRegistry.set(prefix, config.schema);

  const relationFields = Object.entries(config.schema.shape)
    .filter(([, v]) => {
      const m = (v as z.ZodType).meta() as any;
      return RELATION_RENDER_AS.includes(m?.renderAs);
    })
    .map(([k]) => k);

  const relationFieldSet = new Set(relationFields);

  // The relations that may point at an i18n model.
  const links = linksOf(config.schema);

  const searchPlan = resolveSearchPlan(
    config.schema,
    config.searchFields,
    config.name,
  );

  // What the db adapter works from. A nested searchFields entry ("author.name") is indexed on
  // the *target* table/field — the local relation field holds a link, not text.
  const searchTargets: SearchTarget[] = searchPlan.map((entry) =>
    entry.kind === "flat"
      ? { table: prefix, field: entry.field }
      : entry.translated
        ? {
            table: translationTableName(entry.targetPrefix),
            field: entry.targetField,
            via: entry.local,
            perLanguage: { key: TRANSLATION_KEY, locale: TRANSLATION_LOCALE },
          }
        : {
            table: entry.targetPrefix,
            field: entry.targetField,
            via: entry.local,
          },
  );

  const def: TableDef = {
    name: prefix,
    fields: [
      ...fieldsFromSchema(config.schema, {
        unique: config.enforceUnique !== false,
      }),
      ...(draftable ? DRAFT_FIELDS : []),
    ],
    search: searchTargets,
  };

  // The published copies: same fields, but never `unique` — uniqueness is enforced on the
  // working copy, and the published table lags behind it, so a slug swapped between two
  // records would otherwise collide while the second one is still being published.
  const publishedName = publishedTableName(prefix);
  const publishedDef: TableDef | undefined = draftable
    ? {
        name: publishedName,
        fields: def.fields.map((field) => {
          if (field.kind !== "scalar" || !field.unique) return field;
          const { unique: _unique, ...rest } = field;
          return rest;
        }),
        search: searchTargets.map((target) =>
          target.via ? target : { ...target, table: publishedName },
        ),
      }
    : undefined;

  const uniqueFields =
    config.enforceUnique === false
      ? []
      : Object.entries(config.schema.shape)
          .filter(([, v]) => (v as z.ZodType).meta()?.unique === true)
          .map(([k]) => k);

  const uniqueFieldSet = new Set(uniqueFields);

  // A real Set, not `key in config.schema.shape` — `in` also matches inherited
  // Object.prototype members (e.g. "constructor", "toString"), and JSON.parse can
  // produce those as literal own-properties on a request body/query object, letting
  // them slip past a schema-shape membership check and get passed on as a field name.
  const filterableFieldSet = new Set([
    ...Object.keys(config.schema.shape),
    ...(draftable ? DRAFT_META_FIELDS : []),
  ]);

  // status/publishedAt of a draftable model are not in the schema, so they have no renderAs.
  const renderAsOf = (field: string) => {
    const fieldSchema = config.schema.shape[field] as z.ZodType | undefined;
    if (!fieldSchema) return undefined;
    return (unwrapSchema(fieldSchema).meta() as any)?.renderAs as
      | string
      | undefined;
  };

  // field must be a known unique field — prevents arbitrary field injection
  const isDuplicate = async (
    field: string,
    value: unknown,
    excludeId?: string,
  ) => {
    if (!uniqueFieldSet.has(field)) return false;

    const where: Condition[] = [
      { field, op: "$eq", value: value as FilterScalar },
    ];
    if (excludeId) where.push({ field: "id", op: "$ne", value: excludeId });

    return (await db().count(def, where)) > 0;
  };

  const assertUnique = async (
    data: Record<string, unknown>,
    excludeId?: string,
  ) => {
    for (const field of uniqueFields) {
      const value = data[field];
      if (value === undefined) continue; // partial update without this field — nothing to check

      if (await isDuplicate(field, value, excludeId)) {
        throw new UniqueConstraintError(field, value);
      }
    }
  };

  const create = async (data: Values<Data>) => {
    const merged = (await runBeforeHooks(
      "beforeCreate",
      prefix,
      data as Record<string, unknown>,
      {},
    )) as Values<Data>;

    await assertUnique(merged);

    const record = (await db().insert(def, {
      ...merged,
      ...(draftable ? { status: "draft", publishedAt: null } : {}),
      createdAt: moment().toISOString(),
      updatedAt: moment().toISOString(),
    })) as unknown as Returning;

    await runAfterHooks("afterCreate", prefix, record);

    return record;
  };

  // Same reasoning as filterableFieldSet: a real Set of own keys, never `in`. id/createdAt/
  // updatedAt aren't in the user-defined schema shape but exist on every record.
  const selectableFieldSet = new Set([
    ...filterableFieldSet,
    ...RECORD_META_FIELDS,
  ]);

  // id/createdAt/updatedAt are always present on every record but aren't part of the
  // user-defined schema shape (they're injected in create()/update()) — allow sorting by them too.
  const sortableFields = new Set([
    ...Object.keys(config.schema.shape),
    ...RECORD_META_FIELDS,
    ...(draftable ? DRAFT_META_FIELDS : []),
  ]);

  // `table` is the working table or, for a draftable model's `.published` view, the published
  // one — both have the same fields, so the whitelists above apply to either.
  const readOn = async <
    const S extends readonly string[] | undefined = undefined,
  >(
    table: TableDef,
    {
      search,
      page = 1,
      limit,
      sort,
      order = "asc",
      populate,
      select,
      filters,
      locale,
      fallback,
    }: Omit<ReadOptions, "select"> & { select?: S } = {},
  ) => {
    const pageLimit = toPositiveInt(limit, 20);
    page = toPositiveInt(page, 1);
    const where: Condition[] = [];

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        // key must exist in schema — prevents arbitrary field injection
        if (!filterableFieldSet.has(key)) continue;

        // An absent value (e.g. `filters: { status: query.status }` with no ?status) means
        // "don't filter on this", not "match nothing" and not a crash.
        if (value === undefined || value === null) continue;

        const renderAs = renderAsOf(key);

        if (typeof value !== "object") {
          // Shorthand: filters[field]=value → equality
          const coerced = coerceFilterValue(renderAs, value);
          if (coerced === undefined) continue;
          where.push({ field: key, op: "$eq", value: coerced });
        } else {
          // Operator form: filters[field][$op]=value
          for (const [op, opValue] of Object.entries(value) as [
            FilterOperator,
            FilterScalar | undefined | null,
          ][]) {
            // strict whitelist — unknown ops are dropped
            if (!OPERATORS.has(op) || opValue === undefined || opValue === null)
              continue;

            if (op === "$contains" || op === "$startsWith") {
              where.push({ field: key, op, value: String(opValue) });
            } else if (op === "$in") {
              where.push({ field: key, op, value: opValue });
            } else {
              const coerced = coerceFilterValue(renderAs, opValue);
              if (coerced === undefined) continue;
              where.push({ field: key, op, value: coerced });
            }
          }
        }
      }
    }

    // Validate select against the schema — prevents arbitrary field injection. Anything that
    // isn't a known field (or isn't a plain identifier) is dropped, and an empty result means
    // "not specified" so the full record is returned rather than an id-only one.
    //
    // "relation.field" picks fields of the linked record instead of the whole thing; both halves
    // are checked (the relation against this schema, the field against the target model's
    // registered schema). A relation that has any "relation.field" entry uses that projection
    // even when it is also selected whole.
    const flatSelected = new Set<string>();
    const nestedSelected = new Map<string, Set<string>>();
    // Relations to an i18n model: the database only has the shared row of the related record, so
    // its fields are picked here, once it is in the language being read.
    const projectedHere = new Map<string, Set<string>>();
    if (Array.isArray(select)) {
      for (const raw of select as readonly unknown[]) {
        if (typeof raw !== "string") continue;
        const parts = raw.split(".");
        if (parts.length > 2 || !parts.every((p) => SAFE_IDENTIFIER.test(p)))
          continue;

        if (parts.length === 1) {
          if (selectableFieldSet.has(raw)) flatSelected.add(raw);
          continue;
        }

        const [local, targetField] = parts as [string, string];
        if (!relationFieldSet.has(local)) continue;
        const targetPrefix = (config.schema.shape[local] as z.ZodType).meta()
          ?.model as string | undefined;
        const targetSchema = targetPrefix
          ? schemaRegistry.get(targetPrefix)
          : undefined;
        if (
          !targetSchema ||
          !(
            Object.keys(targetSchema.shape).includes(targetField) ||
            RECORD_META_FIELDS.includes(targetField)
          )
        )
          continue;

        if (hasLocalizedSource(targetPrefix!)) {
          const picked = projectedHere.get(local) ?? new Set<string>();
          picked.add(targetField);
          projectedHere.set(local, picked);
          continue;
        }

        const fields = nestedSelected.get(local) ?? new Set<string>();
        fields.add(targetField);
        nestedSelected.set(local, fields);
      }
    }
    for (const local of nestedSelected.keys()) flatSelected.delete(local);
    // selected whole (and populated) so there is a related record to cut down
    for (const local of projectedHere.keys()) flatSelected.add(local);

    const hasSelect = flatSelected.size > 0 || nestedSelected.size > 0;

    // Validate populate against known relation fields. With a select, only relations that
    // are returned whole are worth fetching.
    const populateFields = (
      populate === "none"
        ? []
        : populate
          ? populate.filter((f) => relationFieldSet.has(f))
          : relationFields
    ).filter(
      (f) => !nestedSelected.has(f) && (!hasSelect || flatSelected.has(f)),
    );
    for (const local of projectedHere.keys()) {
      if (!populateFields.includes(local)) populateFields.push(local);
    }

    const query: ListQuery = {
      where,
      search: search && table.search.length ? search : undefined,
      // A search through a relation into an i18n model's text is on this language only, or on
      // every language when none is being read.
      searchLocale: isOneLocale(locale) ? locale : undefined,
      sort:
        sort && sortableFields.has(sort)
          ? { field: sort, order: order === "desc" ? "desc" : "asc" }
          : undefined,
      page,
      limit: pageLimit,
      select: hasSelect
        ? {
            fields: [...flatSelected],
            nested: Object.fromEntries(
              [...nestedSelected].map(([local, fields]) => [
                local,
                [...fields],
              ]),
            ),
          }
        : undefined,
      populate: populateFields,
    };

    const { rows, total } = await db().list(table, query);
    await localizeLinks(
      rows,
      links.filter((link) => populateFields.includes(link.name)),
      locale,
      fallback !== false,
    );

    // `select: ["category.name"]` through a relation to an i18n model: now that the related record
    // is the one in the language being read, keep only the fields asked for.
    for (const [local, fields] of projectedHere) {
      const cut = (record: unknown) =>
        record !== null && typeof record === "object" && !Array.isArray(record)
          ? {
              id: (record as { id: unknown }).id,
              ...Object.fromEntries(
                [...fields]
                  .filter((name) => name in (record as object))
                  .map((name) => [
                    name,
                    (record as Record<string, unknown>)[name],
                  ]),
              ),
            }
          : record;
      for (const row of rows) {
        const value = row[local];
        row[local] = Array.isArray(value) ? value.map(cut) : cut(value);
      }
    }

    return {
      data: rows as unknown as Selected<Returning, S>[],
      meta: {
        total,
        page,
        limit: pageLimit,
        pageCount: Math.ceil(total / pageLimit),
      } satisfies ReadMeta,
    };
  };

  const read = <const S extends readonly string[] | undefined = undefined>(
    options: Omit<ReadOptions, "select"> & { select?: S } = {},
  ) => readOn(def, options);

  const showOn = async (
    table: TableDef,
    id: string,
    options: { locale?: string; fallback?: boolean } = {},
  ) => {
    const record = await db().find(table, id, { populate: relationFields });
    if (record) {
      await localizeLinks(
        [record],
        links,
        options.locale,
        options.fallback !== false,
      );
    }
    return (record ?? undefined) as unknown as Returning;
  };

  const show = (
    id: string,
    options?: { locale?: string; fallback?: boolean },
  ) => showOn(def, id, options);

  const update = async (id: string, data: Values<Partial<Data>>) => {
    const merged = (await runBeforeHooks(
      "beforeUpdate",
      prefix,
      data as Record<string, unknown>,
      {
        id,
      },
    )) as Values<Partial<Data>>;

    await assertUnique(merged, id);

    const patch = { ...merged, updatedAt: moment().toISOString() };

    // Editing a published record leaves the published copy alone; the working copy just
    // stops matching it. Reading the status and writing it back is one transaction, so a
    // publish in between cannot be overwritten with a stale "changed".
    const record = (await (draftable
      ? db().transaction(async (tx) => {
          const current = await tx.find(def, id, { populate: [] });
          return tx.update(def, id, {
            ...patch,
            ...((current?.status as DraftStatus | undefined) === "published"
              ? { status: "changed" }
              : {}),
          });
        })
      : db().update(def, id, patch))) as unknown as Returning;

    await runAfterHooks("afterUpdate", prefix, record);

    return record;
  };

  const destroy = async (id: string) => {
    await runBeforeDestroyHooks(prefix, id);

    // A deleted record must not stay live through its published copy, and a failure between
    // the two deletes must not leave one without the other.
    const record = (await (publishedDef
      ? db().transaction(async (tx) => {
          await tx.remove(publishedDef, id);
          return tx.remove(def, id);
        })
      : db().remove(def, id))) as unknown as Returning;

    await runAfterHooks("afterDestroy", prefix, record);

    return record;
  };

  // --- draftable models --------------------------------------------------------------

  // Each of publish / unpublish / discard changes two tables, so it runs as one transaction
  // (a failure leaves both as they were); hooks run after it has committed.
  const workingOrThrow = async (tx: DbOperations, id: string) => {
    const row = await tx.find(def, id, { populate: [] });
    if (!row) throw new HttpError(404, `${config.name} not found`);
    return row;
  };

  // Copies the working copy to the published table (replacing whatever was there, array
  // fields included) and marks the working copy "published". Takes the transaction to run in,
  // so a caller can publish several records — or do more — as one unit.
  const publishIn = async (
    tx: DbOperations,
    id: string,
    now = moment().toISOString(),
  ) => {
    if (!publishedDef) throw new Error(`Model "${prefix}" is not draftable.`);

    const { id: _id, ...fields } = await workingOrThrow(tx, id);

    await tx.upsert(publishedDef, id, {
      ...fields,
      status: "published",
      publishedAt: now,
    });
    return (await tx.update(def, id, {
      status: "published",
      publishedAt: now,
    })) as unknown as Returning;
  };

  const publishRecord = async (id: string, runHooks: boolean) => {
    if (!publishedDef) throw new Error(`Model "${prefix}" is not draftable.`);

    const record = await db().transaction((tx) => publishIn(tx, id));

    if (runHooks) await runAfterHooks("afterPublish", prefix, record);

    return record;
  };

  const publish = (id: string) => publishRecord(id, true);

  // Takes the record offline. The working copy is kept, as a draft.
  const unpublishIn = async (tx: DbOperations, id: string) => {
    if (!publishedDef) throw new Error(`Model "${prefix}" is not draftable.`);

    await workingOrThrow(tx, id);
    await tx.remove(publishedDef, id);
    return (await tx.update(def, id, {
      status: "draft",
      publishedAt: null,
    })) as unknown as Returning;
  };

  const unpublish = async (id: string) => {
    if (!publishedDef) throw new Error(`Model "${prefix}" is not draftable.`);

    const record = await db().transaction((tx) => unpublishIn(tx, id));

    await runAfterHooks("afterUnpublish", prefix, record);

    return record;
  };

  // Throws the unpublished edits away: the working copy goes back to what is published.
  const discard = async (id: string) => {
    if (!publishedDef) throw new Error(`Model "${prefix}" is not draftable.`);

    return (await db().transaction(async (tx) => {
      await workingOrThrow(tx, id);
      const live = await tx.find(publishedDef, id, { populate: [] });
      if (!live) {
        throw new HttpError(
          409,
          `${config.name} is not published, nothing to discard`,
        );
      }

      const restored: Record<string, unknown> = {};
      for (const key of Object.keys(config.schema.shape)) {
        restored[key] = live[key] ?? null;
      }

      return tx.update(def, id, {
        ...restored,
        status: "published",
        publishedAt: live.publishedAt ?? null,
      });
    })) as unknown as Returning;
  };

  // Turning `draftable` on for a model that already has records: those predate drafts, so they
  // are live content. Anything without a status is copied to the published table and marked
  // published. Cheap when there is nothing to do — it only scans while the published table is
  // empty. Returns how many records it published.
  const backfillPublished = async () => {
    if (!publishedDef) return 0;
    if ((await db().count(publishedDef)) > 0) return 0;

    let done = 0;
    const size = 100;
    for (let page = 1; ; page += 1) {
      const { rows, total } = await db().list(def, {
        page,
        limit: size,
        sort: { field: "id", order: "asc" },
        populate: [],
      });

      for (const row of rows) {
        if (row.status) continue;
        await publishRecord(row.id, false);
        done += 1;
      }

      if (page * size >= total) break;
    }

    return done;
  };

  // Declared with method syntax so create()/update() stay bivariant in their data argument: a
  // model with a narrow schema must remain assignable to the generic
  // `ReturnType<typeof makeModel>` that relation()/file() and the registry take.
  type BaseModel = {
    name: string;
    prefix: string;
    create(data: Values<Data>): Promise<Returning>;
    update(id: string, data: Values<Partial<Data>>): Promise<Returning>;
    def: TableDef;
    destroy: typeof destroy;
    read: typeof read;
    searchFields: string[];
    show: typeof show;
    validation: Rules;
    // Throws UniqueConstraintError when a unique field's value is taken by another record.
    assertUnique: typeof assertUnique;
  };

  // Only on models made with `draftable: true`.
  type DraftApi = {
    // The live copies: `article.published.read()` / `.show(id)`.
    published: { read: typeof read; show: typeof show };
    publishedDef: TableDef;
    publish(id: string): Promise<Returning>;
    unpublish(id: string): Promise<Returning>;
    discard(id: string): Promise<Returning>;
    // The same inside a transaction the caller opened (no hooks).
    publishIn(tx: DbOperations, id: string, now?: string): Promise<Returning>;
    unpublishIn(tx: DbOperations, id: string): Promise<Returning>;
    backfillPublished(): Promise<number>;
  };

  type Model = I18n extends true
    ? I18nModel & (Draftable extends true ? I18nDraftApi : unknown)
    : BaseModel & (Draftable extends true ? DraftApi : unknown);

  const model: BaseModel = {
    name: config.name,
    prefix,
    create,
    def,
    destroy,
    read,
    searchFields: config.searchFields,
    show,
    update,
    validation: config.schema,
    assertUnique,
  };

  if (publishedDef) {
    const draftApi: DraftApi = {
      published: {
        read: (options) => readOn(publishedDef, options),
        show: (id, options) => showOn(publishedDef, id, options),
      },
      publishedDef,
      publish,
      unpublish,
      discard,
      publishIn,
      unpublishIn,
      backfillPublished,
    };
    Object.assign(model, draftApi);
  }

  return model as Model;
};

export * from "../event";
export * from "../helper";
export * from "../mcp_tool";
export * from "../plugin";
export * from "../route";
export * from "../vars";
export * from "./data_type";
export * from "./hooks";
