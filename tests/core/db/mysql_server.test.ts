import { afterAll, describe, it, setDefaultTimeout } from "bun:test";
import { mysqlAdapter } from "../../../src/core/adapters/mysql";
import { bunSqlClient } from "../../../src/core/adapters/sql/bun_client";
import { describeAdapter } from "./contract_suite";

// The same contract suite against a real MySQL or MariaDB server, through the `url` option
// (Bun's built-in client). Opt-in, because it needs a server and a user allowed to create
// throw-away databases:
//
//   NJIN_TEST_MYSQL_URL=mysql://root@localhost:3306/mysql bun test tests/core/db/mysql_server.test.ts
//
// Every test works in a database of its own that is dropped afterwards; nothing else is touched.
const url = process.env.NJIN_TEST_MYSQL_URL;

// Creating the tables of a test's database is dozens of DDL statements, each committing on its
// own; the default 5 seconds a hook gets is not enough on a slow disk.
setDefaultTimeout(60_000);

if (!url) {
  describe("DbAdapter contract: mysql (server)", () => {
    it.skip("set NJIN_TEST_MYSQL_URL to run against a real server", () => {});
  });
} else {
  // A throwaway test server: MySQL 8 logs in with caching_sha2_password, which over a plain
  // connection needs the server's RSA key (Bun refuses to fetch it unless told to).
  const admin = bunSqlClient(url, {
    max: 1,
    mysql: true,
    allowPublicKeyRetrieval: true,
  });
  const run = `njin_test_${Date.now().toString(36)}`;
  const created: string[] = [];
  let counter = 0;

  afterAll(async () => {
    for (const schema of created) {
      await admin.client.query(`drop database if exists "${schema}"`, []);
    }
    await admin.close();
  });

  describeAdapter("mysql (server)", async () => {
    counter += 1;
    const schema = `${run}_${counter}`;
    await admin.client.query(
      `create database "${schema}" default charset utf8mb4`,
      [],
    );
    created.push(schema);

    return mysqlAdapter({
      url,
      schema,
      max: 2,
      allowPublicKeyRetrieval: true,
    });
  });
}
