import { SQL } from "bun";
import { assertSingleStatement, type SqlClient } from "./builder";

// Bun's built-in SQL client as an SqlClient. Parameters travel to the database separately from
// the statement text (a Bind message for PostgreSQL, a server-side prepared statement for
// MySQL), so there is no client-side escaping to get wrong.

type BunTx = {
  unsafe(text: string, params?: unknown[]): Promise<unknown>;
  savepoint<T>(fn: (sp: BunTx) => Promise<T>): Promise<T>;
};

type BunRoot = Pick<BunTx, "unsafe"> & {
  begin<T>(fn: (tx: BunTx) => Promise<T>): Promise<T>;
};

const rows = (result: unknown) =>
  Array.from(result as ArrayLike<Record<string, unknown>>);

// Bun runs a statement with no parameters as a "simple query", which accepts several commands
// at once; every statement is checked to be exactly one before it is sent.
const single = (text: string) => {
  assertSingleStatement(text);
  return text;
};

const inTransaction = (tx: BunTx): SqlClient => ({
  query: async (text, params) => rows(await tx.unsafe(single(text), params)),
  transaction: (fn) => tx.savepoint((sp) => fn(inTransaction(sp))),
});

const root = (client: BunRoot): SqlClient => ({
  query: async (text, params) =>
    rows(await client.unsafe(single(text), params)),
  transaction: (fn) => client.begin((tx) => fn(inTransaction(tx))),
});

export type BunClientOptions = {
  // Connection pool size.
  max?: number;
  // TLS for the connection: true, or Bun's TLS options. Prefer it for anything but localhost.
  tls?: boolean | Record<string, unknown>;
};

export const bunSqlClient = (url: string, options: BunClientOptions = {}) => {
  // Bun types the options as a union over the three databases; ours are the shared subset.
  const client = new SQL(url, { max: options.max, tls: options.tls } as never);

  return {
    client: root(client as unknown as BunRoot),
    close: () => client.close(),
  };
};
