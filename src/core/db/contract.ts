// The contract every database adapter implements. Core code (core/model, core/vars,
// modules/*) only ever talks to the database through this interface, via db().

import type { BunPlugin } from "bun";
//
// Design rules:
// - The model layer (core/model) owns validation, hooks, unique checks, timestamps, and the
//   whitelisting/coercion of field names, filters, sort and select. An adapter only ever
//   receives values that were already validated against a TableDef, but must still bind
//   values as parameters and quote identifiers — never interpolate raw input.
// - `id` is always a plain string, on the way in and on the way out. No driver types
//   (RecordId, ObjectId, bigint, ...) cross this boundary.
// - Timestamps (`createdAt`/`updatedAt`) are ISO-8601 strings set by the model layer; an
//   adapter stores and returns them as given.

// ---------------------------------------------------------------------------------------
// Schema description (what `sync()` receives)
// ---------------------------------------------------------------------------------------

// The schema is described structurally, all the way down: array() and object() keep their
// inner shape here instead of collapsing into an opaque blob, so a SQL adapter can turn them
// into real columns / child tables that stay queryable. How a structure is laid out
// physically is the adapter's decision (a document DB stores it nested as-is); the contract
// only fixes what a row looks like going in and coming out.
//
// "json" is a last resort for Zod types with no fixed shape (z.any(), z.record(), unions
// of different shapes). array() and object() never use it.
export type ScalarType = "string" | "number" | "boolean" | "datetime" | "json";

export type ScalarField = {
  kind: "scalar";
  name: string;
  type: ScalarType;
  // select() fields: the allowed values (an adapter may enforce it or ignore it).
  options?: readonly string[];
  unique?: boolean;
};

// relation() and file(): a single link to a row of `target`. Stored as the target's id.
export type OneField = { kind: "one"; name: string; target: string };

// relationMany() and multiFile(): an ordered list of links to rows of `target`.
// Order must be preserved. A SQL adapter models this as a pivot table.
export type ManyField = { kind: "many"; name: string; target: string };

// object(): a fixed set of named sub-fields, exactly one per row (one-to-one). Comes back
// as a nested object. A SQL adapter can flatten it into columns on the parent row.
export type ObjectField = {
  kind: "object";
  name: string;
  fields: readonly FieldDef[];
};

// array(): zero or more elements per row (one-to-many), order preserved. The element is
// described like a field, minus its own name: a scalar (array of strings), an object (array
// of {sku, qty}), a relation, or another array. Comes back as a plain array. A SQL adapter
// models it as a child table (parent id, position, element columns).
export type ElementDef =
  | Omit<ScalarField, "name" | "unique">
  | Omit<OneField, "name">
  | Omit<ObjectField, "name">
  | Omit<ArrayField, "name">;

export type ArrayField = { kind: "array"; name: string; of: ElementDef };

export type FieldDef =
  | ScalarField
  | OneField
  | ManyField
  | ObjectField
  | ArrayField;

// A full-text search target. `via` is set for a single-hop nested entry ("author.name"
// -> { field: "name", via: "author" }), in which case `field` lives on the linked table.
//
// `perLanguage` is for a link into a table with one row per record and language: `table` is
// that table, the linked record's id is in its `key` column and the language in its `locale`
// column, so the text is matched on the rows whose `key` is what the link points at — all of
// them, or only those of `ListQuery.searchLocale` when it is given.
export type SearchTarget = {
  table: string;
  field: string;
  via?: string;
  perLanguage?: { key: string; locale: string };
};

export type TableDef = {
  // Physical table name == model prefix.
  name: string;
  fields: readonly FieldDef[];
  search: readonly SearchTarget[];
  // A free-form document table: rows hold arbitrary top-level keys that are not declared in
  // `fields` (njin's VARS groups, whose shape differs per group but share one table). An
  // adapter with fixed columns keeps the undeclared keys together in a single JSON column;
  // one with native documents stores them as given. Such a table is only ever read and
  // written by id — no filtering, sorting or search on the undeclared keys.
  document?: boolean;
};

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

