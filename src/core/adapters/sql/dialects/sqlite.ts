import type { ScalarType } from "../../../db/contract";
import { run, sql } from "../builder";
import type { Dialect } from "../dialect";

// SQLite. It has no datetime, boolean or JSON type of its own, so those are stored the way the
// adapter hands them out: datetimes as ISO-8601 text in UTC (which sorts and compares correctly
// as text), booleans as 0/1, JSON as text.
//
// Search is the plain "contains, ignoring case and spaces" match: SQLite's own lower() and LIKE
// fold case for ASCII only, so "É" and "é" are different letters here.

const COLUMN_TYPE: Record<ScalarType, string> = {
  string: "text",
  number: "real",
  boolean: "integer",
  datetime: "text",
  json: "text",
};

export const sqliteDialect: Dialect = {
  name: "sqlite",

  columnType: (type) => COLUMN_TYPE[type],
  sameType: (type, actual) => COLUMN_TYPE[type] === actual.toLowerCase(),
  retypeHint: (table, column, type) =>
    `SQLite cannot change a column's type in place — rebuild ${table} with "${column}" as ${COLUMN_TYPE[type]}.`,

  encode: (type, value) =>
    type === "boolean" ? sql`${value ? 1 : 0}` : sql`${value}`,
  iso: (ref) => ref,
  jsonText: (ref) => ref,
  text: (ref, type) =>
    type === "boolean"
      ? sql`case when ${ref} is null then null when ${ref} then 'true' else 'false' end`
      : type === "datetime"
        ? ref
        : sql`cast(${ref} as text)`,
  distinct: (a, b) => sql`${a} is not ${b}`,
  ilike: (text, pattern) =>
    sql`lower(${text}) like ${pattern.toLowerCase()} escape '!'`,

  transactionalDdl: true,
  deleteReturning: true,
  rowLock: sql``,
  indexIfNotExists: true,

  // The client's transactions are BEGIN IMMEDIATE: the write lock is already held.
  lock: async () => async () => {},

  async columns(x) {
    const rows = await run(
      x,
      sql`select m."name" as "t", p."name" as "c", p."type" as "d" from "sqlite_master" as m, pragma_table_info(m."name") as p where m."type" = 'table'`,
    );
    return new Map(rows.map((r) => [`${r.t}.${r.c}`, String(r.d)]));
  },
};
