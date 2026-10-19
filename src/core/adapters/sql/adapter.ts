import { createHash } from "node:crypto";
import {
  type AdapterCapabilities,
  type Condition,
  type CountBy,
  type DbAdapter,
  type DbOperations,
  LinkTargetMissingError,
  type ListQuery,
  type ListResult,
  type PartialRow,
  type Row,
  type ScalarType,
  type TableDef,
} from "../../db/contract";
import { run, type SQL, type SqlClient, sql } from "./builder";
import type { Dialect } from "./dialect";
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
} from "./plan";

// The DbAdapter for every SQL database, parameterised by a Dialect (./dialect.ts). The physical
// layout comes from ./plan.ts and statements are composed with ./builder.ts, whose only way to
// put text into SQL is a quoted identifier, a validated integer or an allow-listed keyword —
// every value is a bound parameter. Migrations are generated here and are additive only:
// nothing is ever dropped or retyped.
//
// Layout (see plan.ts): scalars are columns, an object() is flattened into columns, a relation
// is a text column holding the target id, a relationMany() is a pivot table and an array() is
// a child table. Datetimes go in and out as ISO-8601 strings.

// What a failed statement surfaces as. A driver's error can carry details of the row that
// failed (a duplicate-key error quotes the value), and errors end up in logs and error
// trackers — so a driver error is replaced by one holding only its message, an error code
// (SQLSTATE, MySQL's error number or SQLite's result name) and constraint name.
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

const errorCode = (error: DriverError) => {
  for (const candidate of [error.errno, error.code]) {
    if (typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate)) {
      return candidate;
    }
  }
  if (typeof error.errno === "number") return String(error.errno);
  if (typeof error.code === "string" && /^SQLITE_\w+$/.test(error.code)) {
    return error.code;
  }
  return undefined;
};

// SQLSTATE 23503 (Postgres), error 1452 (MySQL / MariaDB: cannot add or update a child row),
// extended result 787 (SQLite). A violation on delete cannot happen: links are SET NULL / CASCADE.
const FOREIGN_KEY_CODES = new Set(["23503", "1452", "787"]);

const sanitize = (error: unknown): unknown => {
  if (!isDriverError(error)) return error;

  const code = errorCode(error);
  const constraint =
    typeof error.constraint === "string" ? error.constraint : undefined;

  if (
    (code && FOREIGN_KEY_CODES.has(code)) ||
    error.code === "SQLITE_CONSTRAINT_FOREIGNKEY"
  ) {
    return new LinkTargetMissingError(constraint);
  }

  return new DbError(error.message, code, constraint);
};

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

export type Connection = {
  client: SqlClient;
  close?: () => Promise<void> | void;
};

export type SqlAdapterSpec = {
  // The adapter's name until the dialect is known (see `dialect`).
  name: string;
  // The dialect, or a function that picks one from the live connection (MySQL and MariaDB
  // share a driver and tell themselves apart by their version string).
  dialect: Dialect | ((client: SqlClient) => Promise<Dialect>);
  connect: () => Promise<Connection> | Connection;
  // One line for the startup banner, without credentials.
  describe: () => string;
  // Put every table in this schema (database) instead of the connection's default one.
  schema?: string;
};

type Record_ = Record<string, unknown>;

// A field that truly contains the search string outranks one that only looks similar.
const CONTAINMENT_BOOST = 100;
// Without a native fuzzy feature, a field is a fuzzy match when it contains at least this share
// of the search string's trigrams (three-letter slices), and ranks by that share. A search
// string is cut to its first MAX_TRIGRAMS distinct trigrams to keep the statement small.
const SIMILARITY_THRESHOLD = 0.5;
const MAX_TRIGRAMS = 24;
const SCHEMA_META_TABLE = "njin_schema_meta";
// Bump to force every database to re-run its (idempotent) DDL on next boot.
const LAYOUT_VERSION = 2;
const INSERT_CHUNK = 200;

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

