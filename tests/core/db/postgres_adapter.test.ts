import { afterAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { postgresAdapter } from "../../../src/core/adapters/postgres";
import { pgliteClient } from "../../helpers/pglite_client";
import { describeAdapter } from "./contract_suite";

// An in-process Postgres (PGlite, with pg_trgm) so the shared contract suite runs against real
// Postgres semantics without a server. Booting it costs more than the whole schema setup, so
// one instance is shared and every test gets a schema of its own (which also exercises the
// adapter's `schema` option).
const client = new PGlite({ extensions: { pg_trgm } });
const db = pgliteClient(client);

afterAll(async () => {
  await client.close();
});

let counter = 0;

describeAdapter("postgres (pglite)", () => {
  counter += 1;
  const schema = `contract_${counter}`;

  return postgresAdapter({
    schema,
    connect: async () => {
      await client.exec(`create schema "${schema}"`);
      return {
        client: db,
        close: async () => {
          await client.exec(`drop schema "${schema}" cascade`);
        },
      };
    },
  });
});
