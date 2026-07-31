import { getConfig } from "../core/config";
import { makeModule } from "../core/module";
import { createNodeEngines } from "@surrealdb/node";
import { Surreal } from "surrealdb";

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
    db = new Surreal({
      engines: createNodeEngines(),
    });

    const { db: dbConfig } = getConfig();
    await db.connect(dbConfig.path);
    await db.use({ namespace: dbConfig.namespace, database: dbConfig.database });
    await ensureTables(db);

    return {
      spin: () => {
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
