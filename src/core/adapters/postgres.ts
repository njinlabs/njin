import { createHash } from "node:crypto";
import type {
  AdapterCapabilities,
  Condition,
  CountBy,
  DbAdapter,
  ListQuery,
  ListResult,
  PartialRow,
  Row,
  ScalarType,
  TableDef,
} from "../db/contract";
import { run, type SQL, type SqlClient, sql } from "./sql/builder";
import { bunSqlClient } from "./sql/bun_client";
import {
  type ArrayPlan,
  type Column,
  descendantArrays,
  descendantPivots,
  foldEmptyObjects,
  lookup,
  type Pivot,
  physicalName,
  planTable,
  setPath,
  type TablePlan,
} from "./sql/plan";

// A PostgreSQL adapter on Bun's built-in SQL client (or any driver that can be wrapped as an
// SqlClient). The physical layout comes from ./sql/plan.ts and statements are composed with
// ./sql/builder.ts, whose only way to put text into SQL is a quoted identifier, a validated
// integer or an allow-listed keyword — every value is a bound parameter. Migrations are
// generated here and are additive only: nothing is ever dropped or retyped.
//
// Layout (see plan.ts): scalars are columns, an object() is flattened into columns, a relation
// is a text column holding the target id, a relationMany() is a pivot table and an array() is
// a child table. Datetimes are timestamptz columns that go in and out as ISO-8601 strings.

// What a failed statement surfaces as. A driver's error can carry details of the row that
// failed (a duplicate-key error quotes the value), and errors end up in logs and error
// trackers — so a driver error is replaced by one holding only its message, SQLSTATE code and
// constraint name.
export class DbError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly constraint?: string,
  ) {
    super(message);
    this.name = "DbError";
  }
}

type DriverError = Error & {
  errno?: unknown;
  code?: unknown;
  constraint?: unknown;
  severity?: unknown;
};

const isDriverError = (error: unknown): error is DriverError =>
  error instanceof Error &&
  !(error instanceof DbError) &&
  (typeof (error as DriverError).severity === "string" ||
    /^(Postgres|MySQL|SQLite)Error$/.test(error.name) ||
    error.constructor?.name === "DatabaseError");

