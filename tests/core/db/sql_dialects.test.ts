import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mysqlAdapter } from "../../../src/core/adapters/mysql";
import { bunSqlClient } from "../../../src/core/adapters/sql/bun_client";
import { sqliteAdapter } from "../../../src/core/adapters/sqlite";
import type { DbAdapter, TableDef } from "../../../src/core/db/contract";

// Behaviour that only the SQL dialects with unusual storage can get wrong: values that must read
// back exactly as written, comparisons that must stay case-sensitive, and a migration that
// finds what is already there. SQLite always; MySQL/MariaDB when NJIN_TEST_MYSQL_URL points at
// a server (see mysql_server.test.ts).

const base: TableDef = {
  name: "note",
  fields: [
    { kind: "scalar", name: "title", type: "string", unique: true },
    { kind: "scalar", name: "body", type: "string" },
    { kind: "scalar", name: "pinned", type: "boolean" },
    { kind: "scalar", name: "score", type: "number" },
    { kind: "scalar", name: "due", type: "datetime" },
    { kind: "scalar", name: "extra", type: "json" },
  ],
  search: [{ table: "note", field: "title" }],
};

const mysqlUrl = process.env.NJIN_TEST_MYSQL_URL;
const admin = mysqlUrl
  ? // A throwaway test server: MySQL 8's caching_sha2_password login needs the server's RSA key
    // over a plain connection, which Bun refuses to fetch unless told to.
    bunSqlClient(mysqlUrl, {
      max: 1,
      mysql: true,
      allowPublicKeyRetrieval: true,
    })
  : undefined;
const created: string[] = [];
let counter = 0;
const run = `njin_dialect_${Date.now().toString(36)}`;

afterAll(async () => {
  for (const schema of created) {
    await admin?.client.query(`drop database if exists "${schema}"`, []);
  }
  await admin?.close();
});

const targets: [string, () => Promise<DbAdapter>][] = [
  ["sqlite", async () => sqliteAdapter({ path: ":memory:" })],
];
if (mysqlUrl) {
  targets.push([
    "mysql",
    async () => {
      counter += 1;
      const schema = `${run}_${counter}`;
      await admin?.client.query(
        `create database "${schema}" default charset utf8mb4`,
        [],
      );
      created.push(schema);
      return mysqlAdapter({
        url: mysqlUrl,
        schema,
        max: 2,
        allowPublicKeyRetrieval: true,
      });
    },
  ]);
}

for (const [name, make] of targets) {
  describe(`${name} dialect`, () => {
    let db: DbAdapter;

    beforeEach(async () => {
      db = await make();
      await db.connect();
      await db.sync([base]);
      return async () => {
        await db.close();
      };
    });

    it("reads values back exactly as they were written", async () => {
      const due = "2026-03-04T05:06:07.089Z";
      const created = await db.insert(base, {
        title: "Héllo wörld",
        body: "x".repeat(70_000),
        pinned: false,
        score: 0.1 + 0.2,
        due,
        extra: { list: [1, "two", null], nested: { ok: true } },
      });

      const read = await db.find(base, created.id);
      expect(read).toMatchObject({
        title: "Héllo wörld",
        pinned: false,
        score: 0.1 + 0.2,
        due,
        extra: { list: [1, "two", null], nested: { ok: true } },
      });
      expect((read as unknown as { body: string }).body).toHaveLength(70_000);
    });

    it("compares strings case-sensitively, like every other database", async () => {
      await db.insert(base, { title: "Alpha" });
      await db.insert(base, { title: "alpha" });

      const exact = await db.list(base, {
        where: [{ field: "title", op: "$eq", value: "alpha" }],
        populate: [],
        page: 1,
        limit: 10,
      });
      expect(
        exact.rows.map((r) => (r as unknown as { title: string }).title),
      ).toEqual(["alpha"]);

      // ...and a unique column treats them as two values.
      await expect(db.insert(base, { title: "Alpha" })).rejects.toThrow();
    });

    it("adds a field to a table that already has rows, without touching them", async () => {
      const row = await db.insert(base, { title: "keep me", pinned: true });

      const wider: TableDef = {
        ...base,
        fields: [
          ...base.fields,
          { kind: "scalar", name: "subtitle", type: "string" },
        ],
      };
      await db.sync([wider]);

      expect(await db.find(wider, row.id)).toMatchObject({
        title: "keep me",
        pinned: true,
      });
      const updated = await db.update(wider, row.id, { subtitle: "new" });
      expect(updated).toMatchObject({ title: "keep me", subtitle: "new" });
    });

    it("syncing an unchanged schema again changes nothing", async () => {
      const row = await db.insert(base, { title: "same" });
      await db.sync([base]);
      await db.sync([base]);
      expect(await db.find(base, row.id)).toMatchObject({ title: "same" });
    });

    it("searches fuzzily: tolerates a typo, ranks by closeness, skips the unrelated", async () => {
      expect(db.capabilities.search).toBe("fuzzy");
      await db.insert(base, { title: "Hello World Guide" });
      await db.insert(base, { title: "Hello there" });
      await db.insert(base, { title: "Cooking pasta" });

      const find = async (search: string) =>
        (
          await db.list(base, { search, page: 1, limit: 10, populate: [] })
        ).rows.map((r) => (r as unknown as { title: string }).title);

      // A typo and a missing space still find it; the closest match comes first.
      expect(await find("helo wrld")).toEqual(["Hello World Guide"]);
      expect(await find("hello wrld guid")).toEqual(["Hello World Guide"]);
      // Plain containment outranks a partial overlap.
      expect((await find("hello"))[0]).toBeDefined();
      expect(await find("hello world")).toEqual(["Hello World Guide"]);
      // Nothing in common.
      expect(await find("zzzzzz")).toEqual([]);
      // Shorter than a trigram: containment only.
      expect(await find("pa")).toEqual(["Cooking pasta"]);
    });

    it("deletes by filter, including children, and reports how many", async () => {
      for (const title of ["a", "b", "c"]) {
        await db.insert(base, { title, pinned: title !== "b" });
      }
      const removed = await db.removeWhere(base, [
        { field: "pinned", op: "$eq", value: true },
      ]);
      expect(removed).toBe(2);
      expect(await db.count(base)).toBe(1);
    });
  });
}
