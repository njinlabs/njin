import { SQL } from "bun";
import { assertSingleStatement, type SqlClient } from "./builder";
import { toPositional } from "./text";

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
// MySQL and MariaDB do not read njin's PostgreSQL-flavoured text ("quoted" names, $1 placeholders),
// so for them it is rewritten (see ./text.ts) after the check.
type Prepare = (text: string) => string;

const checked = (text: string, prepare: Prepare) => {
  assertSingleStatement(text);
  return prepare(text);
};

const inTransaction = (tx: BunTx, prepare: Prepare): SqlClient => ({
  query: async (text, params) =>
    rows(await tx.unsafe(checked(text, prepare), params)),
  transaction: (fn) => tx.savepoint((sp) => fn(inTransaction(sp, prepare))),
});

const root = (client: BunRoot, prepare: Prepare): SqlClient => ({
  query: async (text, params) =>
    rows(await client.unsafe(checked(text, prepare), params)),
  transaction: (fn) => client.begin((tx) => fn(inTransaction(tx, prepare))),
});

export type BunClientOptions = {
  // Connection pool size.
  max?: number;
  // TLS for the connection: true, or Bun's TLS options. Prefer it for anything but localhost.
  tls?: boolean | Record<string, unknown>;
  // The statement text has to be rewritten for MySQL and MariaDB.
  mysql?: boolean;
};

export const bunSqlClient = (url: string, options: BunClientOptions = {}) => {
  // Bun types the options as a union over the three databases; ours are the shared subset.
  const client = new SQL(url, { max: options.max, tls: options.tls } as never);

  return {
    client: root(
      client as unknown as BunRoot,
      options.mysql
        ? (text) => toPositional(text, { backticks: true })
        : (text) => text,
    ),
    close: () => client.close(),
  };
};
