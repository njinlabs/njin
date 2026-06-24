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

  const prefixes = new Set<string>([userModel.prefix, fileModel.prefix]);

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

  fn.init = () => {
    db = new Surreal({
      engines: createNodeEngines(),
    });

    return {
      spin: async () => {
        const { db: dbConfig } = getConfig();
        await db.connect(dbConfig.path);
        await db.use({ namespace: dbConfig.namespace, database: dbConfig.database });
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
