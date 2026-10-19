import { sqlAdapter } from "./sql/adapter";
import { sqliteDialect } from "./sql/dialects/sqlite";
import { sqliteClient } from "./sql/sqlite_client";

// A SQLite adapter on bun:sqlite — one file (or memory), no server. Everything about how data
// is stored lives in ./sql/adapter.ts and ./sql/dialects/sqlite.ts.

export type SqliteAdapterConfig = {
  // The database file ("data/app.db"), or ":memory:" for a database that lives as long as the
  // process.
  path: string;
  // How long to wait for another process's write lock, in milliseconds.
  busyTimeout?: number;
};

export const sqliteAdapter = (config: SqliteAdapterConfig) =>
  sqlAdapter({
    name: "sqlite",
    dialect: sqliteDialect,
    connect: () =>
      sqliteClient(config.path, { busyTimeout: config.busyTimeout }),
    describe: () => config.path,
  });

export default sqliteAdapter;
