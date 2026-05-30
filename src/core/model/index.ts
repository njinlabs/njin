import surreal from "@njin/modules/surreal";
import moment from "moment";
import { RecordId, Table, type Values } from "surrealdb";
import { z } from "zod";

export type FormMeta = {
  label: string;
};

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

  const create = (data: Values<Data>) => {
    return surreal()
      .create<Data>(table)
      .content({ ...data, createdAt: moment().toISOString(), updatedAt: moment().toISOString() })
      .output("after")
      .then(([data]) => data) as Promise<Returning>;
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
        `(${config.searchFields.map((f) => `string::similarity::jaro_winkler(string::lowercase(${f}), $search) > 0.7`).join(" OR ")})`,
      );
    }

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        // key must exist in schema — prevents arbitrary field injection
        if (!(key in config.schema.shape)) continue;

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
    const orderBy = sort && sort in config.schema.shape ? `ORDER BY ${sort} ${order === "desc" ? "DESC" : "ASC"}` : "";

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
    return surreal()
      .update<Data>(new RecordId(table, id))
      .merge({
        ...data,
        updatedAt: moment().toISOString(),
      }) as unknown as Promise<Returning>;
  };

  const destroy = (id: string) => {
    return surreal().delete<Data>(new RecordId(table, id)) as unknown as Promise<Returning>;
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
