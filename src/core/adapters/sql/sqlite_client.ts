import { Database } from "bun:sqlite";
import { assertSingleStatement, type SqlClient } from "./builder";
import { toPositional } from "./text";

// bun:sqlite as an SqlClient.
//
// SQLite has one connection and one writer, so the client is a queue: a statement or a whole
// transaction runs only when the previous one is done. A transaction starts with BEGIN
// IMMEDIATE, taking the write lock up front — njin runs several processes against one file, and
// a deferred transaction that reads first and writes later can be refused with SQLITE_BUSY no
// matter how long it waits. Nested transactions are savepoints.
//
// Consequence: inside a transaction, use the client you are handed, never the outer one — the
// outer client waits for the transaction to finish.

export type SqliteClientOptions = {
  // How long to wait for another process's write lock, in milliseconds.
  busyTimeout?: number;
};

type Exec = (text: string, params: unknown[]) => Record<string, unknown>[];

const executor = (db: Database): Exec => {
  return (text, params) => {
    assertSingleStatement(text);
    // Binding is positional, so the numbered placeholders become plain ones.
    const statement = db.query(toPositional(text));
    return statement.all(...(params as never[])) as unknown as Record<
      string,
      unknown
    >[];
  };
};

const inTransaction = (exec: Exec, counter = { n: 0 }): SqlClient => ({
  query: async (text, params) => exec(text, params),

  transaction: async (fn) => {
    counter.n += 1;
    const name = `sp_${counter.n}`;
    exec(`savepoint ${name}`, []);
    try {
      const result = await fn(inTransaction(exec, counter));
      exec(`release savepoint ${name}`, []);
      return result;
    } catch (error) {
      exec(`rollback to savepoint ${name}`, []);
      exec(`release savepoint ${name}`, []);
      throw error;
    }
  },
});

export const sqliteClient = (
  path: string,
  options: SqliteClientOptions = {},
) => {
  const db = new Database(path, { create: true, strict: true });
  db.run(`pragma busy_timeout = ${Math.trunc(options.busyTimeout ?? 5000)}`);
  // One writer at a time, but readers never block it (and vice versa). An in-memory database
  // has no journal to configure.
  if (path !== ":memory:" && path !== "") db.run("pragma journal_mode = wal");

  const exec = executor(db);

  let tail: Promise<unknown> = Promise.resolve();
  const queued = <T>(job: () => Promise<T> | T): Promise<T> => {
    const result = tail.then(job);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  const client: SqlClient = {
    query: (text, params) => queued(() => exec(text, params)),

    transaction: (fn) =>
      queued(async () => {
        exec("begin immediate", []);
        try {
          const result = await fn(inTransaction(exec));
          exec("commit", []);
          return result;
        } catch (error) {
          try {
            exec("rollback", []);
          } catch {
            // The transaction is already gone (SQLite rolls back on some errors itself).
          }
          throw error;
        }
      }),
  };

  return { client, close: () => db.close() };
};
