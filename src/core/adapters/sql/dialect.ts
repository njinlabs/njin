import type { ScalarType } from "../../db/contract";
import type { SQL, SqlClient } from "./builder";

// Everything that differs between SQL databases, so ./adapter.ts can be one implementation of the
// DbAdapter contract for all of them. A dialect only produces SQL fragments and answers a few
// questions; it never touches the layout (./plan.ts) or the contract semantics.
//
// The same safety rule as ./builder.ts applies: a dialect writes statement text in its own
// source and passes every value as a parameter.

export type Dialect = {
  // The adapter's name ("postgres", "sqlite", "mysql", "mariadb").
  readonly name: string;

  // ---- types ----------------------------------------------------------------------------

  // The column type for a scalar. `key` is true for a column that is a primary key, indexed or
  // unique — MySQL cannot index an unbounded text column, so it gets a bounded type there.
  columnType(type: ScalarType, key: boolean): string;
  // Whether a column the database already has (as it reports its type) satisfies `type`.
  sameType(type: ScalarType, actual: string): boolean;
  // What to tell the user to run to convert a column by hand.
  retypeHint(table: string, column: string, type: ScalarType): string;
  // Appended to every CREATE TABLE (a character set, a collation, an engine).
  readonly tableOptions?: SQL;

  // ---- values ---------------------------------------------------------------------------

  // A value as a bound parameter (or an expression around one) for a column of this type. It
  // arrives validated: a string, a finite number, a boolean, an ISO-8601 datetime (UTC, with
  // milliseconds) or JSON text.
  encode(type: ScalarType, value: unknown): SQL;
  // A datetime column as an ISO-8601 string in UTC with milliseconds: 2026-01-02T03:04:05.678Z.
  iso(ref: SQL): SQL;
  // A json column as its JSON text.
  jsonText(ref: SQL): SQL;
  // Any value as text, for pattern matching and grouping. Booleans read "true" / "false" and
  // datetimes are ISO-8601, whatever the database stores.
  text(ref: SQL, type: ScalarType): SQL;
  // `a` is not equal to `b`, where NULL counts as a value (so NULL differs from 'x').
  distinct(a: SQL, b: SQL): SQL;
  // A case-insensitive substring/prefix match; `pattern` is already a LIKE pattern escaped with
  // '!' (see escapeLike).
  ilike(text: SQL, pattern: string): SQL;

  // Whether the database compares table, column and index names without regard to case.
  readonly caseInsensitiveNames?: boolean;

  // ---- statements -----------------------------------------------------------------------

  // Whether a failed statement inside a transaction can be rolled back on its own, and whether
  // a whole migration is atomic. False for MySQL, which commits implicitly on every DDL.
  readonly transactionalDdl: boolean;
  // DELETE ... RETURNING. Without it the adapter selects the ids first.
  readonly deleteReturning: boolean;
  // Appended to a SELECT whose row is about to be changed in the same transaction.
  readonly rowLock: SQL;
  // CREATE INDEX IF NOT EXISTS. Without it the adapter checks `indexes()` first.
  readonly indexIfNotExists: boolean;

  // ---- migration ------------------------------------------------------------------------

  // Takes the cross-process schema lock inside the migration's transaction and returns what
  // releases it. njin runs several workers against one database; they must take turns.
  lock(tx: SqlClient, name: string): Promise<() => Promise<void>>;
  // Every column of every table in the schema: "table.column" -> the type the database reports.
  columns(x: SqlClient, schema?: string): Promise<Map<string, string>>;
  // How foreign keys get into the schema. "alter": ADD CONSTRAINT once every table exists
  // (Postgres, MySQL — a table must exist before it can be referenced). "inline": inside
  // CREATE TABLE (SQLite cannot add a constraint to a table that already exists, so a table
  // created before foreign keys existed stays without them).
  readonly foreignKeys: "alter" | "inline";
  // Every foreign key constraint, as "table.constraint". Needed for "alter" so a migration
  // can be repeated.
  foreignKeyNames?(x: SqlClient, schema?: string): Promise<Set<string>>;
  // Adds a constraint without checking the rows already there — the fallback when existing
  // data links to rows that are gone (the constraint then only guards new writes). Absent: the
  // constraint is skipped with a warning.
  addUncheckedForeignKey?(x: SqlClient, statement: SQL): Promise<void>;
  // Every index name, as "table.index". Only needed when !indexIfNotExists.
  indexes?(x: SqlClient, schema?: string): Promise<Set<string>>;
  // Gives the JSON column of a free-form document table a default of {}, where the database
  // allows it.
  documentDefault?(x: SqlClient, table: SQL, column: string): Promise<void>;

  // ---- search ---------------------------------------------------------------------------

  // A native typo-tolerant search (Postgres: pg_trgm), used when the database has it and lets
  // it be enabled. Without it the adapter counts shared trigrams in plain SQL, which every
  // dialect supports, so search is fuzzy everywhere.
  readonly fuzzy?: {
    // Enables the feature; rejects when it is unavailable (the adapter then falls back).
    enable(tx: SqlClient): Promise<void>;
    match(ref: SQL, query: string): SQL;
    // A rank: higher is a better match.
    score(ref: SQL, query: string): SQL;
    // An index statement that speeds `match` up, for a text column.
    index(name: string, table: SQL, column: string): SQL;
  };
};
