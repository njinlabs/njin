import type { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "../../src/core/adapters/sql/builder";

// PGlite (an in-process Postgres) as an SqlClient, so adapter tests run real Postgres semantics
// without a server. PGlite has no nested transactions, so a transaction inside one becomes a
// savepoint, the same way Bun's client does it.

type Queryable = {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
};

const inTransaction = (tx: Queryable, counter = { n: 0 }): SqlClient => ({
  query: async (text, params) =>
    (await tx.query(text, params)).rows as Record<string, unknown>[],

  transaction: async (fn) => {
    counter.n += 1;
    const name = `sp_${counter.n}`;
    await tx.query(`savepoint ${name}`);
    try {
      const result = await fn(inTransaction(tx, counter));
      await tx.query(`release savepoint ${name}`);
      return result;
    } catch (error) {
      await tx.query(`rollback to savepoint ${name}`);
      throw error;
    }
  },
});

export const pgliteClient = (client: PGlite): SqlClient => ({
  query: async (text, params) =>
    (await client.query(text, params)).rows as Record<string, unknown>[],

  transaction: (fn) => client.transaction((tx) => fn(inTransaction(tx))),
});
