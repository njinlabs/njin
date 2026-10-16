import { getConfig } from "../core/config";
import type { DbAdapter, TableDef } from "../core/db/contract";
import { internalTables } from "../core/db/internal";
import { makeModule } from "../core/module";

// Every table the app will touch: njin's own, the built-in user/file models, then whatever
// the project registered. Collected here (not at model-definition time) because importing a
// model evaluates data types like file()/multiFile() that depend on other modules' singletons,
// which only exist once every module's init() has run.
const collectTables = async () => {
  const { default: userModel } = await import("../models/user");
  const { default: fileModel } = await import("../models/file");

  const tables = new Map<string, TableDef>();
  for (const table of internalTables) tables.set(table.name, table);

  const models: { def: TableDef }[] = [userModel, fileModel];
  for (const factory of getConfig().models) {
    const { default: model } = await factory();
    models.push(model);
  }
  for (const model of models) tables.set(model.def.name, model.def);

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
        await adapter.sync(await collectTables());

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
