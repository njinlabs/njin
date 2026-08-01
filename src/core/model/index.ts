import surreal from "../../modules/surreal";
import moment from "moment";
import { RecordId, Table, type Values } from "surrealdb";
import { z } from "zod";
import { runAfterHooks, runBeforeDestroyHooks, runBeforeHooks } from "./hooks";

export type FormMeta = {
  label: string;
  unique?: boolean;
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

  const relationFields = Object.entries(config.schema.shape)
    .filter(([, v]) => {
      const m = (v as z.ZodType).meta() as any;
      return ["relation", "multi_relation", "file", "multi_file"].includes(m?.renderAs);
    })
    .map(([k]) => k);

  const relationFieldSet = new Set(relationFields);

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

    if (search && config.searchFields.length) {
      params.search = search.toLowerCase();
      whereParts.push(
        `(${config.searchFields.map((f) => `string::similarity::jaro_winkler(string::lowercase(${f}), $search) > 0.4`).join(" OR ")})`,
      );
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
    const orderBy = sort && sortableFields.has(sort) ? `ORDER BY ${sort} ${order === "desc" ? "DESC" : "ASC"}` : "";

    // Validate populate against known relation fields — prevents FETCH injection
    const fetchFields =
      populate === "none"
        ? []
        : populate
          ? populate.filter((f) => relationFieldSet.has(f))
          : relationFields;
    const fetch = fetchFields.length ? `FETCH ${fetchFields.join(", ")}` : "";
    const start = (page - 1) * pageLimit;

    const [data, [countRow]] = await surreal().query<[Returning[], { count: number }[]]>(
      `SELECT * FROM ${prefix} ${where} ${orderBy} LIMIT ${pageLimit} START ${start} ${fetch};
       SELECT count() as count FROM ${prefix} ${where} GROUP ALL`,
      params,
    );

    const total = countRow?.count ?? 0;

    return {
      data: data ?? [],
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
