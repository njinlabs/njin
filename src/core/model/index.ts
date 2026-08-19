import surreal from "../../modules/surreal";
import moment from "moment";
import { RecordId, Table, type Values } from "surrealdb";
import { z } from "zod";
import { runAfterHooks, runBeforeDestroyHooks, runBeforeHooks } from "./hooks";

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

export type FilterValue = string | Partial<Record<FilterOperator, string>>;

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
  filters?: Record<string, FilterValue>;
};


// Whitelist of operators — unknown operators are silently dropped, never interpolated.
const OPERATORS: Record<FilterOperator, (field: string, param: string) => string> = {
  $eq:         (f, p) => `${f} = $${p}`,
  $ne:         (f, p) => `${f} != $${p}`,
  $gt:         (f, p) => `${f} > $${p}`,
  $gte:        (f, p) => `${f} >= $${p}`,
  $lt:         (f, p) => `${f} < $${p}`,
  $lte:        (f, p) => `${f} <= $${p}`,
  $contains:   (f, p) => `string::contains(string::lowercase(${f}), $${p})`,
  $startsWith: (f, p) => `string::starts_with(string::lowercase(${f}), $${p})`,
  $in:         (f, p) => `${f} CONTAINS $${p}`,
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
  | { kind: "nested"; local: string; targetPrefix: string; targetField: string; multi: boolean };

// Parses searchFields entries into flat field names and single-hop nested
// "relationField.targetField" references, validating relation-family fields and
// (when the target model has already registered itself) the target field's existence
// synchronously — so a bad reference throws at model-definition time, not per-request.
export const resolveSearchPlan = (schema: z.ZodObject, searchFields: string[], modelName: string): ResolvedSearchField[] => {
  return searchFields.map((raw): ResolvedSearchField => {
    const dot = raw.indexOf(".");
    if (dot === -1) return { kind: "flat", field: raw };

    if (raw.indexOf(".", dot + 1) !== -1) {
      throw new Error(`Model "${modelName}": searchFields entry "${raw}" has more than one level of nesting — only a single relation hop is supported.`);
    }

    const local = raw.slice(0, dot);
    const targetField = raw.slice(dot + 1);
    const meta = (schema.shape[local] as z.ZodType | undefined)?.meta() as any;

    if (!meta || !RELATION_RENDER_AS.includes(meta.renderAs)) {
      throw new Error(`Model "${modelName}": searchFields entry "${raw}" references "${local}", which is not a relation/file field on this model's schema.`);
    }

    const targetPrefix = meta.model as string;
    const targetSchema = schemaRegistry.get(targetPrefix);
    if (targetSchema && !(targetField in targetSchema.shape)) {
      throw new Error(`Model "${modelName}": searchFields entry "${raw}" references field "${targetField}", which does not exist on model "${targetPrefix}".`);
    }

    return {
      kind: "nested",
      local,
      targetPrefix,
      targetField,
      multi: meta.renderAs === "multi_relation" || meta.renderAs === "multi_file",
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
    id: RecordId;
    createdAt: string;
    updatedAt: string;
  };

  const table = new Table(prefix);

  schemaRegistry.set(prefix, config.schema);

  const relationFields = Object.entries(config.schema.shape)
    .filter(([, v]) => {
      const m = (v as z.ZodType).meta() as any;
      return RELATION_RENDER_AS.includes(m?.renderAs);
    })
    .map(([k]) => k);

  const relationFieldSet = new Set(relationFields);

  const searchPlan = resolveSearchPlan(config.schema, config.searchFields, config.name);

  const uniqueFields = Object.entries(config.schema.shape)
    .filter(([, v]) => (v as z.ZodType).meta()?.unique === true)
    .map(([k]) => k);

  const uniqueFieldSet = new Set(uniqueFields);

  // A real Set, not `key in config.schema.shape` — `in` also matches inherited
  // Object.prototype members (e.g. "constructor", "toString"), and JSON.parse can
  // produce those as literal own-properties on a request body/query object, letting
  // them slip past a schema-shape membership check and get interpolated as a field
  // name into the raw query string built below.
  const filterableFieldSet = new Set(Object.keys(config.schema.shape));

  // field must be a known unique field — prevents arbitrary field injection
  const isDuplicate = async (field: string, value: unknown, excludeId?: string) => {
    if (!uniqueFieldSet.has(field)) return false;

    const excludeClause = excludeId ? "AND id != $excludeId" : "";
    const [[row]] = await surreal().query<[{ count: number }[]]>(
      `SELECT count() AS count FROM ${prefix} WHERE ${field} = $value ${excludeClause} GROUP ALL`,
      { value, excludeId: excludeId ? new RecordId(table, excludeId) : undefined },
    );

    return (row?.count ?? 0) > 0;
  };

  const assertUnique = async (data: Record<string, unknown>, excludeId?: string) => {
    for (const field of uniqueFields) {
      const value = data[field];
      if (value === undefined) continue; // partial update without this field — nothing to check

      if (await isDuplicate(field, value, excludeId)) {
        throw new UniqueConstraintError(field, value);
      }
    }
  };

  const create = async (data: Values<Data>) => {
    const merged = (await runBeforeHooks("beforeCreate", prefix, data as Record<string, unknown>, {})) as Values<Data>;

    await assertUnique(merged);

    const record = (await surreal()
      .create<Data>(table)
      .content({ ...merged, createdAt: moment().toISOString(), updatedAt: moment().toISOString() })
      .output("after")
      .then(([data]) => data)) as Returning;

    await runAfterHooks("afterCreate", prefix, record);

    return record;
  };

  const read = async ({
    search,
    page = 1,
    limit: pageLimit = 20,
    sort,
    order = "asc",
    populate,
    filters,
  }: ReadOptions = {}) => {
    const whereParts: string[] = [];
    const params: Record<string, unknown> = {};

    // Uses SurrealDB's full-text SEARCH index (see SEARCH_ANALYZER in ../../modules/surreal),
    // not string::similarity::jaro_winkler — jaro_winkler compares two strings as a whole, so
    // a short search term against a long field (e.g. "next.js" inside a full title) scores far
    // below any usable threshold even though the term is clearly present. The @N@ match
    // operator + ngram analyzer gives real substring/partial-word matching, BM25 relevance
    // ranking, and still tolerates minor typos via shared n-grams.
    //
    // A nested entry (searchPlan `kind: "nested"`, e.g. "author.name") becomes an IN/CONTAINSANY
    // subquery against the target table instead — the local relation field holds a record link,
    // not text, so it can't carry its own full-text index. All entries (flat and nested alike)
    // share one running @N@ counter in declaration order, since SurrealDB's match-ref scoping
    // across a WHERE-clause subquery on a different table isn't something to assume either way.
    if (search && searchPlan.length) {
      params.search = search.trim();
      const clauses = searchPlan.map((entry, i) => {
        const n = i + 1;
        if (entry.kind === "flat") return `${entry.field} @${n}@ $search`;
        const op = entry.multi ? "CONTAINSANY" : "IN";
        return `${entry.local} ${op} (SELECT VALUE id FROM ${entry.targetPrefix} WHERE ${entry.targetField} @${n}@ $search)`;
      });
      whereParts.push(`(${clauses.join(" OR ")})`);
    }

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        // key must exist in schema — prevents arbitrary field injection
        if (!filterableFieldSet.has(key)) continue;

        if (typeof value === "string") {
          // Shorthand: filters[field]=value → equality
          params[`f_${key}`] = value;
          whereParts.push(`${key} = $f_${key}`);
        } else {
          // Operator form: filters[field][$op]=value
          for (const [op, opValue] of Object.entries(value) as [FilterOperator, string][]) {
            const builder = OPERATORS[op]; // strict whitelist — unknown ops get undefined
            if (!builder || opValue === undefined) continue;

            const pk = `f_${key}_${op.slice(1)}`; // e.g. f_title_contains
            params[pk] =
              op === "$contains" || op === "$startsWith"
                ? opValue.toLowerCase() // match the lowercased field
                : opValue;
            whereParts.push(builder(key, pk));
          }
        }
      }
    }

    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    // id/createdAt/updatedAt are always present on every record but aren't part of the
    // user-defined schema shape (they're injected in create()/update()) — allow sorting by them too.
    const sortableFields = new Set([...Object.keys(config.schema.shape), "id", "createdAt", "updatedAt"]);
    const hasExplicitSort = Boolean(sort && sortableFields.has(sort));
    // An explicit sort always wins; otherwise, when searching, rank by BM25 relevance
    // (summed across every matched flat search field) instead of leaving result order
    // unspecified. Nested (relation) entries are excluded from this sum — a match found via
    // the IN/CONTAINSANY subquery above has no per-record score in this query's context, since
    // it happened on a different table entirely. If a model's searchFields are all nested,
    // there's no score to rank by, so relevance ordering is skipped (same as no searchFields).
    // `ORDER BY` only accepts a bare identifier here, not a function call — so relevance is
    // projected as an aliased field below (SELECT ... AS __relevance) and stripped back out
    // of each returned record afterwards, since it isn't part of the model's schema.
    const useRelevance = !hasExplicitSort && Boolean(search && searchPlan.some((e) => e.kind === "flat"));
    const orderBy = hasExplicitSort
      ? `ORDER BY ${sort} ${order === "desc" ? "DESC" : "ASC"}`
      : useRelevance
        ? "ORDER BY __relevance DESC"
        : "";
    const relevanceSelect = useRelevance
      ? `, (${searchPlan
          .map((e, i) => (e.kind === "flat" ? `search::score(${i + 1})` : null))
          .filter((s): s is string => s !== null)
          .join(" + ")}) AS __relevance`
      : "";

    // Validate populate against known relation fields — prevents FETCH injection
    const fetchFields =
      populate === "none"
        ? []
        : populate
          ? populate.filter((f) => relationFieldSet.has(f))
          : relationFields;
    const fetch = fetchFields.length ? `FETCH ${fetchFields.join(", ")}` : "";
    const start = (page - 1) * pageLimit;

    const [rows, [countRow]] = await surreal().query<[(Returning & { __relevance?: number })[], { count: number }[]]>(
      `SELECT *${relevanceSelect} FROM ${prefix} ${where} ${orderBy} LIMIT ${pageLimit} START ${start} ${fetch};
       SELECT count() as count FROM ${prefix} ${where} GROUP ALL`,
      params,
    );

    const data = (rows ?? []).map((row) => {
      if (!useRelevance) return row;
      const { __relevance, ...rest } = row;
      return rest as Returning;
    });

    const total = countRow?.count ?? 0;

    return {
      data,
      meta: {
        total,
        page,
        limit: pageLimit,
        pageCount: Math.ceil(total / pageLimit),
      } satisfies ReadMeta,
    };
  };

  const show = (id: string) => {
    let q = surreal().select<Data>(new RecordId(table, id));
    if (relationFields.length) q = q.fetch(...(relationFields as [string, ...string[]])) as typeof q;
    return q as unknown as Promise<Returning>;
  };

  const update = async (id: string, data: Values<Partial<Data>>) => {
    const merged = (await runBeforeHooks("beforeUpdate", prefix, data as Record<string, unknown>, {
      id,
    })) as Values<Partial<Data>>;

    await assertUnique(merged, id);

    const record = (await (surreal()
      .update<Data>(new RecordId(table, id))
      .merge({
        ...merged,
        updatedAt: moment().toISOString(),
      }) as unknown as Promise<Returning>)) as Returning;

    await runAfterHooks("afterUpdate", prefix, record);

    return record;
  };

  const destroy = async (id: string) => {
    await runBeforeDestroyHooks(prefix, id);

    const record = (await (surreal().delete<Data>(new RecordId(table, id)) as unknown as Promise<Returning>)) as Returning;

    await runAfterHooks("afterDestroy", prefix, record);

    return record;
  };

  return {
    name: config.name,
    prefix,
    create,
    destroy,
    read,
    searchFields: config.searchFields,
    show,
    table,
    update,
    validation: config.schema,
  };
};

export * from "./data_type";
export * from "./hooks";
export * from "../event";
export * from "../helper";
export * from "../plugin";
export * from "../route";
export * from "../vars";
