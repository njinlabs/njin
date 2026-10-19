import { createHash } from "node:crypto";
import type { Engines } from "surrealdb";
import { createRemoteEngines, RecordId, Surreal, Table } from "surrealdb";
import type {
  AdapterCapabilities,
  Condition,
  CountBy,
  DbAdapter,
  DbOperations,
  ElementDef,
  FieldDef,
  ListQuery,
  ListResult,
  Row,
  SearchTarget,
  TableDef,
} from "../db/contract";

const REMOTE_SCHEMES = ["ws://", "wss://", "http://", "https://"];
const EMBEDDED_SCHEMES = ["mem://", "rocksdb://", "surrealkv://"];

export const isRemotePath = (path: string) =>
  REMOTE_SCHEMES.some((scheme) => path.startsWith(scheme));

// Added to the BM25 score of a field that truly contains the search string, so it outranks a
// document that only shares a few n-grams with it. Clears typical BM25 scores (~0-10); it does
// not need precise tuning.
const CONTAINMENT_BOOST = 100;

// `blank` tokenizer splits on whitespace only (unlike `class`, which also splits on
// punctuation: "Next.js" would become "next" / "." / "js", and a lone "." can't form any 2-char
// ngram, so a query for "next.js" — tokenized the same way — would never match). The `ngram`
// filter then indexes overlapping 3-10 char slices of each whitespace-delimited token so the
// `@N@` match operator finds a term anywhere inside a field and still tolerates minor typos.
// Minimum is 3, not 2: 2-char slices are common enough across unrelated documents to turn into
// near-universal noise on real-sized catalogs.
const SEARCH_ANALYZER = "njin_search";
// Single source of truth for the analyzer body — reused in the DEFINE and in schemaHash, so a
// change here invalidates the stored hash and re-runs the DEFINE on next boot.
const SEARCH_ANALYZER_DEFINITION =
  "TOKENIZERS blank FILTERS lowercase,ngram(3,10)";

// Records the hash of the last schema this DB was migrated to, so a worker booting against an
// already-migrated DB can skip every DEFINE below (each is a full network round trip). Keyed off
// the DB itself, not the process/build: a worker pointed at a fresh or different DB finds no
// matching record here and still runs the DEFINEs.
const SCHEMA_META_TABLE = "njin_schema_meta";

