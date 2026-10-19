import { getConfig } from "../core/config";
import type { DbAdapter, TableDef } from "../core/db/contract";
import { internalTables } from "../core/db/internal";
import { makeModule } from "../core/module";
import { isDraftableVars } from "../core/vars";

// Every table the app will touch: njin's own, the built-in user/file models, then whatever
// the project registered. Collected here (not at model-definition time) because importing a
// model evaluates data types like file()/multiFile() that depend on other modules' singletons,
// which only exist once every module's init() has run.
type Collected = {
  def: TableDef;
  publishedDef?: TableDef;
  // An i18n model's second table (one row per record and language).
  i18nDef?: TableDef;
  backfillPublished?: () => Promise<number>;
};

const collectModels = async () => {
  const { default: userModel } = await import("../models/user");
  const { default: fileModel } = await import("../models/file");

  const models: Collected[] = [userModel, fileModel];
  for (const factory of getConfig().models) {
    const { default: model } = await factory();
    models.push(model);
  }

  return models;
};

const collectTables = (models: readonly Collected[]) => {
  const tables = new Map<string, TableDef>();
  for (const table of internalTables) tables.set(table.name, table);

  for (const model of models) {
    tables.set(model.def.name, model.def);
    // A draftable model keeps its published copies in a second table.
    if (model.publishedDef) {
      tables.set(model.publishedDef.name, model.publishedDef);
    }
    if (model.i18nDef) tables.set(model.i18nDef.name, model.i18nDef);
  }

  return [...tables.values()];
};

const db = makeModule(() => {
  let adapter: DbAdapter;

  const fn = () => adapter;

  // Connect during init(), not spin() — init() calls for every module run (in
  // src/config/module.ts's array construction) before any module's spin() runs, and a
  // plugin's own init() (src/modules/plugin.ts) may query the DB (e.g. reading its own
  // vars group) as part of its own setup. Deferring the actual connect to spin() left a
  // window where `db()` returned an instance that existed but had never connected,
  // so any DB call made from a plugin's init() failed with ConnectionUnavailableError.
  fn.init = async () => {
    adapter = getConfig().adapters.db;
    await adapter.connect();

    return {
      // Deferred to spin(), not run here — see collectTables(). Every module's init() has
      // completed by the time any module's spin() starts, so this ordering is safe. It
      // still runs before elysia's spin() (which calls app.listen()), since db is earlier
      // in src/config/module.ts's array, so tables exist before the first request.
      spin: async () => {
        const models = await collectModels();
        await adapter.sync(collectTables(models));

        // Records that predate a model becoming draftable are live content.
        for (const model of models) await model.backfillPublished?.();

        // ...and so are the saved values of a settings group that became draftable.
        for (const factory of getConfig().vars ?? []) {
          const { default: group } = await factory();
          if (isDraftableVars(group)) await group.backfillPublished();
        }

        const shutdown = async () => {
          await adapter.close();
          process.exit(0);
        };

        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      },
    };
  };

  return fn;
});

export default db;
