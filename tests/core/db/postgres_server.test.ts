import { afterAll, describe, it } from "bun:test";
import { SQL } from "bun";
import { postgresAdapter } from "../../../src/core/adapters/postgres";
import { describeAdapter } from "./contract_suite";

// The same contract suite against a real PostgreSQL server, through the `url` option (Bun's
// built-in client). Opt-in, because it needs a server and a database you don't mind creating
// throw-away schemas in:
//
//   NJIN_TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/postgres bun test tests/core/db/postgres_server.test.ts
//
// Every test works in a schema of its own that is dropped afterwards; nothing else is touched.
const url = process.env.NJIN_TEST_POSTGRES_URL;

if (!url) {
  describe("DbAdapter contract: postgres (server)", () => {
    it.skip("set NJIN_TEST_POSTGRES_URL to run against a real server", () => {});
  });
} else {
  const admin = new SQL(url, { max: 1 });
  const run = `njin_test_${Date.now().toString(36)}`;
  const created: string[] = [];
  let counter = 0;

  afterAll(async () => {
    for (const schema of created) {
      await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    }
    await admin.close();
  });

  describeAdapter("postgres (server)", async () => {
    counter += 1;
    const schema = `${run}_${counter}`;
    await admin.unsafe(`create schema "${schema}"`);
    created.push(schema);

    return postgresAdapter({ url, schema, max: 2 });
  });
}