// createdAt/updatedAt are whatever the caller stored: the model layer always sets both, but
// some internal tables (oauth_code, vars) carry only one or neither.
export type Row = {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  [field: string]: unknown;
};

// How a relation field looks on a returned row:
// - populated:   OneField  -> Row | null     ManyField -> Row[]
// - unpopulated: OneField  -> string | null  ManyField -> string[]   (the raw ids)
// A link whose target no longer exists is left as its raw id even when populating, so
// callers (e.g. the MCP "_warnings" check) can tell "resolved" (object) from "dangling"
// (string). On write, a relation field is always given as plain id string(s).

// ---------------------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------------------

export type FilterOperator =
  | "$eq"
  | "$ne"
  | "$gt"
  | "$gte"
  | "$lt"
  | "$lte"
  | "$contains" // case-insensitive substring
  | "$startsWith" // case-insensitive prefix
  | "$in" // array field contains the value (njin's existing meaning: `field CONTAINS value`)
  | "$ieq"; // case-insensitive equality (e.g. email lookup)

export type FilterScalar = string | number | boolean;

// `field` is a top-level field, or "id" / "createdAt" / "updatedAt". Filtering inside an
// object() or array() element (dotted paths) is not supported yet — today's model layer
// only filters on top-level fields, and the contract keeps it that way until it's needed.
// Conditions in one list are AND-ed.
export type Condition = {
  field: string;
  op: FilterOperator;
  value: FilterScalar;
};

export type ListQuery = {
  where?: readonly Condition[];
  // Free-text query. How it is matched and ranked is the adapter's own business (see
  // `capabilities.search`); the only guarantees are: it only matches against the table's
  // `search` targets, and when no explicit `sort` is given, results are ordered best-first.
  search?: string;
  // Matches a `perLanguage` search target on this language only. Without it every language
  // counts.
  searchLocale?: string;
  sort?: { field: string; order: "asc" | "desc" };
  page: number; // 1-based
  limit: number;
  // Projection. Omit for the full row. `id` is always included. `nested` picks fields of
  // a linked row ("author.name"); a relation listed there is returned as `{ id, ...fields }`
  // (an array of those for a ManyField) and is not populated further.
  select?: {
    fields: readonly string[];
    nested: Readonly<Record<string, readonly string[]>>;
  };
  // Relation fields to populate whole. Others come back as raw ids.
  populate: readonly string[];
};

// A row as returned by list(): with a `select` projection only the picked fields (plus `id`)
// are present, so createdAt/updatedAt can't be promised.
export type PartialRow = { id: string; [field: string]: unknown };

export type ListResult = { rows: PartialRow[]; total: number };

// ---------------------------------------------------------------------------------------
// Aggregates (analytics)
// ---------------------------------------------------------------------------------------

export type CountBy = {
  table: string;
  where?: readonly Condition[];
  // Group on this scalar field, or on its first `prefix` characters (time buckets over an
  // ISO string: 10 = day, 7 = month, ...). Result is sorted by `count` desc, or by the key
  // asc when `prefix` is given.
  groupBy: string;
  prefix?: number;
};

// ---------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------

export type AdapterCapabilities = {
  // "none":  `search` is ignored.
  // "basic": tokenised / substring match.
  // "fuzzy": substring + typo tolerance + relevance ranking.
  search: "none" | "basic" | "fuzzy";
  // True when the database enforces links (foreign keys): writing a link to a row that does
  // not exist throws LinkTargetMissingError, deleting a row clears the one() links pointing at
  // it (null) and drops it from many() lists, and deleting a row deletes its array / many rows.
  // Without it a link to a missing row is stored as given and comes back as its raw id.
  referentialIntegrity?: boolean;
};

// Thrown by an adapter with `referentialIntegrity` when a write links to a row that does not
// exist. Carries no values — only the constraint name, when the database reports one.
export class LinkTargetMissingError extends Error {
  constructor(public readonly constraint?: string) {
    super("A linked record does not exist");
    this.name = "LinkTargetMissingError";
  }
}

