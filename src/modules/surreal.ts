import { createHash } from "node:crypto";
import { getConfig } from "../core/config";
import { resolveSearchPlan } from "../core/model";
import { makeModule } from "../core/module";
import { Surreal, createRemoteEngines } from "surrealdb";
import type { Engines } from "surrealdb";
import type { z } from "zod";

const REMOTE_SCHEMES = ["ws://", "wss://", "http://", "https://"];
const EMBEDDED_SCHEMES = ["mem://", "rocksdb://", "surrealkv://"];

export const isRemotePath = (path: string) => REMOTE_SCHEMES.some((scheme) => path.startsWith(scheme));

// Shared by every model's search index (see ../core/model/index.ts's read()) — `blank`
// tokenizer splits on whitespace only (unlike `class`, which also splits on punctuation:
// "Next.js" would become "next" / "." / "js", and a lone "." can't form any 2-char ngram,
// so a query for "next.js" — tokenized the same way — would never match). The `ngram`
// filter then indexes overlapping 2-10 char slices of each whitespace-delimited token so
// the `@N@` match operator can find a term anywhere inside a field (not just a whole-field
// match) and still tolerate minor typos, similar to trigram search.
const SEARCH_ANALYZER = "njin_search";

// Records the hash of the last schema this DB was migrated to, so a worker booting against
// an already-migrated DB (idle-evict/crash respawn — every DEFINE below is idempotent but
// still a full network round trip per statement) can skip straight past ensureTables(). Keyed
// off the DB itself rather than the process/build: a worker pointed at a fresh or different DB
// (e.g. a per-client env change) finds no matching record here and still runs the DEFINEs.
const SCHEMA_META_TABLE = "njin_schema_meta";

// SurrealDB's `GROUP ALL` aggregate (used for count queries) throws NotFoundError
// on a table that has never had a row created, unlike plain SELECT. Defining every
// table up front avoids that first-run failure (e.g. /api/setup/status before any user exists).
const ensureTables = async (db: Surreal) => {
  const { default: userModel } = await import("../models/user");
  const { default: fileModel } = await import("../models/file");

  const models: { prefix: string; searchFields?: string[]; validation?: z.ZodObject }[] = [userModel, fileModel];

  for (const factory of getConfig().models) {
    const { default: model } = await factory();
    models.push(model);
  }

  const prefixes = new Set<string>(models.map((model) => model.prefix));
  prefixes.add("vars");

  // Resolve every search index's target table+field up front (also dedupes prefix+field in
  // case two factories share a prefix, or a nested reference targets an already-indexed
  // field) — needed both to compute the schema hash below and to drive the DEFINE INDEX loop
  // further down.
  const searchIndexes = new Map<string, { prefix: string; field: string }>();
  for (const model of models) {
    // A nested searchFields entry (e.g. "author.name") needs its index defined on the
    // *target* table/field instead — the local relation field holds a record link, not
    // text. model.validation carries the schema needed to resolve that; if it's missing for
    // some reason, fall back to treating every entry as flat (today's behavior) rather than
    // throwing here — an authoring bug in a dotted entry is makeModel()'s job to catch, not
    // table setup's.
    const plan = model.validation
      ? resolveSearchPlan(model.validation, model.searchFields ?? [], model.prefix)
      : (model.searchFields ?? []).map((field) => ({ kind: "flat" as const, field }));

    for (const entry of plan) {
      const target =
        entry.kind === "flat"
          ? { prefix: model.prefix, field: entry.field }
          : { prefix: entry.targetPrefix, field: entry.targetField };
      searchIndexes.set(`${target.prefix}.${target.field}`, target);
    }
  }

  const schemaHash = createHash("sha256")
    .update(JSON.stringify({ prefixes: [...prefixes].sort(), searchIndexes: [...searchIndexes.keys()].sort() }))
    .digest("hex");

  // Must be DEFINE'd before the SELECT below can even run — unlike a table that exists but
  // has no rows (see the GROUP ALL note above), a table SurrealDB has never seen DEFINE'd at
  // all makes ANY query against a specific record id in it throw NotFoundError, plain SELECT
  // included. One extra round trip on every boot (skip path too), still far cheaper than the
  // N DEFINEs it's gating.
  await db.query(`DEFINE TABLE IF NOT EXISTS ${SCHEMA_META_TABLE} SCHEMALESS;`);

  const [rows] = await db.query<[{ hash: string }[]]>(`SELECT hash FROM ${SCHEMA_META_TABLE}:current;`);
  if (rows?.[0]?.hash === schemaHash) return;

  for (const prefix of prefixes) {
    await db.query(`DEFINE TABLE IF NOT EXISTS ${prefix} SCHEMALESS;`);
  }

  await db.query(`DEFINE ANALYZER IF NOT EXISTS ${SEARCH_ANALYZER} TOKENIZERS blank FILTERS lowercase,ngram(2,10);`);

  for (const { prefix: targetPrefix, field } of searchIndexes.values()) {
    // FULLTEXT, not SEARCH — this SurrealDB version renamed the index-type keyword;
    // SEARCH ANALYZER ... is a parse error here even though older docs/examples use it.
    await db.query(
      `DEFINE INDEX IF NOT EXISTS idx_search_${targetPrefix}_${field} ON TABLE ${targetPrefix} FIELDS ${field} FULLTEXT ANALYZER ${SEARCH_ANALYZER} BM25 HIGHLIGHTS;`,
    );
  }

  await db.query(`UPSERT ${SCHEMA_META_TABLE}:current SET hash = '${schemaHash}';`);
};

