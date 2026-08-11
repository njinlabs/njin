import { getConfig } from "../core/config";
import { makeModule } from "../core/module";
import { Surreal, createRemoteEngines } from "surrealdb";
import type { Engines } from "surrealdb";

const REMOTE_SCHEMES = ["ws://", "wss://", "http://", "https://"];
const EMBEDDED_SCHEMES = ["mem://", "rocksdb://", "surrealkv://"];

export const isRemotePath = (path: string) => REMOTE_SCHEMES.some((scheme) => path.startsWith(scheme));

// SurrealDB's `GROUP ALL` aggregate (used for count queries) throws NotFoundError
// on a table that has never had a row created, unlike plain SELECT. Defining every
// table up front avoids that first-run failure (e.g. /api/setup/status before any user exists).
const ensureTables = async (db: Surreal) => {
  const { default: userModel } = await import("../models/user");
  const { default: fileModel } = await import("../models/file");

  const prefixes = new Set<string>([userModel.prefix, fileModel.prefix, "vars"]);

  for (const factory of getConfig().models) {
    const { default: model } = await factory();
    prefixes.add(model.prefix);
  }

  for (const prefix of prefixes) {
    await db.query(`DEFINE TABLE IF NOT EXISTS ${prefix} SCHEMALESS;`);
  }
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
