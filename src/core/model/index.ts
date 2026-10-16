import moment from "moment";
import { z } from "zod";
import db from "../../modules/db";
import type {
  Condition,
  ListQuery,
  SearchTarget,
  TableDef,
} from "../db/contract";
import { fieldsFromSchema } from "../db/table_def";
import { runAfterHooks, runBeforeDestroyHooks, runBeforeHooks } from "./hooks";

// Input shape of create()/update(): the schema's own data, with relation fields given as plain
// id strings.
type Values<T> = T;

export type FormMeta = {
  label: string;
  unique?: boolean;
  hideForm?: boolean;
};

export class UniqueConstraintError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
  ) {
    super(`Field "${field}" must be unique — value already exists`);
  }
}

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

export type ResolvedSearchField =
  | { kind: "flat"; field: string }
  | {
      kind: "nested";
      local: string;
      targetPrefix: string;
      targetField: string;
      multi: boolean;
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
      local,
      targetPrefix,
      targetField,
      multi:
        meta.renderAs === "multi_relation" || meta.renderAs === "multi_file",
    };
  });
};

export const makeModel = <Rules extends z.ZodObject>(
  prefix: string,
  config: {
    schema: Rules;
    name: string;
    searchFields: string[];
  },
) => {
  type Data = z.infer<Rules>;
  type Returning = Data & {
    id: string;
    createdAt: string;
    updatedAt: string;
  };

  schemaRegistry.set(prefix, config.schema);

  const relationFields = Object.entries(config.schema.shape)
    .filter(([, v]) => {
      const m = (v as z.ZodType).meta() as any;
      return RELATION_RENDER_AS.includes(m?.renderAs);
    })
    .map(([k]) => k);

  const relationFieldSet = new Set(relationFields);

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
      : {
          table: entry.targetPrefix,
          field: entry.targetField,
          via: entry.local,
        },
  );

  const def: TableDef = {
    name: prefix,
    fields: fieldsFromSchema(config.schema),
    search: searchTargets,
  };

  const uniqueFields = Object.entries(config.schema.shape)
    .filter(([, v]) => (v as z.ZodType).meta()?.unique === true)
    .map(([k]) => k);

  const uniqueFieldSet = new Set(uniqueFields);

  // A real Set, not `key in config.schema.shape` — `in` also matches inherited
  // Object.prototype members (e.g. "constructor", "toString"), and JSON.parse can
  // produce those as literal own-properties on a request body/query object, letting
  // them slip past a schema-shape membership check and get passed on as a field name.
  const filterableFieldSet = new Set(Object.keys(config.schema.shape));

  const renderAsOf = (field: string) =>
    (unwrapSchema(config.schema.shape[field] as z.ZodType).meta() as any)
      ?.renderAs as string | undefined;

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
  ]);

  const read = async <
    const S extends readonly string[] | undefined = undefined,
  >({
    search,
    page = 1,
    limit,
    sort,
    order = "asc",
    populate,
    select,
    filters,
  }: Omit<ReadOptions, "select"> & { select?: S } = {}) => {
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

        const fields = nestedSelected.get(local) ?? new Set<string>();
        fields.add(targetField);
        nestedSelected.set(local, fields);
      }
    }
    for (const local of nestedSelected.keys()) flatSelected.delete(local);

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

    const query: ListQuery = {
      where,
      search: search && searchTargets.length ? search : undefined,
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

    const { rows, total } = await db().list(def, query);

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

  const show = async (id: string) => {
    const record = await db().find(def, id, { populate: relationFields });
    return (record ?? undefined) as unknown as Returning;
  };

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

    const record = (await db().update(def, id, {
      ...merged,
      updatedAt: moment().toISOString(),
    })) as unknown as Returning;

    await runAfterHooks("afterUpdate", prefix, record);

    return record;
  };

  const destroy = async (id: string) => {
    await runBeforeDestroyHooks(prefix, id);

    const record = (await db().remove(def, id)) as unknown as Returning;

    await runAfterHooks("afterDestroy", prefix, record);

    return record;
  };

  // Declared with method syntax so create()/update() stay bivariant in their data argument: a
  // model with a narrow schema must remain assignable to the generic
  // `ReturnType<typeof makeModel>` that relation()/file() and the registry take.
  type Model = {
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
  };

  const model: Model = {
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
  };

  return model;
};

export * from "../event";
export * from "../helper";
export * from "../mcp_tool";
export * from "../plugin";
export * from "../route";
export * from "../vars";
export * from "./data_type";
export * from "./hooks";