// Names end up in query text, so on top of the model layer's whitelist they must be plain
// identifiers.
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ident = (name: string) => {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Unsafe identifier: "${name}"`);
  }
  return name;
};

const int = (value: number, fallback: number) =>
  Number.isSafeInteger(value) && value > 0 ? value : fallback;

// A connection URL without its credentials, safe to print.
const redact = (value: string) => value.replace(/\/\/[^/@]*@/, "//");

export type SurrealAdapterConfig = {
  // rocksdb:// | surrealkv:// | mem:// (embedded) or ws:// | wss:// | http:// | https:// (remote)
  path?: string;
  namespace?: string;
  database?: string;
  // Root/system auth ({ username, password }) or a bearer token (string). Omit for an
  // anonymous connection — the only mode embedded engines support.
  auth?: { username: string; password: string } | string;
};

// SurrealDB returns links as RecordId and everything else as plain data. The contract wants
// plain string ids everywhere, so a RecordId becomes its bare id ("post:abc" -> "abc"); a
// populated link is already an object by then, with its own `id` converted the same way.
const fromDb = (value: unknown): unknown => {
  if (value instanceof RecordId) return String(value.id);
  if (Array.isArray(value)) return value.map(fromDb);
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fromDb(v)]),
    );
  }
  return value;
};

const toRow = (value: unknown): Row => fromDb(value) as Row;

// The reverse for writes: a relation field given as a plain id string (or array of them)
// becomes a RecordId pointing at its target table. Walks into object()/array() fields, since
// a link can sit inside them. `undefined` keys are dropped — "leave alone" in the contract.
type Shape = FieldDef | (ElementDef & { name?: undefined });

const linkOut = (shape: Shape, value: unknown): unknown => {
  if (value === null || value === undefined) return value;

  switch (shape.kind) {
    case "one":
      return typeof value === "string"
        ? new RecordId(shape.target, value)
        : value;
    case "many":
      return Array.isArray(value)
        ? value.map((v) =>
            typeof v === "string" ? new RecordId(shape.target, v) : v,
          )
        : value;
    case "object":
      return objectOut(shape.fields, value as Record<string, unknown>);
    case "array":
      return Array.isArray(value)
        ? value.map((v) => linkOut(shape.of, v))
        : value;
    default:
      return value;
  }
};

const objectOut = (
  fields: readonly FieldDef[],
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const field = byName.get(key);
    out[key] = field ? linkOut(field, value) : value;
  }
  return out;
};

const toDb = (table: TableDef, data: Record<string, unknown>) =>
  objectOut(table.fields, data);

type Params = Record<string, unknown>;

// Builds `WHERE ...` for a list of AND-ed conditions. Values are always bound as parameters;
// field names are validated as identifiers. The operator set is closed.
const buildWhere = (
  table: string,
  conditions: readonly Condition[] | undefined,
  params: Params,
  searchClause?: string,
  def?: TableDef,
) => {
  const parts: string[] = [];
  if (searchClause) parts.push(searchClause);

  (conditions ?? []).forEach((cond, i) => {
    const field = ident(cond.field);
    const p = `c${i}`;

    // `id` and the relation fields are record links on the Surreal side, not the bare
    // strings the contract speaks (a many link is matched with $in, one id at a time).
    const link = def?.fields.find((f) => f.name === cond.field);
    const value =
      typeof cond.value !== "string"
        ? cond.value
        : field === "id"
          ? new RecordId(table, cond.value)
          : link && (link.kind === "one" || link.kind === "many")
            ? new RecordId(link.target, cond.value)
            : cond.value;

    switch (cond.op) {
      case "$eq":
        params[p] = value;
        parts.push(`${field} = $${p}`);
        break;
      case "$ne":
        params[p] = value;
        parts.push(`${field} != $${p}`);
        break;
      case "$gt":
        params[p] = value;
        parts.push(`${field} > $${p}`);
        break;
      case "$gte":
        params[p] = value;
        parts.push(`${field} >= $${p}`);
        break;
      case "$lt":
        params[p] = value;
        parts.push(`${field} < $${p}`);
        break;
      case "$lte":
        params[p] = value;
        parts.push(`${field} <= $${p}`);
        break;
      case "$ieq":
        params[p] = String(value).toLowerCase();
        parts.push(`string::lowercase(${field}) = $${p}`);
        break;
      case "$contains":
        params[p] = String(value).toLowerCase();
        parts.push(`string::contains(string::lowercase(${field}), $${p})`);
        break;
      case "$startsWith":
        params[p] = String(value).toLowerCase();
        parts.push(`string::starts_with(string::lowercase(${field}), $${p})`);
        break;
      case "$in":
        params[p] = value;
        parts.push(`${field} CONTAINS $${p}`);
        break;
      default:
        throw new Error(`Unknown filter operator: "${cond.op}"`);
    }
  });

  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
};

const containmentCheck = (field: string) =>
  `string::contains(string::replace(string::lowercase(${field}), " ", ""), string::replace(string::lowercase($search), " ", ""))`;

// A search target is "flat" (a field on the table itself) or "via" a relation field (the text
// lives on the linked table, whose own index serves the match).
// Narrows a search through a table of languages to the language being read, if there is one.
const languageFilter = (target: SearchTarget, searchLocale?: string) =>
  target.perLanguage && searchLocale !== undefined
    ? ` AND ${ident(target.perLanguage.locale)} = $searchLocale`
    : "";

const searchClauses = (
  table: TableDef,
  targets: readonly SearchTarget[],
  searchLocale?: string,
) => {
  const multi = new Set(
    table.fields.filter((f) => f.kind === "many").map((f) => f.name),
  );

  const clauses = targets.map((t, i) => {
    const n = i + 1;
    const field = ident(t.field);
    if (!t.via) return `${field} @${n}@ $search`;

    const local = ident(t.via);
    const op = multi.has(local) ? "CONTAINSANY" : "IN";
    // A link into a table of languages: the rows hold the linked record's id (and a language).
    const key = t.perLanguage ? ident(t.perLanguage.key) : "id";
    const language = languageFilter(t, searchLocale);
    return `${local} ${op} (SELECT VALUE ${key} FROM ${ident(t.table)} WHERE ${field} @${n}@ $search${language})`;
  });

  // BM25 + containment boost per target. search::score(N) only works against a FULLTEXT index
  // on the table actually being queried, so a via-target's score is pulled back through a
  // correlated subquery on the linked record ($parent = the current outer row).
  const relevance = targets
    .map((t, i) => {
      const n = i + 1;
      const field = ident(t.field);
      const boost = `(IF ${containmentCheck(field)} THEN ${CONTAINMENT_BOOST} ELSE 0 END)`;
      if (!t.via) return `(search::score(${n}) + ${boost})`;

      const local = ident(t.via);
      const key = t.perLanguage ? ident(t.perLanguage.key) : "id";
      const idFilter = multi.has(local)
        ? `${key} IN $parent.${local}`
        : `${key} = $parent.${local}`;
      const language = languageFilter(t, searchLocale);
      return `math::sum((SELECT VALUE (search::score(${n}) + ${boost}) FROM ${ident(t.table)} WHERE ${idFilter}${language} AND ${field} @${n}@ $search))`;
    })
    .join(" + ");

  return { where: `(${clauses.join(" OR ")})`, relevance };
};

const capabilities: AdapterCapabilities = { search: "fuzzy" };

// Resolves the links of `fields` into whole rows, one query per relation field. Done here
// rather than with FETCH because FETCH turns a link whose target no longer exists into NONE;
// the contract wants such a link left as its raw id, so callers can tell it apart from a
// resolved one. Only top-level one()/many() fields populate, and only one level deep.
const populateRows = async (
  table: TableDef,
  rows: Row[],
  fields: readonly string[] | undefined,
  select: (target: string, ids: RecordId[]) => Promise<unknown[]>,
) => {
  for (const name of fields ?? []) {
    const field = table.fields.find((f) => f.name === name);
    if (!field || (field.kind !== "one" && field.kind !== "many")) continue;

    const wanted = new Set<string>();
    for (const row of rows) {
      const value = row[name];
      if (typeof value === "string") wanted.add(value);
      else if (Array.isArray(value)) {
        for (const v of value) if (typeof v === "string") wanted.add(v);
      }
    }
    if (!wanted.size) continue;

    const found = new Map<string, Row>();
    const targets = await select(
      field.target,
      [...wanted].map((id) => new RecordId(field.target, id)),
    );
    for (const t of targets) {
      const target = toRow(t);
      found.set(target.id, target);
    }

    const resolve = (v: unknown) =>
      typeof v === "string" ? (found.get(v) ?? v) : v;
    for (const row of rows) {
      const value = row[name];
      if (Array.isArray(value)) row[name] = value.map(resolve);
      else row[name] = resolve(value);
    }
  }

  return rows;
};

export const surrealAdapter = (
  config: SurrealAdapterConfig = {},
): DbAdapter => {
  const path = config.path ?? "rocksdb://data";
  const namespace = config.namespace ?? "general";
  const database = config.database ?? "general";
  let db: Surreal;

  const query = <T extends unknown[]>(sql: string, params?: Params) =>
    db.query<T>(sql, params);

  // What the data operations need from the connection — the Surreal client itself or a
  // transaction opened on it.
  type Queryable = Pick<
    Surreal,
    "select" | "create" | "update" | "upsert" | "delete" | "query"
  >;

  // The data operations on a given connection. Inside, `db` is that connection (it shadows the
  // client's), so the same code serves both.
  const operationsOn = (db: Queryable): Omit<DbOperations, "transaction"> => {
    const query = <T extends unknown[]>(sql: string, params?: Params) =>
      db.query<T>(sql, params);

    const byIds = async (target: string, ids: RecordId[]) => {
      const [rows] = await query<[unknown[]]>(
        `SELECT * FROM ${ident(target)} WHERE id IN $ids`,
        { ids },
      );
      return rows ?? [];
    };

    return {
      async find(table, id, opts) {
        const record = await db.select<Record<string, unknown>>(
          new RecordId(table.name, id),
        );
        if (!record) return null;

        const [row] = await populateRows(
          table,
          [toRow(record)],
          opts?.populate,
          byIds,
        );
        return row ?? null;
      },

      async insert(table, data, opts) {
        const target = opts?.id
          ? new RecordId(table.name, opts.id)
          : new Table(table.name);

        const created = await db
          .create<Record<string, unknown>>(target as RecordId)
          .content(toDb(table, data))
          .output("after");

        // create() on a Table returns an array, on a RecordId a single record.
        const record = Array.isArray(created) ? created[0] : created;
        return toRow(record);
      },

      async update(table, id, patch) {
        // MERGE deep-merges objects and replaces everything else (arrays included) — exactly
        // the contract's update() rules. On a missing record it returns undefined and does not
        // create one.
        const record = await db
          .update<Record<string, unknown>>(new RecordId(table.name, id))
          .merge(toDb(table, patch));

        return record ? toRow(record) : null;
      },

      async upsert(table, id, data) {
        const record = await db
          .upsert<Record<string, unknown>>(new RecordId(table.name, id))
          .merge(toDb(table, data))
          .output("after");

        return toRow(Array.isArray(record) ? record[0] : record);
      },

      async remove(table, id) {
        const record = await db.delete<Record<string, unknown>>(
          new RecordId(table.name, id),
        );
        return record ? toRow(record) : null;
      },

      async list(table, q: ListQuery): Promise<ListResult> {
        const params: Params = {};
        const name = ident(table.name);
        const limit = int(q.limit, 20);
        const page = int(q.page, 1);
        const start = (page - 1) * limit;

        const useSearch = Boolean(q.search?.trim()) && table.search.length > 0;
        let searchWhere: string | undefined;
        let relevance = "";
        if (useSearch) {
          params.search = q.search!.trim();
          if (q.searchLocale !== undefined)
            params.searchLocale = q.searchLocale;
          const built = searchClauses(table, table.search, q.searchLocale);
          searchWhere = built.where;
          relevance = built.relevance;
        }

        const where = buildWhere(name, q.where, params, searchWhere, table);

        // An explicit sort always wins; otherwise, when searching, rank by relevance. `ORDER BY`
        // only accepts a bare identifier here, so relevance is projected as an aliased field and
        // stripped back out of each row afterwards.
        const orderBy = q.sort
          ? `ORDER BY ${ident(q.sort.field)} ${q.sort.order === "desc" ? "DESC" : "ASC"}`
          : useSearch
            ? "ORDER BY __relevance DESC"
            : "";
        const relevanceSelect =
          useSearch && !q.sort ? `, (${relevance}) AS __relevance` : "";

        const flat = q.select?.fields ?? [];
        const nested = Object.entries(q.select?.nested ?? {});
        // SurrealDB rejects ORDER BY on a field that isn't in the selection, so a sort field the
        // caller didn't ask for is selected anyway and dropped from each row afterwards.
        const extra =
          (flat.length || nested.length) &&
          q.sort &&
          q.sort.field !== "id" &&
          !flat.includes(q.sort.field)
            ? [ident(q.sort.field)]
            : [];
        const projection =
          flat.length || nested.length
            ? [
                "id",
                ...[...flat, ...extra].filter((f) => f !== "id").map(ident),
                ...nested.map(
                  ([local, fields]) =>
                    `${ident(local)}.{${["id", ...fields.filter((f) => f !== "id")].map(ident).join(", ")}} AS ${ident(local)}`,
                ),
              ].join(", ")
            : "*";

        const nestedNames = new Set(nested.map(([local]) => local));

        const [rows, [countRow]] = await query<
          [Record<string, unknown>[], { count: number }[]]
        >(
          `SELECT ${projection}${relevanceSelect} FROM ${name} ${where} ${orderBy} LIMIT ${limit} START ${start};
         SELECT count() AS count FROM ${name} ${where} GROUP ALL`,
          params,
        );

        const out = (rows ?? []).map((row) => {
          const { __relevance, ...rest } = row;
          for (const key of extra) delete rest[key];
          return toRow(rest);
        });

        // A relation returned through a nested projection is already shaped; populating would
        // clobber it.
        const populate = q.populate.filter((f) => !nestedNames.has(f));

        return {
          rows: await populateRows(table, out, populate, byIds),
          total: countRow?.count ?? 0,
        };
      },

      async count(table, where) {
        const params: Params = {};
        const name = ident(table.name);
        const [rows] = await query<[{ count: number }[]]>(
          `SELECT count() AS count FROM ${name} ${buildWhere(name, where, params, undefined, table)} GROUP ALL`,
          params,
        );
        return rows?.[0]?.count ?? 0;
      },

      async removeWhere(table, where) {
        const params: Params = {};
        const name = ident(table.name);
        const [removed] = await query<[unknown[]]>(
          `DELETE ${name} ${buildWhere(name, where, params, undefined, table)} RETURN BEFORE`,
          params,
        );
        return removed?.length ?? 0;
      },

      async countBy(q: CountBy) {
        const params: Params = {};
        const name = ident(q.table);
        const field = ident(q.groupBy);
        const where = buildWhere(name, q.where, params);

        const key = q.prefix
          ? `string::slice(${field}, 0, ${int(q.prefix, 1)})`
          : field;
        const order = q.prefix ? "ORDER BY key ASC" : "ORDER BY count DESC";

        const [rows] = await query<[{ key?: string | null; count: number }[]]>(
          `SELECT ${key} AS key, count() AS count FROM ${name} ${where} GROUP BY key ${order}`,
          params,
        );
        return (rows ?? []).map((r) => ({
          key: r.key ?? null,
          count: r.count,
        }));
      },
    };
  };

  // A nested transaction() joins the one it runs in: SurrealDB has no savepoints.
  const inTransaction = (tx: Queryable): DbOperations => {
    const view: DbOperations = {
      ...operationsOn(tx),
      transaction: (fn) => fn(view),
    };
    return view;
  };

  const operations = (): DbOperations => ({
    ...operationsOn(db),
    transaction: async (fn) => {
      const tx = await db.beginTransaction();
      try {
        const result = await fn(inTransaction(tx));
        await tx.commit();
        return result;
      } catch (error) {
        await tx.cancel();
        throw error;
      }
    },
  });

  return {
    name: "surreal",
    capabilities,

    describe: () => `${redact(path)} (${namespace}/${database})`,

    async connect() {
      let engines: Engines;
      if (isRemotePath(path)) {
        engines = createRemoteEngines();
      } else if (EMBEDDED_SCHEMES.some((scheme) => path.startsWith(scheme))) {
        // Dynamically imported so a build with a remote path can leave @surrealdb/node out
        // entirely — its native binding loader runs eagerly on import, not on first use.
        const { createNodeEngines } = await import("@surrealdb/node");
        engines = createNodeEngines();
      } else {
        throw new Error(
          `Unrecognized db.path scheme: "${path}" — expected one of ${EMBEDDED_SCHEMES.join(", ")} (embedded) or ${REMOTE_SCHEMES.join(", ")} (remote)`,
        );
      }

      db = new Surreal({ engines });
      await db.connect(path, { authentication: config.auth });

      // Explicit DEFINE, not left to auto-create-on-USE — that only happens for a
      // root-authenticated connection. Needed when several njin instances share one remote
      // SurrealDB, each isolated into its own namespace. DEFINE DATABASE must run inside the
      // namespace it belongs to, hence the two-step USE.
      await db.query(`DEFINE NAMESPACE IF NOT EXISTS \`${namespace}\`;`);
      await db.use({ namespace });
      await db.query(`DEFINE DATABASE IF NOT EXISTS \`${database}\`;`);
      await db.use({ namespace, database });
    },

    async close() {
      await db.close();
    },

    async build(ctx) {
      // Imported through a variable so the bundler doesn't trace this build-only helper (and
      // the filesystem code in it) into an application's runtime bundle — it only ever runs
      // from source, inside the build commands.
      const helper = "./surreal_build";
      const { surrealBuild } = await import(helper);
      return surrealBuild(isRemotePath(path), ctx);
    },

    async sync(tables) {
      const names = new Set(tables.map((t) => ident(t.name)));

      // Where each search index lives: on the table itself for a flat target, on the linked
      // table for a via-target. Deduped, since two models can point at the same field.
      const indexes = new Map<string, { table: string; field: string }>();
      for (const table of tables) {
        for (const t of table.search) {
          indexes.set(`${t.table}.${t.field}`, {
            table: ident(t.table),
            field: ident(t.field),
          });
        }
      }

      const schemaHash = createHash("sha256")
        .update(
          JSON.stringify({
            tables: [...names].sort(),
            indexes: [...indexes.keys()].sort(),
            analyzer: SEARCH_ANALYZER_DEFINITION,
          }),
        )
        .digest("hex");

      // Must be DEFINE'd before the SELECT below can even run: a table SurrealDB has never
      // seen DEFINE'd makes ANY query against a specific record id in it throw NotFoundError.
      await query(
        `DEFINE TABLE IF NOT EXISTS ${SCHEMA_META_TABLE} SCHEMALESS;`,
      );

      const [rows] = await query<[{ hash: string }[]]>(
        `SELECT hash FROM ${SCHEMA_META_TABLE}:current;`,
      );
      if (rows?.[0]?.hash === schemaHash) return;

      // Every table is defined up front: `GROUP ALL` (count queries) throws NotFoundError on
      // a table that has never had a row, unlike plain SELECT.
      for (const name of names) {
        await query(`DEFINE TABLE IF NOT EXISTS ${name} SCHEMALESS;`);
      }

      // OVERWRITE, not IF NOT EXISTS — this only runs when schemaHash just changed, so an
      // existing analyzer/index under this name is stale and needs replacing, not skipping.
      // FULLTEXT, not SEARCH — this SurrealDB version renamed the index-type keyword.
      await query(
        `DEFINE ANALYZER OVERWRITE ${SEARCH_ANALYZER} ${SEARCH_ANALYZER_DEFINITION};`,
      );

      for (const { table, field } of indexes.values()) {
        await query(
          `DEFINE INDEX OVERWRITE idx_search_${table}_${field} ON TABLE ${table} FIELDS ${field} FULLTEXT ANALYZER ${SEARCH_ANALYZER} BM25 HIGHLIGHTS;`,
        );
      }

      await query(`UPSERT ${SCHEMA_META_TABLE}:current SET hash = $hash;`, {
        hash: schemaHash,
      });
    },

    // The client is created in connect(), so the connection is looked up per call.
    find: (...args) => operations().find(...args),
    insert: (...args) => operations().insert(...args),
    update: (...args) => operations().update(...args),
    upsert: (...args) => operations().upsert(...args),
    remove: (...args) => operations().remove(...args),
    list: (...args) => operations().list(...args),
    count: (...args) => operations().count(...args),
    removeWhere: (...args) => operations().removeWhere(...args),
    countBy: (...args) => operations().countBy(...args),
    transaction: (fn) => operations().transaction(fn),
  };
};

export default surrealAdapter;
