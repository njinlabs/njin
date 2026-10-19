import { afterAll, mock } from "bun:test";
import { resolve } from "node:path";
import { surrealAdapter } from "../../src/core/adapters/surreal";
import type { DbAdapter, TableDef } from "../../src/core/db/contract";
import { internalTables } from "../../src/core/db/internal";

// A real in-memory database standing in for the db module, so a test exercises the same code
// path production does instead of a hand-rolled fake. Call it at the top of the test file,
// before the modules under test are imported:
//
//   const db = await useTestDb();
//   const { default: userModel } = await import("../../src/models/user");
//   await db.sync([userModel.def]);
//
// Every njin-internal table is defined up front; pass the models a test touches to sync().
// The adapter behind the test database. SurrealDB (in memory) by default; set
// NJIN_TEST_ADAPTER=postgres to run the same tests on Postgres: an in-process PGlite, or — when
// NJIN_TEST_POSTGRES_URL is also set — a real server through Bun's SQL client (each test file
// gets a schema of its own, dropped afterwards). NJIN_TEST_ADAPTER=sqlite runs them on an
// in-memory SQLite; NJIN_TEST_ADAPTER=mysql (also covers MariaDB) needs NJIN_TEST_MYSQL_URL and
// gives each test file a database of its own.
const makeAdapter = async (): Promise<DbAdapter> => {
  if (process.env.NJIN_TEST_ADAPTER === "postgres") {
    const { postgresAdapter } = await import(
      "../../src/core/adapters/postgres"
    );

    const url = process.env.NJIN_TEST_POSTGRES_URL;
    if (url) {
      const { bunSqlClient } = await import(
        "../../src/core/adapters/sql/bun_client"
      );
      const schema = `njin_app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const admin = bunSqlClient(url, { max: 1 });
      await admin.client.query(`create schema "${schema}"`, []);
      afterAll(async () => {
        await admin.client.query(`drop schema "${schema}" cascade`, []);
        await admin.close();
      });
      return postgresAdapter({ url, schema, max: 2 });
    }

    const { PGlite } = await import("@electric-sql/pglite");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const { pgliteClient } = await import("./pglite_client");

    const client = new PGlite({ extensions: { pg_trgm } });
    return postgresAdapter({
      connect: () => ({
        client: pgliteClient(client),
        close: () => client.close(),
      }),
    });
  }

  if (process.env.NJIN_TEST_ADAPTER === "sqlite") {
    const { sqliteAdapter } = await import("../../src/core/adapters/sqlite");
    return sqliteAdapter({ path: ":memory:" });
  }

  if (process.env.NJIN_TEST_ADAPTER === "mysql") {
    const url = process.env.NJIN_TEST_MYSQL_URL;
    if (!url)
      throw new Error("NJIN_TEST_ADAPTER=mysql needs NJIN_TEST_MYSQL_URL");

    const { mysqlAdapter } = await import("../../src/core/adapters/mysql");
    const { bunSqlClient } = await import(
      "../../src/core/adapters/sql/bun_client"
    );
    const schema = `njin_app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = bunSqlClient(url, { max: 1, mysql: true });
    await admin.client.query(
      `create database "${schema}" default charset utf8mb4`,
      [],
    );
    afterAll(async () => {
      await admin.client.query(`drop database "${schema}"`, []);
      await admin.close();
    });
    return mysqlAdapter({ url, schema, max: 2 });
  }

  return surrealAdapter({
    path: "mem://",
    namespace: "test",
    database: "test",
  });
};

export const useTestDb = async (tables: readonly TableDef[] = []) => {
  const real = await makeAdapter();
  await real.connect();
  await real.sync([...internalTables, ...tables]);

  // Every adapter method call is recorded, so a test can assert on what the code under test
  // asked the database for (e.g. the ListQuery a model built) as well as on what came back.
  const calls: { method: string; args: unknown[] }[] = [];
  // One-shot failures queued by failNext(): the next call to that method rejects instead.
  const failures = new Map<string, Error>();
  // The same recording and failure injection applies to the `tx` a transaction() callback is
  // handed, so a test can make a write fail halfway through a transaction.
  const instrument = <T extends object>(inner: T): T =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const method = String(prop);
          calls.push({ method, args });

          const failure = failures.get(method);
          if (failure) {
            failures.delete(method);
            return Promise.reject(failure);
          }

          if (method === "transaction") {
            const [fn] = args as [(tx: object) => Promise<unknown>];
            return value.call(target, (tx: object) => fn(instrument(tx)));
          }

          return value.apply(target, args);
        };
      },
    });
  const adapter = instrument(real);

  // An embedded engine left open at exit crashed Bun with a segfault on Linux CI (after all
  // tests had passed) — close it explicitly once the file's tests are done.
  afterAll(async () => {
    await real.close();
  });

  mock.module(resolve(import.meta.dir, "../../src/modules/db"), () => ({
    default: () => adapter,
  }));

  return {
    adapter,
    calls,
    // Makes the next call to `method` reject with `error` (simulates the database going away).
    failNext: (method: keyof DbAdapter, error = new Error("db down")) => {
      failures.set(method, error);
    },
    // The arguments of every recorded call to `method`.
    callsTo: (method: string) =>
      calls.filter((c) => c.method === method).map((c) => c.args),
    // Re-sync with extra tables (the internal ones are always included).
    sync: (extra: readonly TableDef[]) =>
      real.sync([...internalTables, ...extra]),
  };
};
