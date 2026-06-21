import env from "@njin/config/env";
import { makeModule } from "@njin/core/module";
import { createNodeEngines } from "@surrealdb/node";
import { Surreal } from "surrealdb";

// SurrealDB's `GROUP ALL` aggregate (used for count queries) throws NotFoundError
// on a table that has never had a row created, unlike plain SELECT. Defining every
// table up front avoids that first-run failure (e.g. /api/setup/status before any user exists).
const ensureTables = async (db: Surreal) => {
  const { default: apiModels } = await import("@njin/config/api");
  const { default: userModel } = await import("@njin/models/user");
  const { default: fileModel } = await import("@njin/models/file");

  const prefixes = new Set<string>([userModel.prefix, fileModel.prefix]);

  for (const factory of apiModels) {
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
        await db.connect(env.db.path);
        await db.use({ namespace: env.db.namespace, database: env.db.database });
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