// What an adapter tells `njin build` / `njin build:worker` it needs, so the build commands never
// have to know which database is in use.
export type AdapterBuildContext = {
  // "compile": a standalone executable (njin build) — anything not bundled must be shipped
  // next to it. "worker": a bundle that runs from inside the project tree (njin build:worker),
  // where node_modules is always reachable.
  target: "compile" | "worker";
  // The build output directory; files the adapter must ship go under it.
  outDir: string;
  log: (message: string) => void;
};

export type AdapterBuild = {
  // Packages to leave out of the bundle (a native driver that can't be bundled, or one that is
  // unreachable for this configuration).
  external?: readonly string[];
  plugins?: readonly BunPlugin[];
  // Reminders printed at the end of a successful build ("out/bindings/ must ship with ...").
  notes?: readonly string[];
};

// Reading and writing rows. Everything a transaction() callback gets, and what DbAdapter adds
// the connection lifecycle to.
export interface DbOperations {
  // Runs `fn` as one unit: every write it makes through the `tx` it is handed is kept if
  // `fn` resolves and undone if it throws (the error is rethrown). Reads through `tx` see the
  // transaction's own writes; nobody else sees them before it commits.
  //
  // Use only `tx` inside `fn` — a call on the adapter itself is outside the transaction (and on
  // SQLite waits for it to finish). Calling `tx.transaction()` nests inside the same
  // transaction; if the inner function throws and the outer one carries on, the inner writes
  // may or may not be kept (a SQL adapter rolls them back to a savepoint, SurrealDB does not).
  //
  // Keep it short: it holds locks. Don't do slow work (HTTP calls, file uploads) inside.
  transaction<T>(fn: (tx: DbOperations) => Promise<T>): Promise<T>;

  // --- single rows (id is always a plain string) ------------------------------------
  find(
    table: TableDef,
    id: string,
    opts?: { populate?: readonly string[] },
  ): Promise<Row | null>;

  // Fails if `opts.id` is given and already taken. Without it the adapter generates the id.
  insert(
    table: TableDef,
    data: Record<string, unknown>,
    opts?: { id?: string },
  ): Promise<Row>;

  // Partial update (what PUT /:id does today). Only the top-level keys present in `patch`
  // change, and they change like this:
  //   scalar / one / many / array  -> the value is replaced as a whole (an array or a many
  //                                   link list is NOT merged element by element)
  //   object                       -> merged key by key, recursively: { seo: { title } }
  //                                   leaves seo.description untouched
  // `undefined` means "leave alone"; `null` clears. Returns null when the row doesn't exist.
  update(
    table: TableDef,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Row | null>;

  // Insert-or-patch at a fixed id (vars, oauth codes, ...): creates the row if missing,
  // otherwise applies the same rules as update().
  upsert(
    table: TableDef,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Row>;

  // Returns the removed row (or null) so callers can clean up attached files.
  remove(table: TableDef, id: string): Promise<Row | null>;

  // --- sets --------------------------------------------------------------------------
  list(table: TableDef, query: ListQuery): Promise<ListResult>;
  count(table: TableDef, where?: readonly Condition[]): Promise<number>;
  removeWhere(table: TableDef, where: readonly Condition[]): Promise<number>;
  countBy(query: CountBy): Promise<{ key: string | null; count: number }[]>;
}

export interface DbAdapter extends DbOperations {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  // A one-line, human-readable summary for the startup banner ("localhost:5432/app (public)").
  // Must not contain credentials. Falls back to `name` when an adapter has nothing to add.
  describe?(): string;

  // Connect. Called once from the db module's init(), before anything else.
  connect(): Promise<void>;
  close(): Promise<void>;

  // Build-time needs: native bindings to copy, packages to keep external, bundler patches.
  // Optional — an adapter on a pure-JS driver has nothing to say. Called by the build commands
  // with the project's config already loaded, so the adapter can look at its own settings
  // (e.g. embedded vs remote).
  build?(
    ctx: AdapterBuildContext,
  ): Promise<AdapterBuild | void> | AdapterBuild | void;

  // Create / update structures so every table in `tables` exists with matching columns,
  // pivots, indexes. Idempotent and cheap when nothing changed. Must be additive by
  // default (never drop data); destructive changes are opt-in on the adapter's own config.
  sync(tables: readonly TableDef[]): Promise<void>;
}