// Values reach the dialect already validated and normalised: strings, finite numbers, booleans,
// ISO-8601 datetimes and JSON text.
const normalise = (type: ScalarType, value: unknown): unknown => {
  switch (type) {
    case "string":
      return typeof value === "string" ? value : String(value);
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n))
        throw new Error(`Not a number: ${String(value)}`);
      return n;
    }
    case "boolean":
      return value === true || value === "true";
    case "datetime": {
      const date = new Date(value as string);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`Not a valid datetime: ${String(value)}`);
      }
      return date.toISOString();
    }
    case "json":
      return JSON.stringify(value);
  }
};

const decode = (type: ScalarType, value: unknown) => {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value;
    case "number":
      return typeof value === "string" || typeof value === "bigint"
        ? Number(value)
        : value;
    case "boolean":
      return value === true || value === 1 || value === 1n || value === "1";
    default:
      return value;
  }
};

export const escapeLike = (value: string) =>
  value.replace(/[!%_]/g, (m) => `!${m}`);

export const sqlAdapter = (config: SqlAdapterSpec): DbAdapter => {
  let db: SqlClient;
  let dialect: Dialect;
  let closer: Connection["close"];
  const plans = new Map<string, TablePlan>();
  let fuzzy = false;

  const encode = (type: ScalarType, value: unknown): SQL =>
    value === null || value === undefined
      ? sql`NULL`
      : dialect.encode(type, normalise(type, value));
  const iso = (ref: SQL) => dialect.iso(ref);

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
      return sql`${dialect.jsonText(ref)} as ${alias(column.name)}`;
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
      selected.push(sql`${dialect.jsonText(col(plan.name, "data"))} as "data"`);

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
        // A shallow merge of the top-level keys, done here because databases disagree on JSON
        // merge semantics. The row is already locked by the caller.
        const [current] = await rowsOf(
          x,
          sql`select ${dialect.jsonText(col(plan.name, "data"))} as "data" from ${tableRef(plan.name)} where ${col(plan.name, "id")} = ${id}`,
        );
        const merged = {
          ...(current?.data
            ? (JSON.parse(String(current.data)) as Record_)
            : {}),
          ...rest,
        };
        sets.push(sql`"data" = ${encode("json", merged)}`);
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
        sql`select 1 as "one" from ${tableRef(plan.name)} where ${col(plan.name, "id")} = ${id} ${dialect.rowLock}`,
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

  // The distinct three-letter slices of the search string, lower-cased and without spaces —
  // the same view of the text that `compact` gives the stored value.
  const trigramsOf = (query: string) => {
    const text = query.toLowerCase().replaceAll(" ", "");
    const found = new Set<string>();
    for (let i = 0; i + 3 <= text.length && found.size < MAX_TRIGRAMS; i += 1) {
      found.add(text.slice(i, i + 3));
    }
    return [...found];
  };

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
        return dialect.distinct(target.ref, bound);
      case "$gt":
        return sql`${target.ref} > ${bound}`;
      case "$gte":
        return sql`${target.ref} >= ${bound}`;
      case "$lt":
        return sql`${target.ref} < ${bound}`;
      case "$lte":
        return sql`${target.ref} <= ${bound}`;
      case "$ieq":
        return sql`lower(${dialect.text(target.ref, target.type)}) = ${String(value).toLowerCase()}`;
      case "$contains":
        return dialect.ilike(
          dialect.text(target.ref, target.type),
          `%${escapeLike(String(value))}%`,
        );
      case "$startsWith":
        return dialect.ilike(
          dialect.text(target.ref, target.type),
          `${escapeLike(String(value))}%`,
        );
      default:
        throw new Error(`Unknown filter operator: "${op}"`);
    }
  };

  // Free-text matching: a field matches when it contains the query (ignoring case and spaces,
  // so "red wing" finds "REDWING") or, where the dialect can, when it is similar to it.
  const searchParts = (
    plan: TablePlan,
    query: string,
    searchLocale?: string,
  ) => {
    const pattern = likeEscaped(query);
    const matches: SQL[] = [];
    const scores: SQL[] = [];

    const fuzzier = fuzzy ? dialect.fuzzy : undefined;
    const grams = fuzzier ? [] : trigramsOf(query);
    const needed = Math.ceil(grams.length * SIMILARITY_THRESHOLD);

    // How many of the search string's trigrams the field contains. Plain LIKE, so it works the
    // same on every database.
    const hits = (ref: SQL) =>
      sql.join(
        grams.map(
          (g) =>
            sql`(case when ${compact(ref)} like ${`%${escapeLike(g)}%`} escape '!' then 1 else 0 end)`,
        ),
        sql` + `,
      );

    const matchOn = (ref: SQL) => {
      const contains = sql`${compact(ref)} like ${pattern} escape '!'`;
      if (fuzzier) return sql`(${contains} or ${fuzzier.match(ref, query)})`;
      if (!grams.length) return contains;
      return sql`(${contains} or (${hits(ref)}) >= ${sql.int(needed)})`;
    };
    const scoreOn = (ref: SQL) => {
      const contained = sql`case when ${compact(ref)} like ${pattern} escape '!' then ${CONTAINMENT_BOOST} else 0 end`;
      if (fuzzier) {
        return sql`(${contained} + coalesce(${fuzzier.score(ref, query)}, 0))`;
      }
      if (!grams.length) return sql`(${contained})`;
      return sql`(${contained} + (${hits(ref)}) * 1.0 / ${sql.int(grams.length)})`;
    };

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

      // A link into a table of languages: its rows are keyed by the linked record's id, and can
      // be narrowed to one language.
      let keyed = sql.identifier("id");
      let inLanguage = sql``;
      if (target.perLanguage) {
        const key = targetPlan.columns.find(
          (c) => c.path.length === 1 && c.path[0] === target.perLanguage!.key,
        );
        const language = targetPlan.columns.find(
          (c) =>
            c.path.length === 1 && c.path[0] === target.perLanguage!.locale,
        );
        if (!key || !language) continue;
        keyed = sql.identifier(key.name);
        if (searchLocale !== undefined) {
          inLanguage = sql` and "s".${sql.identifier(language.name)} = ${searchLocale}`;
        }
      }

      const from = linked
        ? sql`${tableRef(targetPlan.name)} as "s" where "s".${keyed} = ${col(plan.name, linked.name)}${inLanguage}`
        : pivot
          ? sql`${tableRef(pivot.table)} as "pv" join ${tableRef(targetPlan.name)} as "s" on "s".${keyed} = "pv"."target" where "pv"."_parent" = ${col(plan.name, "id")}${inLanguage}`
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

  // The column types the dialect can ask for: the only words allowed into a CREATE or ALTER.
  let typeWords: ReadonlySet<string> = new Set();
  const typeWord = (type: ScalarType, key: boolean) =>
    sql.keyword(dialect.columnType(type, key), typeWords);
  const isKey = (table: PhysicalTable, c: PhysicalTable["columns"][number]) =>
    c.name === table.primary ||
    c.unique === true ||
    table.indexes.some((index) => index.includes(c.name));
  const columnDef = (
    table: PhysicalTable,
    c: PhysicalTable["columns"][number],
  ) => sql`${sql.identifier(c.name)} ${typeWord(c.type, isKey(table, c))}`;

  // One physical table of a plan, described independently of how it is created or checked, so
  // the migration and the post-migration type check can't drift apart.
  type PhysicalTable = {
    name: string;
    // The primary key column, or undefined when the table has none (pivots).
    primary?: string;
    columns: { name: string; type: ScalarType; unique?: boolean }[];
    indexes: string[][];
    foreignKeys: ForeignKey[];
  };

  // A link the database enforces. A one() link that loses its target becomes null; a pivot
  // entry or an array row that loses its target / its owner row is deleted with it.
  type ForeignKey = {
    name: string;
    column: string;
    target: string;
    onDelete: "set null" | "cascade";
  };

  const foreignKey = (
    table: string,
    column: string,
    target: string,
    onDelete: ForeignKey["onDelete"],
  ): ForeignKey => ({
    name: physicalName(`fk_${table}_${column}`),
    column,
    target,
    onDelete,
  });

  // Only links to a table njin manages: a target outside the synced set (a model that was
  // never registered) cannot be referenced, and such a link has always been left unresolved.
  const enforced = (table: PhysicalTable) =>
    table.foreignKeys.filter((fk) => plans.has(fk.target));

  const onDeleteSql = (fk: ForeignKey) =>
    fk.onDelete === "cascade"
      ? sql`on delete cascade`
      : sql`on delete set null`;

  const foreignKeyDef = (fk: ForeignKey) =>
    sql`foreign key (${sql.identifier(fk.column)}) references ${tableRef(fk.target)} (${sql.identifier("id")}) ${onDeleteSql(fk)}`;

  const childColumns = (): PhysicalTable["columns"] => [
    { name: "_id", type: "string" },
    { name: "_owner", type: "string" },
    { name: "_parent", type: "string" },
    { name: "_pos", type: "number" },
  ];

  // `root` is the table of the row everything below ultimately belongs to (`_owner`).
  const pivotTable = (pivot: Pivot, root: string): PhysicalTable => ({
    name: pivot.table,
    columns: [
      { name: "_owner", type: "string" },
      { name: "_parent", type: "string" },
      { name: "_pos", type: "number" },
      { name: "target", type: "string" },
    ],
    indexes: [["_owner"], ["_parent", "_pos"], ["target"]],
    foreignKeys: [
      foreignKey(pivot.table, "_owner", root, "cascade"),
      foreignKey(pivot.table, "target", pivot.target, "cascade"),
    ],
  });

  const arrayTables = (array: ArrayPlan, root: string): PhysicalTable[] => [
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
      foreignKeys: [
        foreignKey(array.table, "_owner", root, "cascade"),
        ...array.columns
          .filter((c) => c.link)
          .map((c) => foreignKey(array.table, c.name, c.link!, "set null")),
      ],
    },
    ...array.pivots.map((pivot) => pivotTable(pivot, root)),
    ...array.arrays.flatMap((nested) => arrayTables(nested, root)),
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
      foreignKeys: plan.columns
        .filter((c) => c.link)
        .map((c) => foreignKey(plan.name, c.name, c.link!, "set null")),
    },
    ...plan.pivots.map((pivot) => pivotTable(pivot, plan.name)),
    ...plan.arrays.flatMap((array) => arrayTables(array, plan.name)),
  ];

  // A statement that is allowed to fail without failing the migration. Where DDL is
  // transactional a failed statement poisons everything after it, so it runs in a savepoint.
  const attempt = async (
    x: SqlClient,
    body: (x: SqlClient) => Promise<unknown>,
  ) => {
    try {
      if (dialect.transactionalDdl) await x.transaction(body);
      else await body(x);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  // What the database had before this migration started.
  type Existing = {
    columns: Map<string, Set<string>>;
    indexes: Set<string> | undefined;
  };

  // MySQL treats table, column and index names case-insensitively (and on some systems stores
  // them lower-cased), so what it reports is compared folded.
  const fold = (name: string) =>
    dialect.caseInsensitiveNames ? name.toLowerCase() : name;

  const existing = async (x: SqlClient): Promise<Existing> => {
    const columns = new Map<string, Set<string>>();
    for (const key of (await dialect.columns(x, config.schema)).keys()) {
      const dot = key.indexOf(".");
      const table = fold(key.slice(0, dot));
      const set = columns.get(table) ?? new Set<string>();
      set.add(fold(key.slice(dot + 1)));
      columns.set(table, set);
    }
    const indexes = dialect.indexIfNotExists
      ? undefined
      : await dialect.indexes?.(x, config.schema);
    return {
      columns,
      indexes: indexes && new Set([...indexes].map(fold)),
    };
  };

  const createIndex = (unique: boolean) =>
    unique
      ? dialect.indexIfNotExists
        ? sql`create unique index if not exists`
        : sql`create unique index`
      : dialect.indexIfNotExists
        ? sql`create index if not exists`
        : sql`create index`;

  const ensureTable = async (
    x: SqlClient,
    table: PhysicalTable,
    before: Existing,
  ) => {
    const table_ = tableRef(table.name);
    const had = before.columns.get(fold(table.name));

    await ddl(
      x,
      sql`create table if not exists ${table_} (${sql.join(
        [
          ...table.columns
            .filter((c) => c.name === table.primary)
            .map((c) => sql`${columnDef(table, c)} primary key`),
          ...table.columns
            .filter((c) => c.name !== table.primary)
            .map((c) => columnDef(table, c)),
          // SQLite can only declare a link when the table is created.
          ...(dialect.foreignKeys === "inline"
            ? enforced(table).map(
                (fk) =>
                  sql`constraint ${sql.identifier(fk.name)} ${foreignKeyDef(fk)}`,
              )
            : []),
        ],
        sql`, `,
      )})${dialect.tableOptions ?? sql``}`,
    );
    // Additive migration: any column the table doesn't have yet is added; nothing is dropped
    // or retyped (a column whose type no longer matches is reported by checkColumnTypes()).
    if (had) {
      for (const c of table.columns) {
        if (had.has(fold(c.name))) continue;
        await ddl(
          x,
          sql`alter table ${table_} add column ${columnDef(table, c)}`,
        );
      }
    }

    const indexed = (name: string) =>
      before.indexes?.has(fold(`${table.name}.${name}`)) ?? false;

    for (const index of table.indexes) {
      const name = physicalName(`idx_${table.name}_${index.join("_")}`);
      if (indexed(name)) continue;
      await ddl(
        x,
        sql`${createIndex(false)} ${sql.identifier(name)} on ${table_} (${sql.join(
          index.map((column) => sql.identifier(column)),
          sql`, `,
        )})`,
      );
    }
    for (const c of table.columns) {
      if (!c.unique) continue;
      const name = physicalName(`uq_${table.name}_${c.name}`);
      if (indexed(name)) continue;
      const failure = await attempt(x, (sp) =>
        ddl(
          sp,
          sql`${createIndex(true)} ${sql.identifier(name)} on ${table_} (${sql.identifier(c.name)})`,
        ),
      );
      if (failure) {
        console.warn(
          `[njin] Could not enforce uniqueness of ${table.name}.${c.name} in the database (existing duplicates?): ${failure}`,
        );
      }
    }
  };

  // Postgres / MySQL: the constraints go in once every table exists (a table can only reference
  // one that is already there, and links may be circular). Existing rows that link to a record
  // that is gone make a plain ADD CONSTRAINT fail; those databases fall back to enforcing the
  // link for new writes only, and the migration says so.
  const ensureForeignKeys = async (x: SqlClient) => {
    const known = new Set(
      [...((await dialect.foreignKeyNames?.(x, config.schema)) ?? [])].map(
        fold,
      ),
    );

    for (const plan of plans.values()) {
      for (const table of physicalTables(plan)) {
        for (const fk of enforced(table)) {
          if (known.has(fold(`${table.name}.${fk.name}`))) continue;

          const statement = sql`alter table ${tableRef(table.name)} add constraint ${sql.identifier(fk.name)} ${foreignKeyDef(fk)}`;
          const failure = await attempt(x, (sp) => ddl(sp, statement));
          if (!failure) continue;

          const unchecked = dialect.addUncheckedForeignKey;
          const fallback = unchecked
            ? await attempt(x, (sp) => unchecked(sp, statement))
            : failure;
          console.warn(
            fallback
              ? `[njin] Could not add the link ${table.name}.${fk.column} -> ${fk.target}: ${fallback}`
              : `[njin] ${table.name}.${fk.column} links to ${fk.target} records that no longer exist. The link is enforced for new writes only; clean up the old rows to enforce it fully.`,
          );
        }
      }
    }
  };

  const ensurePlan = async (
    x: SqlClient,
    plan: TablePlan,
    before: Existing,
  ) => {
    for (const table of physicalTables(plan)) {
      await ensureTable(x, table, before);
    }

    if (plan.document) {
      await dialect.documentDefault?.(x, tableRef(plan.name), "data");
    }

    if (fuzzy && dialect.fuzzy) {
      for (const target of plan.def.search) {
        if (target.via) continue;
        const column = plan.columns.find(
          (c) => c.path.length === 1 && c.path[0] === target.field,
        );
        if (!column) continue;
        await ddl(
          x,
          dialect.fuzzy.index(
            physicalName(`trgm_${plan.name}_${column.name}`),
            tableRef(plan.name),
            column.name,
          ),
        );
      }
    }
  };

  // Migrations never retype a column, so when a field's type changes the column quietly keeps
  // its old one — and data written or read through the new type goes wrong. Say so, loudly,
  // on every boot until it is fixed by hand.
  const warnedMismatches = new Set<string>();

  const checkColumnTypes = async () => {
    const actual = new Map(
      [...(await dialect.columns(db, config.schema))].map(([key, type]) => [
        fold(key),
        type,
      ]),
    );

    for (const plan of plans.values()) {
      for (const table of physicalTables(plan)) {
        for (const c of table.columns) {
          const key = `${table.name}.${c.name}`;
          const found = actual.get(fold(key));
          if (
            !found ||
            dialect.sameType(c.type, found) ||
            warnedMismatches.has(key)
          ) {
            continue;
          }

          warnedMismatches.add(key);
          console.warn(
            `[njin] ${key} is "${found}" in the database but the model now says "${dialect.columnType(c.type, isKey(table, c))}". ` +
              "Migrations never retype a column, so it was left alone; convert it yourself, e.g. " +
              dialect.retypeHint(qualifiedText(table.name), c.name, c.type),
          );
        }
      }
    }
  };

  // ------------------------------------------------------------------------------------
  // The adapter
  // ------------------------------------------------------------------------------------

  // The data operations on a given client: the connection itself, or the one a transaction was
  // opened with. Inside, `db` is that client (it shadows the connection's), so the same code
  // serves both.
  const operationsOn = (db: SqlClient): Omit<DbOperations, "transaction"> => ({
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
        term && plan.def.search.length
          ? searchParts(plan, term, q.searchLocale)
          : undefined;
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
        sql`select count(*) as "n" from ${tableRef(plan.name)} ${where}`,
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
        sql`select count(*) as "n" from ${tableRef(plan.name)} ${whereOf(plan, where)}`,
      );
      return Number(row?.n ?? 0);
    },

    async removeWhere(table, where) {
      const plan = planOf(table);
      const clause = whereOf(plan, where);

      return db.transaction(async (tx) => {
        if (dialect.deleteReturning) {
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
        }

        const ids = (
          await rowsOf(
            tx,
            sql`select ${col(plan.name, "id")} as "id" from ${tableRef(plan.name)} ${clause}`,
          )
        ).map((r) => String(r.id));
        for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
          const chunk = idList(ids.slice(i, i + INSERT_CHUNK));
          await deleteSubtrees(tx, plan, chunk);
          await run(
            tx,
            sql`delete from ${tableRef(plan.name)} where ${col(plan.name, "id")} in (${chunk})`,
          );
        }
        return ids.length;
      });
    },

    async countBy(q: CountBy) {
      const plan = plans.get(q.table);
      if (!plan) throw new Error(`Unknown table "${q.table}"`);

      const target = targetOf(plan, q.groupBy);
      if (!target)
        throw new Error(`Unknown or ungroupable field "${q.groupBy}"`);

      const asText = dialect.text(target.ref, target.type);
      let key: SQL;
      if (q.prefix) {
        key = sql`substr(${asText}, 1, ${sql.int(positiveInt(q.prefix, 1))})`;
      } else {
        key = target.type === "string" ? target.ref : asText;
      }

      const rows = await rowsOf(
        db,
        sql`select ${key} as "key", count(*) as "count" from ${tableRef(plan.name)} ${whereOf(plan, q.where)} group by 1 order by ${q.prefix ? sql`1 asc` : sql`2 desc, 1 asc`}`,
      );

      return rows.map((r) => ({
        key: r.key === null || r.key === undefined ? null : String(r.key),
        count: Number(r.count),
      }));
    },
  });

  // Operations plus transaction(): a transaction opened on a transaction's client is a savepoint.
  const viewOn = (client: SqlClient): DbOperations => ({
    ...operationsOn(client),
    transaction: (fn) => client.transaction((tx) => fn(viewOn(tx))),
  });

  const adapter: DbAdapter = {
    get name() {
      return dialect?.name ?? config.name;
    },

    describe() {
      return config.describe();
    },

    get capabilities(): AdapterCapabilities {
      // Native where the database has it, trigram counting in plain SQL where it doesn't.
      return { search: "fuzzy", referentialIntegrity: true };
    },

    async connect() {
      const connection = await config.connect();
      db = guarded(connection.client);
      closer = connection.close;

      dialect =
        typeof config.dialect === "function"
          ? await config.dialect(db)
          : config.dialect;
      typeWords = new Set(
        (["string", "number", "boolean", "datetime", "json"] as const).flatMap(
          (type) => [
            dialect.columnType(type, true),
            dialect.columnType(type, false),
          ],
        ),
      );

      await run(db, sql`select 1`);
    },

    async close() {
      await closer?.();
    },

    async sync(tables) {
      plans.clear();
      for (const table of tables) plans.set(table.name, planTable(table));

      // The whole migration runs in one transaction behind a lock: several processes booting
      // against the same database take turns (and the later ones find the schema already
      // recorded and skip), and where DDL is transactional a failure halfway leaves nothing
      // half-built.
      await db.transaction(async (tx) => {
        const release = await dialect.lock(tx, SCHEMA_LOCK);

        try {
          // Fuzzy search needs a database feature (an extension) that managed databases often
          // restrict; without it search still works, just as plain substring matching.
          const feature = dialect.fuzzy;
          fuzzy = feature
            ? (await attempt(tx, (sp) => feature.enable(sp))) === undefined
            : false;

          const hash = createHash("sha256")
            .update(
              JSON.stringify({
                version: LAYOUT_VERSION,
                dialect: dialect.name,
                fuzzy,
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

          const meta = tableRef(SCHEMA_META_TABLE);
          await ddl(
            tx,
            sql`create table if not exists ${meta} ("key" ${typeWord("string", true)} primary key, "hash" ${typeWord("string", false)} not null)${dialect.tableOptions ?? sql``}`,
          );
          const [recorded] = await rowsOf(
            tx,
            sql`select "hash" from ${meta} where "key" = 'current'`,
          );
          if (recorded?.hash === hash) return;

          const before = await existing(tx);
          for (const plan of plans.values()) {
            await ensurePlan(tx, plan, before);
          }
          if (dialect.foreignKeys === "alter") await ensureForeignKeys(tx);

          await run(tx, sql`delete from ${meta} where "key" = 'current'`);
          await run(
            tx,
            sql`insert into ${meta} ("key", "hash") values ('current', ${hash})`,
          );
        } finally {
          await release();
        }
      });

      await checkColumnTypes();
    },

    // The connection is made in connect(), so the client is looked up per call.
    find: (...args) => viewOn(db).find(...args),
    insert: (...args) => viewOn(db).insert(...args),
    update: (...args) => viewOn(db).update(...args),
    upsert: (...args) => viewOn(db).upsert(...args),
    remove: (...args) => viewOn(db).remove(...args),
    list: (...args) => viewOn(db).list(...args),
    count: (...args) => viewOn(db).count(...args),
    removeWhere: (...args) => viewOn(db).removeWhere(...args),
    countBy: (...args) => viewOn(db).countBy(...args),
    transaction: (fn) => viewOn(db).transaction(fn),
  };

  return adapter;
};