const sqlState = (error: DriverError) => {
  for (const candidate of [error.errno, error.code]) {
    if (typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

const sanitize = (error: unknown): unknown =>
  isDriverError(error)
    ? new DbError(
        error.message,
        sqlState(error),
        typeof error.constraint === "string" ? error.constraint : undefined,
      )
    : error;

const guarded = (target: SqlClient): SqlClient => ({
  query: (text, params) =>
    target.query(text, params).catch((error) => {
      throw sanitize(error);
    }),
  transaction: (fn) =>
    target
      .transaction((tx) => fn(guarded(tx)))
      .catch((error) => {
        throw sanitize(error);
      }),
});

type Connection = {
  client: SqlClient;
  close?: () => Promise<void> | void;
};

export type PostgresAdapterConfig = {
  // A connection string; connects through Bun's built-in SQL client.
  url?: string;
  // Connection pool size for `url`.
  max?: number;
  // TLS for `url`: true, or Bun's TLS options. Use it for anything but a local database.
  tls?: boolean | Record<string, unknown>;
  // Bring your own driver, wrapped as an SqlClient, instead of `url`.
  connect?: () => Promise<Connection> | Connection;
  // Put every table in this schema instead of the connection's default one. It must exist.
  schema?: string;
};

type Record_ = Record<string, unknown>;

// Fuzzy matches below this trigram similarity are not results.
const SIMILARITY_THRESHOLD = 0.5;
// A field that truly contains the search string outranks one that only looks similar.
const CONTAINMENT_BOOST = 100;
const SCHEMA_META_TABLE = "njin_schema_meta";
// Bump to force every database to re-run its (idempotent) DDL on next boot.
const LAYOUT_VERSION = 1;
const INSERT_CHUNK = 200;

const SQL_TYPE: Record<ScalarType, string> = {
  string: "text",
  number: "double precision",
  boolean: "boolean",
  datetime: "timestamptz",
  json: "jsonb",
};

// What information_schema reports for each of the above.
const DATA_TYPE: Record<ScalarType, string> = {
  string: "text",
  number: "double precision",
  boolean: "boolean",
  datetime: "timestamp with time zone",
  json: "jsonb",
};

// Serialises schema changes across processes (njin runs several workers against one database).
const SCHEMA_LOCK = "njin:schema";

const STANDARD_DATETIMES = ["createdAt", "updatedAt"] as const;
const standardColumns: Column[] = STANDARD_DATETIMES.map((name) => ({
  name,
  type: "datetime",
  path: [name],
}));

const newId = () => Bun.randomUUIDv7();

const idList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

// ISO-8601 in UTC with milliseconds — the one shape every driver returns datetimes in.
const iso = (ref: SQL) =>
  sql`to_char(${ref} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const encode = (type: ScalarType, value: unknown): SQL => {
  if (value === null || value === undefined) return sql`NULL`;

  switch (type) {
    case "string":
      return sql`${typeof value === "string" ? value : String(value)}`;
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n))
        throw new Error(`Not a number: ${String(value)}`);
      return sql`${n}`;
    }
    case "boolean":
      return sql`${value === true || value === "true"}`;
    case "datetime": {
      const date = new Date(value as string);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`Not a valid datetime: ${String(value)}`);
      }
      return sql`${date.toISOString()}::text::timestamptz`;
    }
    case "json":
      // Sent as plain text and converted by the server: a parameter the server types as jsonb is
      // serialised again by some drivers (Bun's), turning the JSON into a quoted string.
      return sql`${JSON.stringify(value)}::text::jsonb`;
  }
};

const decode = (type: ScalarType, value: unknown) => {
  if (value === null || value === undefined) return null;
  if (type === "json")
    return typeof value === "string" ? JSON.parse(value) : value;
  if (type === "number")
    return typeof value === "string" ? Number(value) : value;
  return value;
};

const escapeLike = (value: string) => value.replace(/[!%_]/g, (m) => `!${m}`);

// "host:port/database" from a connection string, without its credentials.
const hostAndDatabase = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "postgres";
  }
};

export const postgresAdapter = (
  config: PostgresAdapterConfig = {},
): DbAdapter => {
  let db: SqlClient;
  let closer: Connection["close"];
  const plans = new Map<string, TablePlan>();
  let trigrams = false;

  const tableRef = (name: string) =>
    config.schema
      ? sql`${sql.identifier(config.schema)}.${sql.identifier(name)}`
      : sql.identifier(name);
  const col = (table: string, column: string) =>
    sql`${tableRef(table)}.${sql.identifier(column)}`;
  const alias = (name: string) => sql.identifier(name);

  const rowsOf = (x: SqlClient, query: SQL): Promise<Record_[]> =>
    run(x, query);

  const planOf = (table: TableDef) => plans.get(table.name) ?? planTable(table);

  const selectColumn = (table: string, column: Column) => {
    const ref = col(table, column.name);
    if (column.type === "datetime")
      return sql`${iso(ref)} as ${alias(column.name)}`;
    if (column.type === "json")
      return sql`${ref}::text as ${alias(column.name)}`;
    return sql`${ref} as ${alias(column.name)}`;
  };

  // ------------------------------------------------------------------------------------
  // Reading
  // ------------------------------------------------------------------------------------

  const loadPivot = async (x: SqlClient, pivot: Pivot, owners: string[]) => {
    const rows = await rowsOf(
      x,
      sql`select ${col(pivot.table, "_parent")} as "_parent", ${col(pivot.table, "target")} as "target" from ${tableRef(pivot.table)} where ${col(pivot.table, "_owner")} in (${idList(owners)}) order by ${col(pivot.table, "_pos")}`,
    );

    const byParent = new Map<string, string[]>();
    for (const row of rows) {
      const parent = String(row._parent);
      const list = byParent.get(parent) ?? [];
      list.push(String(row.target));
      byParent.set(parent, list);
    }
    return byParent;
  };

  // Every element of `array`, grouped by the id of the row that owns it, in order.
  const loadArray = async (
    x: SqlClient,
    array: ArrayPlan,
    owners: string[],
  ): Promise<Map<string, unknown[]>> => {
    const nested = new Map<ArrayPlan, Map<string, unknown[]>>();
    for (const child of array.arrays) {
      nested.set(child, await loadArray(x, child, owners));
    }
    const pivots = new Map<Pivot, Map<string, string[]>>();
    for (const pivot of array.pivots) {
      pivots.set(pivot, await loadPivot(x, pivot, owners));
    }

    const rows = await rowsOf(
      x,
      sql`select ${col(array.table, "_id")} as "_id", ${col(array.table, "_parent")} as "_parent"${
        array.columns.length
          ? sql`, ${sql.join(
              array.columns.map((c) => selectColumn(array.table, c)),
              sql`, `,
            )}`
          : sql``
      } from ${tableRef(array.table)} where ${col(array.table, "_owner")} in (${idList(owners)}) order by ${col(array.table, "_pos")}`,
    );

    const byParent = new Map<string, unknown[]>();
    for (const row of rows) {
      const elementId = String(row._id);
      let element: unknown;

      if (array.shape === "scalar") {
        const column = array.columns[0] as Column;
        element = decode(column.type, row[column.name]);
      } else if (array.shape === "array") {
        element =
          nested.get(array.arrays[0] as ArrayPlan)?.get(elementId) ?? [];
      } else {
        const object: Record_ = {};
        for (const column of array.columns) {
          setPath(object, column.path, decode(column.type, row[column.name]));
        }
        for (const child of array.arrays) {
          setPath(object, child.path, nested.get(child)?.get(elementId) ?? []);
        }
        for (const pivot of array.pivots) {
          setPath(object, pivot.path, pivots.get(pivot)?.get(elementId) ?? []);
        }
        foldEmptyObjects(array, object);
        element = object;
      }

      const parent = String(row._parent);
      const list = byParent.get(parent) ?? [];
      list.push(element);
      byParent.set(parent, list);
    }
    return byParent;
  };

  // `want` limits which top-level fields are loaded (children are separate queries, so
  // skipping them is a real saving); undefined loads everything.
  const loadRows = async (
    x: SqlClient,
    plan: TablePlan,
    ids: string[],
    want?: ReadonlySet<string>,
  ): Promise<Map<string, Row>> => {
    const out = new Map<string, Row>();
    if (!ids.length) return out;

    const wanted = (path: readonly string[]) =>
      !want || want.has(path[0] as string);
    const columns = plan.columns.filter((c) => wanted(c.path));

    const selected: SQL[] = [
      sql`${col(plan.name, "id")} as "id"`,
      ...standardColumns.map((c) => selectColumn(plan.name, c)),
      ...columns.map((c) => selectColumn(plan.name, c)),
    ];
    if (plan.document)
      selected.push(sql`${col(plan.name, "data")}::text as "data"`);

    const rows = await rowsOf(
      x,
      sql`select ${sql.join(selected, sql`, `)} from ${tableRef(plan.name)} where ${col(plan.name, "id")} in (${idList(ids)})`,
    );

    for (const raw of rows) {
      const row: Record_ = { id: String(raw.id) };
      for (const name of STANDARD_DATETIMES) {
        if (raw[name] !== null && raw[name] !== undefined)
          row[name] = raw[name];
      }
      if (plan.document && raw.data) {
        Object.assign(row, JSON.parse(String(raw.data)) as Record_);
      }
      for (const column of columns) {
        setPath(row, column.path, decode(column.type, raw[column.name]));
      }
      out.set(row.id as string, row as Row);
    }

    for (const array of plan.arrays) {
      if (!wanted(array.path)) continue;
      const byParent = await loadArray(x, array, ids);
      for (const [id, row] of out)
        setPath(row, array.path, byParent.get(id) ?? []);
    }
    for (const pivot of plan.pivots) {
      if (!wanted(pivot.path)) continue;
      const byParent = await loadPivot(x, pivot, ids);
      for (const [id, row] of out)
        setPath(row, pivot.path, byParent.get(id) ?? []);
    }

    for (const row of out.values()) {
      foldEmptyObjects(
        { objects: plan.objects.filter((path) => wanted(path)) },
        row,
      );
    }

    return out;
  };

  // Replaces link fields with the rows they point at. A link whose target is gone stays as its
  // bare id, which is how callers tell a resolved link from a dangling one.
  const populate = async (
    x: SqlClient,
    plan: TablePlan,
    rows: Record_[],
    fields: readonly string[],
    only?: readonly string[],
  ) => {
    for (const field of fields) {
      const link = plan.columns.find(
        (c) => c.link && c.path.length === 1 && c.path[0] === field,
      );
      const pivot = plan.pivots.find(
        (p) => p.path.length === 1 && p.path[0] === field,
      );
      const target = link?.link ?? pivot?.target;
      const targetPlan = target ? plans.get(target) : undefined;
      if (!targetPlan) continue;

      const wanted = new Set<string>();
      for (const row of rows) {
        const value = row[field];
        if (typeof value === "string") wanted.add(value);
        else if (Array.isArray(value)) {
          for (const v of value) if (typeof v === "string") wanted.add(v);
        }
      }
      if (!wanted.size) continue;

      const found = await loadRows(
        x,
        targetPlan,
        [...wanted],
        only ? new Set(only) : undefined,
      );

      const resolve = (value: unknown) => {
        if (typeof value !== "string") return value;
        const hit = found.get(value);
        if (!hit) return value;
        if (!only) return hit;
        const projected: Record_ = { id: hit.id };
        for (const key of only)
          if (key in hit) projected[key] = (hit as Record_)[key];
        return projected;
      };

      for (const row of rows) {
        const value = row[field];
        row[field] = Array.isArray(value) ? value.map(resolve) : resolve(value);
      }
    }
  };

  // ------------------------------------------------------------------------------------
  // Writing
  // ------------------------------------------------------------------------------------

  const insertRows = async (
    x: SqlClient,
    table: string,
    names: string[],
    rows: SQL[][],
  ) => {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      await run(
        x,
        sql`insert into ${tableRef(table)} (${sql.join(
          names.map((n) => sql.identifier(n)),
          sql`, `,
        )}) values ${sql.join(
          chunk.map((r) => sql`(${sql.join(r, sql`, `)})`),
          sql`, `,
        )}`,
      );
    }
  };

  const linkIds = (value: unknown, where: string): string[] => {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value))
      throw new Error(`Expected a list of ids for ${where}`);
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (
        item &&
        typeof item === "object" &&
        typeof (item as Record_).id === "string"
      ) {
        return (item as Record_).id as string;
      }
      throw new Error(`Expected an id for ${where}`);
    });
  };

  const insertPivot = async (
    x: SqlClient,
    pivot: Pivot,
    owner: string,
    parent: string,
    value: unknown,
  ) => {
    const targets = linkIds(value, pivot.path.join("."));
    await insertRows(
      x,
      pivot.table,
      ["_owner", "_parent", "_pos", "target"],
      targets.map((target, pos) => [
        sql`${owner}`,
        sql`${parent}`,
        sql`${pos}`,
        sql`${target}`,
      ]),
    );
  };

  const insertElements = async (
    x: SqlClient,
    array: ArrayPlan,
    owner: string,
    parent: string,
    value: unknown,
  ): Promise<void> => {
    if (value === null || value === undefined) return;
    if (!Array.isArray(value)) {
      throw new Error(
        `Expected an array for ${array.path.join(".") || "an array element"}`,
      );
    }
    if (!value.length) return;

    const ids = value.map(() => newId());
    const names = [
      "_id",
      "_owner",
      "_parent",
      "_pos",
      ...array.columns.map((c) => c.name),
    ];
    await insertRows(
      x,
      array.table,
      names,
      value.map((element, pos) => [
        sql`${ids[pos]}`,
        sql`${owner}`,
        sql`${parent}`,
        sql`${pos}`,
        ...array.columns.map((c) =>
          encode(
            c.type,
            array.shape === "scalar" ? element : lookup(element, c.path).value,
          ),
        ),
      ]),
    );

    for (let pos = 0; pos < value.length; pos += 1) {
      const element = value[pos];
      const elementId = ids[pos] as string;

      if (array.shape === "array") {
        await insertElements(
          x,
          array.arrays[0] as ArrayPlan,
          owner,
          elementId,
          element,
        );
        continue;
      }
      if (array.shape !== "object") continue;

      for (const child of array.arrays) {
        const { found, value: inner } = lookup(element, child.path);
        if (found) await insertElements(x, child, owner, elementId, inner);
      }
      for (const pivot of array.pivots) {
        const { found, value: inner } = lookup(element, pivot.path);
        if (found) await insertPivot(x, pivot, owner, elementId, inner);
      }
    }
  };

  // Removes everything below one array (its table and every table nested in it) for a root row.
  const deleteArraySubtree = async (
    x: SqlClient,
    array: ArrayPlan,
    owner: string,
  ) => {
    for (const table of [
      array.table,
      ...descendantArrays(array).map((a) => a.table),
      ...descendantPivots(array).map((p) => p.table),
    ]) {
      await run(
        x,
        sql`delete from ${tableRef(table)} where ${col(table, "_owner")} = ${owner}`,
      );
    }
  };

  // Writes the arrays and relation lists of a root row that the caller supplied. On an update,
  // a supplied array replaces the stored one as a whole.
  const writeChildren = async (
    x: SqlClient,
    plan: TablePlan,
    id: string,
    data: Record_,
    replacing: boolean,
  ) => {
    for (const array of plan.arrays) {
      const { found, value } = lookup(data, array.path);
      if (!found) continue;
      if (replacing) await deleteArraySubtree(x, array, id);
      await insertElements(x, array, id, id, value);
    }
    for (const pivot of plan.pivots) {
      const { found, value } = lookup(data, pivot.path);
      if (!found) continue;
      if (replacing) {
        await run(
          x,
          sql`delete from ${tableRef(pivot.table)} where ${col(pivot.table, "_owner")} = ${id}`,
        );
      }
      await insertPivot(x, pivot, id, id, value);
    }
  };

  // The keys of `data` a document table keeps in its JSON column.
  const documentRest = (data: Record_) => {
    const rest: Record_ = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === "id" || key === "createdAt" || key === "updatedAt") continue;
      if (value !== undefined) rest[key] = value;
    }
    return rest;
  };

  const insertRoot = async (
    x: SqlClient,
    plan: TablePlan,
    id: string,
    data: Record_,
  ) => {
    const names = ["id", "createdAt", "updatedAt"];
    const values: SQL[] = [
      sql`${id}`,
      encode("datetime", data.createdAt),
      encode("datetime", data.updatedAt),
    ];

    if (plan.document) {
      names.push("data");
      values.push(encode("json", documentRest(data)));
    } else {
      for (const column of plan.columns) {
        names.push(column.name);
        values.push(encode(column.type, lookup(data, column.path).value));
      }
    }

    await insertRows(x, plan.name, names, [values]);
    if (!plan.document) await writeChildren(x, plan, id, data, false);
  };

  const updateRoot = async (
    x: SqlClient,
    plan: TablePlan,
    id: string,
    data: Record_,
  ) => {
    const sets: SQL[] = [];
    for (const name of STANDARD_DATETIMES) {
      if (data[name] !== undefined) {
        sets.push(
          sql`${sql.identifier(name)} = ${encode("datetime", data[name])}`,
        );
      }
    }

    if (plan.document) {
      const rest = documentRest(data);
      if (Object.keys(rest).length) {
        sets.push(
          sql`"data" = coalesce(${col(plan.name, "data")}, '{}'::jsonb) || ${encode("json", rest)}`,
        );
      }
    } else {
      for (const column of plan.columns) {
        const { found, value } = lookup(data, column.path);
        if (found)
          sets.push(
            sql`${sql.identifier(column.name)} = ${encode(column.type, value)}`,
          );
      }
    }

    if (sets.length) {
      await run(
        x,
        sql`update ${tableRef(plan.name)} set ${sql.join(sets, sql`, `)} where ${col(plan.name, "id")} = ${id}`,
      );
    }
    if (!plan.document) await writeChildren(x, plan, id, data, true);
  };

  const exists = async (x: SqlClient, plan: TablePlan, id: string) =>
    (
      await rowsOf(
        x,
        sql`select 1 as "one" from ${tableRef(plan.name)} where ${col(plan.name, "id")} = ${id} for update`,
      )
    ).length > 0;

  const deleteSubtrees = async (x: SqlClient, plan: TablePlan, owners: SQL) => {
    for (const table of [
      ...descendantArrays(plan).map((a) => a.table),
      ...descendantPivots(plan).map((p) => p.table),
    ]) {
      await run(
        x,
        sql`delete from ${tableRef(table)} where ${col(table, "_owner")} in (${owners})`,
      );
    }
  };

  // ------------------------------------------------------------------------------------
  // Querying
  // ------------------------------------------------------------------------------------

  type Target = { ref: SQL; type: ScalarType };

  // What a field name in a condition, sort or grouping refers to: an own column on this table
  // (id, the timestamps, or a top-level scalar/link). Anything deeper isn't filterable.
  const targetOf = (plan: TablePlan, field: string): Target | undefined => {
    if (field === "id") return { ref: col(plan.name, "id"), type: "string" };
    if (field === "createdAt" || field === "updatedAt") {
      return { ref: col(plan.name, field), type: "datetime" };
    }
    const column = plan.columns.find(
      (c) => c.path.length === 1 && c.path[0] === field,
    );
    return column
      ? { ref: col(plan.name, column.name), type: column.type }
      : undefined;
  };

  const likeEscaped = (value: string) =>
    `%${escapeLike(value.toLowerCase().replaceAll(" ", ""))}%`;

  const compact = (ref: SQL) => sql`lower(replace(${ref}, ' ', ''))`;

  const conditionSql = (plan: TablePlan, condition: Condition): SQL => {
    const { field, op, value } = condition;

    if (op === "$in") {
      const array = plan.arrays.find(
        (a) => a.path.length === 1 && a.path[0] === field,
      );
      if (array && array.shape === "scalar") {
        const column = array.columns[0] as Column;
        return sql`exists (select 1 from ${tableRef(array.table)} where ${col(array.table, "_parent")} = ${col(plan.name, "id")} and ${col(array.table, "value")} = ${encode(column.type, value)})`;
      }
      const pivot = plan.pivots.find(
        (p) => p.path.length === 1 && p.path[0] === field,
      );
      if (pivot) {
        return sql`exists (select 1 from ${tableRef(pivot.table)} where ${col(pivot.table, "_parent")} = ${col(plan.name, "id")} and ${col(pivot.table, "target")} = ${String(value)})`;
      }
      throw new Error(
        `"$in" needs a list of scalars or relations, and "${field}" is not one`,
      );
    }

    const target = targetOf(plan, field);
    if (!target) throw new Error(`Unknown or unfilterable field "${field}"`);

    const bound = encode(target.type, value);
    switch (op) {
      case "$eq":
        return sql`${target.ref} = ${bound}`;
      case "$ne":
        return sql`${target.ref} is distinct from ${bound}`;
      case "$gt":
        return sql`${target.ref} > ${bound}`;
      case "$gte":
        return sql`${target.ref} >= ${bound}`;
      case "$lt":
        return sql`${target.ref} < ${bound}`;
      case "$lte":
        return sql`${target.ref} <= ${bound}`;
      case "$ieq":
        return sql`lower(${target.ref}::text) = ${String(value).toLowerCase()}`;
      case "$contains":
        return sql`${target.ref}::text ilike ${`%${escapeLike(String(value))}%`} escape '!'`;
      case "$startsWith":
        return sql`${target.ref}::text ilike ${`${escapeLike(String(value))}%`} escape '!'`;
      default:
        throw new Error(`Unknown filter operator: "${op}"`);
    }
  };

  // Free-text matching: a field matches when it contains the query (ignoring case and spaces,
  // so "red wing" finds "REDWING") or, with pg_trgm, when it is trigram-similar to it.
  const searchParts = (plan: TablePlan, query: string) => {
    const pattern = likeEscaped(query);
    const matches: SQL[] = [];
    const scores: SQL[] = [];

    const matchOn = (ref: SQL) =>
      trigrams
        ? sql`(${compact(ref)} like ${pattern} escape '!' or word_similarity(${query}, ${ref}) >= ${SIMILARITY_THRESHOLD})`
        : sql`${compact(ref)} like ${pattern} escape '!'`;
    const scoreOn = (ref: SQL) =>
      trigrams
        ? sql`(case when ${compact(ref)} like ${pattern} escape '!' then ${CONTAINMENT_BOOST} else 0 end + coalesce(word_similarity(${query}, ${ref}), 0))`
        : sql`(case when ${compact(ref)} like ${pattern} escape '!' then ${CONTAINMENT_BOOST} else 0 end)`;

    for (const target of plan.def.search) {
      if (!target.via) {
        const column = plan.columns.find(
          (c) => c.path.length === 1 && c.path[0] === target.field,
        );
        if (!column) throw new Error(`Unknown search field "${target.field}"`);
        const ref = col(plan.name, column.name);
        matches.push(matchOn(ref));
        scores.push(scoreOn(ref));
        continue;
      }

      const targetPlan = plans.get(target.table);
      const targetColumn = targetPlan?.columns.find(
        (c) => c.path.length === 1 && c.path[0] === target.field,
      );
      if (!targetPlan || !targetColumn) continue;

      const linked = plan.columns.find(
        (c) => c.path.length === 1 && c.path[0] === target.via,
      );
      const pivot = plan.pivots.find(
        (p) => p.path.length === 1 && p.path[0] === target.via,
      );
      const ref = sql`${sql.identifier("s")}.${sql.identifier(targetColumn.name)}`;

      const from = linked
        ? sql`${tableRef(targetPlan.name)} as "s" where "s"."id" = ${col(plan.name, linked.name)}`
        : pivot
          ? sql`${tableRef(pivot.table)} as "pv" join ${tableRef(targetPlan.name)} as "s" on "s"."id" = "pv"."target" where "pv"."_parent" = ${col(plan.name, "id")}`
          : undefined;
      if (!from) continue;

      matches.push(sql`exists (select 1 from ${from} and ${matchOn(ref)})`);
      scores.push(
        sql`coalesce((select max(${scoreOn(ref)}) from ${from} and ${matchOn(ref)}), 0)`,
      );
    }

    return {
      match: matches.length
        ? sql`(${sql.join(matches, sql` or `)})`
        : undefined,
      score: scores.length ? sql.join(scores, sql` + `) : undefined,
    };
  };

  const whereOf = (
    plan: TablePlan,
    conditions: readonly Condition[] | undefined,
    extra?: SQL,
  ) => {
    const parts = (conditions ?? []).map((c) => conditionSql(plan, c));
    if (extra) parts.push(extra);
    return parts.length ? sql`where ${sql.join(parts, sql` and `)}` : sql``;
  };

  const positiveInt = (value: number, fallback: number) =>
    Number.isSafeInteger(value) && value > 0 ? value : fallback;

  // ------------------------------------------------------------------------------------
  // Schema
  // ------------------------------------------------------------------------------------

  // For messages only (never executed).
  const qualifiedText = (name: string) =>
    config.schema ? `"${config.schema}"."${name}"` : `"${name}"`;

  const ddl = (x: SqlClient, statement: SQL) => run(x, statement);

  const TYPE_WORDS = new Set(Object.values(SQL_TYPE));
  const typeWord = (type: ScalarType) =>
    sql.keyword(SQL_TYPE[type], TYPE_WORDS);
  const columnDef = (c: { name: string; type: ScalarType }) =>
    sql`${sql.identifier(c.name)} ${typeWord(c.type)}`;

  // One physical table of a plan, described independently of how it is created or checked, so
  // the migration and the post-migration type check can't drift apart.
  type PhysicalTable = {
    name: string;
    // The primary key column, or undefined when the table has none (pivots).
    primary?: string;
    columns: { name: string; type: ScalarType; unique?: boolean }[];
    indexes: string[][];
  };

  const childColumns = (): PhysicalTable["columns"] => [
    { name: "_id", type: "string" },
    { name: "_owner", type: "string" },
    { name: "_parent", type: "string" },
    { name: "_pos", type: "number" },
  ];

  const pivotTable = (pivot: Pivot): PhysicalTable => ({
    name: pivot.table,
    columns: [
      { name: "_owner", type: "string" },
      { name: "_parent", type: "string" },
      { name: "_pos", type: "number" },
      { name: "target", type: "string" },
    ],
    indexes: [["_owner"], ["_parent", "_pos"], ["target"]],
  });

  const arrayTables = (array: ArrayPlan): PhysicalTable[] => [
    {
      name: array.table,
      primary: "_id",
      columns: [
        ...childColumns(),
        ...array.columns.map((c) => ({ name: c.name, type: c.type })),
      ],
      indexes: [
        ["_owner"],
        ["_parent", "_pos"],
        ...array.columns.filter((c) => c.link).map((c) => [c.name]),
      ],
    },
    ...array.pivots.map(pivotTable),
    ...array.arrays.flatMap(arrayTables),
  ];

  const physicalTables = (plan: TablePlan): PhysicalTable[] => [
    {
      name: plan.name,
      primary: "id",
      columns: [
        { name: "id", type: "string" },
        { name: "createdAt", type: "datetime" },
        { name: "updatedAt", type: "datetime" },
        ...plan.columns,
        ...(plan.document ? [{ name: "data", type: "json" as const }] : []),
      ],
      indexes: plan.columns.filter((c) => c.link).map((c) => [c.name]),
    },
    ...plan.pivots.map(pivotTable),
    ...plan.arrays.flatMap(arrayTables),
  ];

  // A statement that is allowed to fail without failing the migration. Inside a transaction a
  // failed statement poisons everything after it, so it runs in a savepoint.
  const attempt = async (
    x: SqlClient,
    body: (x: SqlClient) => Promise<unknown>,
  ) => {
    try {
      await x.transaction(body);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const ensureTable = async (x: SqlClient, table: PhysicalTable) => {
    const table_ = tableRef(table.name);

    await ddl(
      x,
      sql`create table if not exists ${table_} (${sql.join(
        [
          ...table.columns
            .filter((c) => c.name === table.primary)
            .map((c) => sql`${columnDef(c)} primary key`),
          ...table.columns
            .filter((c) => c.name !== table.primary)
            .map(columnDef),
        ],
        sql`, `,
      )})`,
    );
    // Additive migration: any column the table doesn't have yet is added; nothing is dropped
    // or retyped (a column whose type no longer matches is reported by checkColumnTypes()).
    for (const c of table.columns) {
      await ddl(
        x,
        sql`alter table ${table_} add column if not exists ${columnDef(c)}`,
      );
    }
    for (const index of table.indexes) {
      await ddl(
        x,
        sql`create index if not exists ${sql.identifier(physicalName(`idx_${table.name}_${index.join("_")}`))} on ${table_} (${sql.join(
          index.map((name) => sql.identifier(name)),
          sql`, `,
        )})`,
      );
    }
    for (const c of table.columns) {
      if (!c.unique) continue;
      const failure = await attempt(x, (sp) =>
        ddl(
          sp,
          sql`create unique index if not exists ${sql.identifier(physicalName(`uq_${table.name}_${c.name}`))} on ${table_} (${sql.identifier(c.name)})`,
        ),
      );
      if (failure) {
        console.warn(
          `[njin] Could not enforce uniqueness of ${table.name}.${c.name} in the database (existing duplicates?): ${failure}`,
        );
      }
    }
  };

  const ensurePlan = async (x: SqlClient, plan: TablePlan) => {
    for (const table of physicalTables(plan)) await ensureTable(x, table);

    if (plan.document) {
      await ddl(
        x,
        sql`alter table ${tableRef(plan.name)} alter column ${sql.identifier("data")} set default '{}'::jsonb`,
      );
    }

    if (trigrams) {
      for (const target of plan.def.search) {
        if (target.via) continue;
        const column = plan.columns.find(
          (c) => c.path.length === 1 && c.path[0] === target.field,
        );
        if (!column) continue;
        await ddl(
          x,
          sql`create index if not exists ${sql.identifier(physicalName(`trgm_${plan.name}_${column.name}`))} on ${tableRef(plan.name)} using gin (${sql.identifier(column.name)} gin_trgm_ops)`,
        );
      }
    }
  };

  // Migrations never retype a column, so when a field's type changes the column quietly keeps
  // its old one — and data written or read through the new type goes wrong. Say so, loudly,
  // on every boot until it is fixed by hand.
  const warnedMismatches = new Set<string>();

  const checkColumnTypes = async () => {
    const rows = await rowsOf(
      db,
      sql`select table_name, column_name, data_type from information_schema.columns where table_schema = ${config.schema ?? sql`current_schema()`}`,
    );
    const actual = new Map(
      rows.map((r) => [
        `${r.table_name}.${r.column_name}`,
        String(r.data_type),
      ]),
    );

    for (const plan of plans.values()) {
      for (const table of physicalTables(plan)) {
        for (const c of table.columns) {
          const key = `${table.name}.${c.name}`;
          const found = actual.get(key);
          const wanted = DATA_TYPE[c.type];
          if (!found || found === wanted || warnedMismatches.has(key)) continue;

          warnedMismatches.add(key);
          console.warn(
            `[njin] ${key} is "${found}" in the database but the model now says "${wanted}". ` +
              "Migrations never retype a column, so it was left alone; convert it yourself, e.g. " +
              `ALTER TABLE ${qualifiedText(table.name)} ALTER COLUMN "${c.name}" TYPE ${SQL_TYPE[c.type]} USING "${c.name}"::${SQL_TYPE[c.type]};`,
          );
        }
      }
    }
  };

  // ------------------------------------------------------------------------------------
  // The adapter
  // ------------------------------------------------------------------------------------

  const adapter: DbAdapter = {
    name: "postgres",

    describe() {
      const where = config.url
        ? hostAndDatabase(config.url)
        : "custom connection";
      return config.schema ? `${where} (${config.schema})` : where;
    },

    get capabilities(): AdapterCapabilities {
      return { search: trigrams ? "fuzzy" : "basic" };
    },

    async connect() {
      if (config.connect) {
        const connection = await config.connect();
        db = guarded(connection.client);
        closer = connection.close;
      } else if (config.url) {
        const connection = bunSqlClient(config.url, {
          max: config.max,
          tls: config.tls,
        });
        db = guarded(connection.client);
        closer = connection.close;
      } else {
        throw new Error("postgresAdapter() needs either `url` or `connect`");
      }

      await run(db, sql`select 1`);
    },

    async close() {
      await closer?.();
    },

    async sync(tables) {
      plans.clear();
      for (const table of tables) plans.set(table.name, planTable(table));

      // The whole migration is one transaction behind an advisory lock: several processes
      // booting against the same database take turns (and the later ones find the schema
      // already recorded and skip), and a failure halfway leaves nothing half-built.
      await db.transaction(async (tx) => {
        await run(
          tx,
          sql`select pg_advisory_xact_lock(hashtext(${SCHEMA_LOCK}))`,
        );

        // Fuzzy search needs pg_trgm; without it (managed databases often restrict
        // extensions) search still works, just as plain substring matching.
        trigrams =
          (await attempt(tx, (sp) =>
            ddl(sp, sql`create extension if not exists pg_trgm`),
          )) === undefined;

        const hash = createHash("sha256")
          .update(
            JSON.stringify({
              version: LAYOUT_VERSION,
              trigrams,
              schema: config.schema ?? null,
              tables: [...plans.values()].map((p) => ({
                name: p.name,
                columns: p.columns,
                arrays: p.arrays,
                pivots: p.pivots,
                document: p.document,
                search: p.def.search,
              })),
            }),
          )
          .digest("hex");

        await ddl(
          tx,
          sql`create table if not exists ${tableRef(SCHEMA_META_TABLE)} ("key" text primary key, "hash" text not null)`,
        );
        const [recorded] = await rowsOf(
          tx,
          sql`select "hash" from ${tableRef(SCHEMA_META_TABLE)} where "key" = 'current'`,
        );
        if (recorded?.hash === hash) return;

        for (const plan of plans.values()) await ensurePlan(tx, plan);

        await run(
          tx,
          sql`insert into ${tableRef(SCHEMA_META_TABLE)} ("key", "hash") values ('current', ${hash}) on conflict ("key") do update set "hash" = excluded."hash"`,
        );
      });

      await checkColumnTypes();
    },

    async find(table, id, opts) {
      const plan = planOf(table);
      const row = (await loadRows(db, plan, [id])).get(id);
      if (!row) return null;
      await populate(db, plan, [row], opts?.populate ?? []);
      return row;
    },

    async insert(table, data, opts) {
      const plan = planOf(table);
      const id = opts?.id ?? newId();

      await db.transaction(async (tx) => {
        await insertRoot(tx, plan, id, data);
      });

      return (await loadRows(db, plan, [id])).get(id) as Row;
    },

    async update(table, id, patch) {
      const plan = planOf(table);

      const found = await db.transaction(async (tx) => {
        if (!(await exists(tx, plan, id))) return false;
        await updateRoot(tx, plan, id, patch);
        return true;
      });

      return found ? ((await loadRows(db, plan, [id])).get(id) as Row) : null;
    },

    async upsert(table, id, data) {
      const plan = planOf(table);

      await db.transaction(async (tx) => {
        if (await exists(tx, plan, id)) await updateRoot(tx, plan, id, data);
        else await insertRoot(tx, plan, id, data);
      });

      return (await loadRows(db, plan, [id])).get(id) as Row;
    },

    async remove(table, id) {
      const plan = planOf(table);
      const row = (await loadRows(db, plan, [id])).get(id);
      if (!row) return null;

      await db.transaction(async (tx) => {
        await deleteSubtrees(tx, plan, sql`${id}`);
        await run(
          tx,
          sql`delete from ${tableRef(plan.name)} where ${col(plan.name, "id")} = ${id}`,
        );
      });

      return row;
    },

    async list(table, q: ListQuery): Promise<ListResult> {
      const plan = planOf(table);
      const limit = positiveInt(q.limit, 20);
      const page = positiveInt(q.page, 1);
      const offset = (page - 1) * limit;

      const term = q.search?.trim();
      const search =
        term && plan.def.search.length ? searchParts(plan, term) : undefined;
      const where = whereOf(plan, q.where, search?.match);

      let order: SQL;
      let ranking = sql``;
      if (q.sort) {
        const target = targetOf(plan, q.sort.field);
        if (!target)
          throw new Error(`Unknown or unsortable field "${q.sort.field}"`);
        order = sql`order by ${target.ref} ${q.sort.order === "desc" ? sql`desc` : sql`asc`}, ${col(plan.name, "id")}`;
      } else if (search?.score) {
        ranking = sql`, (${search.score}) as "__relevance"`;
        order = sql`order by "__relevance" desc, ${col(plan.name, "id")}`;
      } else {
        order = sql`order by ${col(plan.name, "createdAt")}, ${col(plan.name, "id")}`;
      }

      const page_ = await rowsOf(
        db,
        sql`select ${col(plan.name, "id")} as "id"${ranking} from ${tableRef(plan.name)} ${where} ${order} limit ${sql.int(limit)} offset ${sql.int(offset)}`,
      );
      const [counted] = await rowsOf(
        db,
        sql`select count(*)::int as "n" from ${tableRef(plan.name)} ${where}`,
      );

      const ids = page_.map((r) => String(r.id));
      const nested = Object.entries(q.select?.nested ?? {});
      const flat = q.select?.fields ?? [];
      const projecting = flat.length > 0 || nested.length > 0;
      const want = projecting
        ? new Set([...flat, ...nested.map(([local]) => local)])
        : undefined;

      const loaded = await loadRows(db, plan, ids, want);
      const rows = ids.map((id) => loaded.get(id)).filter(Boolean) as Record_[];

      await populate(db, plan, rows, q.populate);
      for (const [local, fields] of nested) {
        await populate(db, plan, rows, [local], fields);
      }

      const result: PartialRow[] = projecting
        ? rows.map((row) => {
            const picked: Record_ = { id: row.id };
            for (const key of [...flat, ...nested.map(([local]) => local)]) {
              if (key in row) picked[key] = row[key];
            }
            return picked as PartialRow;
          })
        : (rows as PartialRow[]);

      return { rows: result, total: Number(counted?.n ?? 0) };
    },

    async count(table, where) {
      const plan = planOf(table);
      const [row] = await rowsOf(
        db,
        sql`select count(*)::int as "n" from ${tableRef(plan.name)} ${whereOf(plan, where)}`,
      );
      return Number(row?.n ?? 0);
    },

    async removeWhere(table, where) {
      const plan = planOf(table);
      const clause = whereOf(plan, where);

      return db.transaction(async (tx) => {
        await deleteSubtrees(
          tx,
          plan,
          sql`select ${col(plan.name, "id")} from ${tableRef(plan.name)} ${clause}`,
        );
        const removed = await rowsOf(
          tx,
          sql`delete from ${tableRef(plan.name)} ${clause} returning ${col(plan.name, "id")} as "id"`,
        );
        return removed.length;
      });
    },

    async countBy(q: CountBy) {
      const plan = plans.get(q.table);
      if (!plan) throw new Error(`Unknown table "${q.table}"`);

      const target = targetOf(plan, q.groupBy);
      if (!target)
        throw new Error(`Unknown or ungroupable field "${q.groupBy}"`);

      let key: SQL;
      if (q.prefix) {
        const length = positiveInt(q.prefix, 1);
        const text =
          target.type === "datetime"
            ? iso(target.ref)
            : sql`${target.ref}::text`;
        key = sql`left(${text}, ${sql.int(length)})`;
      } else {
        key = target.type === "string" ? target.ref : sql`${target.ref}::text`;
      }

      const rows = await rowsOf(
        db,
        sql`select ${key} as "key", count(*)::int as "count" from ${tableRef(plan.name)} ${whereOf(plan, q.where)} group by 1 order by ${q.prefix ? sql`1 asc` : sql`2 desc, 1 asc`}`,
      );

      return rows.map((r) => ({
        key: r.key === null || r.key === undefined ? null : String(r.key),
        count: Number(r.count),
      }));
    },
  };

  return adapter;
};

export default postgresAdapter;
