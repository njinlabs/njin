import env from "@njin/config/env";
import { makeModule } from "@njin/core/module";
import { createNodeEngines } from "@surrealdb/node";
import { Surreal } from "surrealdb";

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