const surreal = makeModule(() => {
  let db: Surreal;

  const fn = () => {
    return db;
  };

  // Connect during init(), not spin() — init() calls for every module run (in
  // src/config/module.ts's array construction) before any module's spin() runs, and a
  // plugin's own init() (src/modules/plugin.ts) may query the DB (e.g. reading its own
  // vars group) as part of its own setup. Deferring the actual connect to spin() left a
  // window where `surreal()` returned an instance that existed but had never connected,
  // so any DB call made from a plugin's init() failed with ConnectionUnavailableError.
  fn.init = async () => {
    const { db: dbConfig } = getConfig();

    let engines: Engines;
    if (isRemotePath(dbConfig.path)) {
      engines = createRemoteEngines();
    } else if (EMBEDDED_SCHEMES.some((scheme) => dbConfig.path.startsWith(scheme))) {
      // Dynamically imported (not a static top-level import) so a compiled build whose
      // config resolves to a remote db.path can exclude @surrealdb/node entirely — see
      // src/cli/build.ts, which externalizes this package for remote-only builds since its
      // native binding loader runs eagerly on import, not lazily on first use.
      const { createNodeEngines } = await import("@surrealdb/node");
      engines = createNodeEngines();
    } else {
      throw new Error(
        `Unrecognized db.path scheme: "${dbConfig.path}" — expected one of ${EMBEDDED_SCHEMES.join(", ")} (embedded) or ${REMOTE_SCHEMES.join(", ")} (remote)`,
      );
    }

    db = new Surreal({ engines });
    await db.connect(dbConfig.path, { authentication: dbConfig.auth });

    // Explicit DEFINE, not left to auto-create-on-USE — that only happens for a
    // root-authenticated connection, and isn't guaranteed across SurrealDB versions/configs.
    // Needed for multi-tenant setups where several njin instances share one remote SurrealDB,
    // each isolated into its own namespace (embedded engines are unaffected either way — a
    // private local file always has implicit owner access). DEFINE DATABASE must run inside
    // the namespace it belongs to, hence the two-step USE.
    await db.query(`DEFINE NAMESPACE IF NOT EXISTS \`${dbConfig.namespace}\`;`);
    await db.use({ namespace: dbConfig.namespace });
    await db.query(`DEFINE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
    await db.use({ namespace: dbConfig.namespace, database: dbConfig.database });

    return {
      // Deferred to spin(), not run here — ensureTables() imports every registered model
      // to read its prefix, which forces evaluation of data types like file()/multiFile()
      // that depend on other modules' singletons (e.g. fileModule().model, only set once
      // file.init() has run). Every module's init() — file's included — has already
      // completed by the time any module's spin() starts, so this ordering is safe. It
      // still runs before elysia's spin() (which calls app.listen()), since surreal is
      // earlier in src/config/module.ts's array, so tables exist before the first request.
      spin: async () => {
        await ensureTables(db);

        const shutdown = async () => {
          await db.close();
          process.exit(0);
        };

        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      },
    };
  };

  return fn;
});

export default surreal;
