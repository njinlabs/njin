import type { ScalarType } from "../../../db/contract";
import { run, type SQL, sql } from "../builder";
import type { Dialect } from "../dialect";

// PostgreSQL. Datetimes are timestamptz, JSON is jsonb, and search is typo-tolerant when the
// pg_trgm extension can be created.

const COLUMN_TYPE: Record<ScalarType, string> = {
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

// Fuzzy matches below this trigram similarity are not results.
const SIMILARITY_THRESHOLD = 0.5;

export const postgresDialect: Dialect = {
  name: "postgres",

  columnType: (type) => COLUMN_TYPE[type],
  sameType: (type, actual) => DATA_TYPE[type] === actual,
  retypeHint: (table, column, type) =>
    `ALTER TABLE ${table} ALTER COLUMN "${column}" TYPE ${COLUMN_TYPE[type]} USING "${column}"::${COLUMN_TYPE[type]};`,

  encode(type, value): SQL {
    switch (type) {
      case "datetime":
        return sql`${value}::text::timestamptz`;
      case "json":
        // Sent as plain text and converted by the server: a parameter the server types as jsonb
        // is serialised again by some drivers (Bun's), turning the JSON into a quoted string.
        return sql`${value}::text::jsonb`;
      default:
        return sql`${value}`;
    }
  },
  // ISO-8601 in UTC with milliseconds — the one shape every driver returns datetimes in.
  iso: (ref) =>
    sql`to_char(${ref} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  jsonText: (ref) => sql`${ref}::text`,
  text: (ref, type) =>
    type === "datetime" ? postgresDialect.iso(ref) : sql`${ref}::text`,
  distinct: (a, b) => sql`${a} is distinct from ${b}`,
  ilike: (text, pattern) => sql`${text} ilike ${pattern} escape '!'`,

  transactionalDdl: true,
  deleteReturning: true,
  rowLock: sql`for update`,
  indexIfNotExists: true,

  // Serialises schema changes across processes (njin runs several workers against one database).
  async lock(tx, name) {
    await run(tx, sql`select pg_advisory_xact_lock(hashtext(${name}))`);
    return async () => {};
  },

  async columns(x, schema) {
    const rows = await run(
      x,
      sql`select table_name, column_name, data_type from information_schema.columns where table_schema = ${schema ?? sql`current_schema()`}`,
    );
    return new Map(
      rows.map((r) => [
        `${r.table_name}.${r.column_name}`,
        String(r.data_type),
      ]),
    );
  },

  async documentDefault(x, table, column) {
    await run(
      x,
      sql`alter table ${table} alter column ${sql.identifier(column)} set default '{}'::jsonb`,
    );
  },

  fuzzy: {
    enable: async (tx) => {
      await run(tx, sql`create extension if not exists pg_trgm`);
    },
    match: (ref, query) =>
      sql`word_similarity(${query}, ${ref}) >= ${SIMILARITY_THRESHOLD}`,
    score: (ref, query) => sql`word_similarity(${query}, ${ref})`,
    index: (name, table, column) =>
      sql`create index if not exists ${sql.identifier(name)} on ${table} using gin (${sql.identifier(column)} gin_trgm_ops)`,
  },
};
