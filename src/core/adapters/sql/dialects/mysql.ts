import type { ScalarType } from "../../../db/contract";
import { run, sql } from "../builder";
import type { Dialect } from "../dialect";

// MySQL and MariaDB — one driver and nearly one dialect.
//
// Every table is utf8mb4 with the binary collation, because MySQL's default collations compare
// case- and accent-insensitively, which would make `=`, unique columns and primary keys disagree
// with every other database njin runs on. A column that is a key (primary, indexed, unique) is
// a bounded varchar, as MySQL cannot index an unbounded text column; any other string is
// longtext.
//
// DDL commits implicitly in MySQL, so a migration is not atomic here (each statement is
// idempotent, and the next boot finishes what a crashed one started).
//
// Search is the plain "contains, ignoring case and spaces" match: FULLTEXT is word-based and
// has no typo tolerance, so it would be a different feature, not a better version of this one.

const KEY_LENGTH = 255;

const COLUMN_TYPE: Record<ScalarType, string> = {
  string: "longtext",
  number: "double",
  boolean: "boolean",
  datetime: "datetime(3)",
  json: "json",
};

// What information_schema reports for each of the above.
const DATA_TYPES: Record<ScalarType, readonly string[]> = {
  string: ["varchar", "text", "mediumtext", "longtext", "tinytext"],
  number: ["double"],
  boolean: ["tinyint"],
  datetime: ["datetime", "timestamp"],
  // MariaDB's json is an alias of longtext.
  json: ["json", "longtext"],
};

export const mysqlDialect = (mariadb: boolean): Dialect => {
  const schemaOf = (schema?: string) => schema ?? sql`database()`;

  const dialect: Dialect = {
    name: mariadb ? "mariadb" : "mysql",

    columnType: (type, key) =>
      type === "string" && key ? `varchar(${KEY_LENGTH})` : COLUMN_TYPE[type],
    sameType: (type, actual) => DATA_TYPES[type].includes(actual.toLowerCase()),
    retypeHint: (table, column, type) =>
      `ALTER TABLE ${table.replaceAll('"', "`")} MODIFY \`${column}\` ${COLUMN_TYPE[type]};`,
    tableOptions: sql` default charset utf8mb4 collate utf8mb4_bin`,

    encode(type, value) {
      switch (type) {
        case "boolean":
          return sql`${value ? 1 : 0}`;
        case "datetime": {
          // 2026-01-02T03:04:05.678Z -> 2026-01-02 03:04:05.678 (the column holds UTC).
          const iso = value as string;
          return sql`${`${iso.slice(0, 10)} ${iso.slice(11, 23)}`}`;
        }
        default:
          return sql`${value}`;
      }
    },
    iso: (ref) =>
      sql`concat(date_format(${ref}, '%Y-%m-%dT%H:%i:%s.'), lpad(floor(microsecond(${ref}) / 1000), 3, '0'), 'Z')`,
    jsonText: (ref) => sql`cast(${ref} as char)`,
    text: (ref, type) =>
      type === "boolean"
        ? sql`case when ${ref} is null then null when ${ref} then 'true' else 'false' end`
        : type === "datetime"
          ? dialect.iso(ref)
          : sql`cast(${ref} as char)`,
    distinct: (a, b) => sql`not (${a} <=> ${b})`,
    ilike: (text, pattern) =>
      sql`lower(${text}) like ${pattern.toLowerCase()} escape '!'`,

    caseInsensitiveNames: true,
    transactionalDdl: false,
    deleteReturning: mariadb,
    rowLock: sql`for update`,
    indexIfNotExists: false,

    // A named lock held by this connection; the migration's transaction keeps its connection
    // for the whole migration (DDL commits the transaction but not the connection).
    async lock(tx, name) {
      const [got] = await run(tx, sql`select get_lock(${name}, 60) as "got"`);
      if (Number(got?.got) !== 1) {
        throw new Error("Timed out waiting for another process to migrate");
      }
      return async () => {
        await run(tx, sql`select release_lock(${name}) as "released"`);
      };
    },

    async columns(x, schema) {
      const rows = await run(
        x,
        sql`select table_name as "t", column_name as "c", data_type as "d" from information_schema.columns where table_schema = ${schemaOf(schema)}`,
      );
      return new Map(rows.map((r) => [`${r.t}.${r.c}`, String(r.d)]));
    },

    async indexes(x, schema) {
      const rows = await run(
        x,
        sql`select distinct table_name as "t", index_name as "i" from information_schema.statistics where table_schema = ${schemaOf(schema)}`,
      );
      return new Set(rows.map((r) => `${r.t}.${r.i}`));
    },
  };

  return dialect;
};
