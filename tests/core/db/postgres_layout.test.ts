import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { postgresAdapter } from "../../../src/core/adapters/postgres";
import type { SqlClient } from "../../../src/core/adapters/sql/builder";
import {
  type DbAdapter,
  type FieldDef,
  LinkTargetMissingError,
  type TableDef,
} from "../../../src/core/db/contract";
import { pgliteClient } from "../../helpers/pglite_client";

// How the Postgres adapter lays data out physically — real columns, child tables and pivots
// rather than JSON — and how it migrates. Behaviour through the DbAdapter interface is covered
// by the shared contract suite (postgres_adapter.test.ts).

const client = new PGlite({ extensions: { pg_trgm } });
const plain = new PGlite(); // no pg_trgm available

afterAll(async () => {
  await client.close();
  await plain.close();
});

let counter = 0;
let schema = "";
let adapter: DbAdapter;

const open = async (
  which: PGlite = client,
  options: { schema?: string } = {},
) => {
  const name = options.schema ?? schema;
  const created = postgresAdapter({
    schema: name,
    connect: () => ({ client: pgliteClient(which) }),
  });
  await created.connect();
  return created;
};

beforeEach(async () => {
  counter += 1;
  schema = `layout_${counter}`;
  await client.exec(`create schema "${schema}"`);
  await plain.exec(`create schema if not exists "${schema}"`);
  adapter = await open();
});

const str = (name: string): FieldDef => ({
  kind: "scalar",
  name,
  type: "string",
});

const columnsOf = async (table: string, which: PGlite = client) =>
  Object.fromEntries(
    (
      await which.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns where table_schema = $1 and table_name = $2`,
        [schema, table],
      )
    ).rows.map((r) => [r.column_name, r.data_type]),
  );

const tablesOf = async () =>
  (
    await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = $1 order by table_name`,
      [schema],
    )
  ).rows.map((r) => r.table_name);

const countRows = async (table: string) =>
  Number(
    (
      await client.query<{ n: number }>(
        `select count(*)::int as n from "${schema}"."${table}"`,
      )
    ).rows[0]?.n,
  );

const product: TableDef = {
  name: "product",
  fields: [
    str("title"),
    { kind: "scalar", name: "price", type: "number" },
    { kind: "scalar", name: "live", type: "boolean" },
    { kind: "scalar", name: "releasedAt", type: "datetime" },
    { kind: "scalar", name: "extra", type: "json" },
    { kind: "one", name: "brand", target: "brand" },
    { kind: "many", name: "categories", target: "category" },
    {
      kind: "object",
      name: "seo",
      fields: [
        str("title"),
        { kind: "object", name: "og", fields: [str("image")] },
      ],
    },
    { kind: "array", name: "tags", of: { kind: "scalar", type: "string" } },
    {
      kind: "array",
      name: "variants",
      of: {
        kind: "object",
        fields: [
          str("sku"),
          { kind: "scalar", name: "stock", type: "number" },
          {
            kind: "array",
            name: "prices",
            of: { kind: "scalar", type: "number" },
          },
        ],
      },
    },
    {
      kind: "array",
      name: "grid",
      of: { kind: "array", of: { kind: "scalar", type: "number" } },
    },
  ],
  search: [],
};

const brand: TableDef = { name: "brand", fields: [str("name")], search: [] };
const category: TableDef = {
  name: "category",
  fields: [str("name")],
  search: [],
};

// Links are foreign keys, so a row can only point at a row that exists.
const linkTargets = async (...ids: string[]) => {
  for (const id of ids) await adapter.insert(category, { name: id }, { id });
};

describe("physical layout", () => {
  beforeEach(async () => {
    await adapter.sync([product, brand, category]);
  });

  it("gives scalars real, typed columns", async () => {
    expect(await columnsOf("product")).toMatchObject({
      id: "text",
      createdAt: "timestamp with time zone",
      updatedAt: "timestamp with time zone",
      title: "text",
      price: "double precision",
      live: "boolean",
      releasedAt: "timestamp with time zone",
      extra: "jsonb",
      brand: "text",
    });
  });

  it("flattens an object() into columns on the same table", async () => {
    const columns = await columnsOf("product");
    expect(columns.seo__title).toBe("text");
    expect(columns.seo__og__image).toBe("text");
    expect(columns).not.toHaveProperty("seo");
  });

  it("stores array() in child tables and relationMany() in a pivot, with no JSON", async () => {
    expect(await tablesOf()).toEqual(
      expect.arrayContaining([
        "product",
        "product__tags",
        "product__variants",
        "product__variants__prices",
        "product__grid",
        "product__grid__item",
        "product__categories",
      ]),
    );

    expect(await columnsOf("product__tags")).toMatchObject({
      _id: "text",
      _owner: "text",
      _parent: "text",
      _pos: "double precision",
      value: "text",
    });
    // An array of objects flattens each object into the child's columns.
    expect(await columnsOf("product__variants")).toMatchObject({
      sku: "text",
      stock: "double precision",
    });
    expect(await columnsOf("product__categories")).toMatchObject({
      _parent: "text",
      _pos: "double precision",
      target: "text",
    });

    // Only the declared json field is JSON.
    const json = Object.entries(await columnsOf("product")).filter(
      ([, type]) => type === "jsonb",
    );
    expect(json.map(([name]) => name)).toEqual(["extra"]);
  });

  it("round-trips a deeply nested value, keeping array order", async () => {
    const data = {
      title: "Shoe",
      price: 12.5,
      live: true,
      releasedAt: "2026-03-04T05:06:07.089Z",
      extra: { anything: [1, "two", { three: 3 }] },
      seo: { title: "S", og: { image: "i.png" } },
      tags: ["z", "a", "m"],
      variants: [
        { sku: "b", stock: 2, prices: [3, 1, 2] },
        { sku: "a", stock: 1, prices: [] },
      ],
      grid: [[1, 2], [3], []],
    };
    const row = await adapter.insert(product, data);

    const found = await adapter.find(product, row.id);
    expect(found).toMatchObject(data);
    expect(found?.releasedAt).toBe("2026-03-04T05:06:07.089Z");
  });

  it("replaces an array as a whole and leaves no orphaned child rows", async () => {
    await linkTargets("c1", "c2", "c3");
    const row = await adapter.insert(product, {
      title: "Shoe",
      tags: ["a", "b", "c"],
      variants: [{ sku: "x", stock: 1, prices: [1, 2] }],
      categories: ["c1", "c2"],
    });
    expect(await countRows("product__tags")).toBe(3);
    expect(await countRows("product__variants__prices")).toBe(2);

    await adapter.update(product, row.id, {
      tags: ["z"],
      variants: [],
      categories: ["c3"],
    });

    expect(await countRows("product__tags")).toBe(1);
    expect(await countRows("product__variants")).toBe(0);
    expect(await countRows("product__variants__prices")).toBe(0);
    expect((await adapter.find(product, row.id))?.categories).toEqual(["c3"]);
  });

  it("deletes every child and pivot row with the row", async () => {
    await linkTargets("c1");
    const row = await adapter.insert(product, {
      title: "Shoe",
      tags: ["a", "b"],
      variants: [{ sku: "x", stock: 1, prices: [1] }],
      grid: [[1, 2]],
      categories: ["c1"],
    });
    await adapter.insert(product, { title: "Keep", tags: ["k"] });

    await adapter.remove(product, row.id);

    expect(await countRows("product")).toBe(1);
    expect(await countRows("product__tags")).toBe(1);
    expect(await countRows("product__variants")).toBe(0);
    expect(await countRows("product__variants__prices")).toBe(0);
    expect(await countRows("product__grid")).toBe(0);
    expect(await countRows("product__grid__item")).toBe(0);
    expect(await countRows("product__categories")).toBe(0);
  });

  it("removeWhere cleans up the children of every removed row", async () => {
    await adapter.insert(product, { title: "A", tags: ["1", "2"] });
    await adapter.insert(product, { title: "B", tags: ["3"] });
    await adapter.insert(product, { title: "C", tags: ["4"] });

    const removed = await adapter.removeWhere(product, [
      { field: "title", op: "$ne", value: "C" },
    ]);

    expect(removed).toBe(2);
    expect(await countRows("product")).toBe(1);
    expect(await countRows("product__tags")).toBe(1);
  });

  it("merges an object key by key, and clears it with null", async () => {
    const row = await adapter.insert(product, {
      title: "Shoe",
      seo: { title: "S", og: { image: "i.png" } },
    });

    const merged = await adapter.update(product, row.id, {
      seo: { og: { image: "j.png" } },
    });
    expect(merged?.seo).toEqual({ title: "S", og: { image: "j.png" } });

    const cleared = await adapter.update(product, row.id, { seo: null });
    expect(cleared?.seo).toBeNull();
  });

  it("reads an object with nothing in it as null", async () => {
    const row = await adapter.insert(product, { title: "Bare" });
    expect((await adapter.find(product, row.id))?.seo).toBeNull();
  });

  it("filters by an element of an array or a relation list", async () => {
    await linkTargets("c1", "c2");
    await adapter.insert(product, {
      title: "A",
      tags: ["red"],
      categories: ["c1"],
    });
    await adapter.insert(product, {
      title: "B",
      tags: ["blue"],
      categories: ["c2"],
    });

    const byTag = await adapter.list(product, {
      where: [{ field: "tags", op: "$in", value: "red" }],
      page: 1,
      limit: 10,
      populate: [],
    });
    const byCategory = await adapter.list(product, {
      where: [{ field: "categories", op: "$in", value: "c2" }],
      page: 1,
      limit: 10,
      populate: [],
    });

    expect(byTag.rows.map((r) => r.title)).toEqual(["A"]);
    expect(byCategory.rows.map((r) => r.title)).toEqual(["B"]);
  });

  it("rejects filtering on a field inside an object or array", async () => {
    await expect(
      adapter.list(product, {
        where: [{ field: "seo__title", op: "$eq", value: "x" }],
        page: 1,
        limit: 10,
        populate: [],
      }),
    ).rejects.toThrow(/Unknown or unfilterable/);
  });

  it("rejects a malformed datetime instead of storing garbage", async () => {
    await expect(
      adapter.insert(product, { title: "Bad", releasedAt: "not a date" }),
    ).rejects.toThrow(/valid datetime/);
    expect(await countRows("product")).toBe(0);
  });

  it("rolls the whole write back when part of it fails", async () => {
    await expect(
      adapter.insert(product, {
        title: "Half",
        tags: ["ok"],
        variants: "nope",
      }),
    ).rejects.toThrow();

    expect(await countRows("product")).toBe(0);
    expect(await countRows("product__tags")).toBe(0);
  });

  it("enforces uniqueness in the database too", async () => {
    const unique: TableDef = {
      name: "account",
      fields: [{ kind: "scalar", name: "email", type: "string", unique: true }],
      search: [],
    };
    await adapter.sync([unique]);

    await adapter.insert(unique, { email: "a@example.com" });
    await expect(
      adapter.insert(unique, { email: "a@example.com" }),
    ).rejects.toThrow();
  });
});

// [table, constraint] -> "FOREIGN KEY (col) REFERENCES t(id) ON DELETE ..."
const foreignKeysOf = async () =>
  Object.fromEntries(
    (
      await client.query<{ t: string; c: string; def: string; valid: boolean }>(
        `select conrelid::regclass::text as t, conname as c, pg_get_constraintdef(oid) as def, convalidated as valid from pg_constraint where contype = 'f' and connamespace = $1::regnamespace`,
        [schema],
      )
    ).rows.map((r) => [
      `${r.t.replace(`${schema}.`, "").replaceAll('"', "")}.${r.c}`,
      r,
    ]),
  );

describe("foreign keys", () => {
  beforeEach(async () => {
    await adapter.sync([product, brand, category]);
  });

  it("makes a one() link set null, and owners and pivot targets cascade", async () => {
    const keys = await foreignKeysOf();

    expect(keys["product.fk_product_brand"]?.def).toMatch(
      /FOREIGN KEY \(brand\) REFERENCES .*brand\(id\) ON DELETE SET NULL/,
    );
    expect(keys["product__tags.fk_product__tags__owner"]?.def).toMatch(
      /FOREIGN KEY \(_owner\) REFERENCES .*product\(id\) ON DELETE CASCADE/,
    );
    expect(
      keys["product__categories.fk_product__categories_target"]?.def,
    ).toMatch(
      /FOREIGN KEY \(target\) REFERENCES .*category\(id\) ON DELETE CASCADE/,
    );
    expect(
      keys["product__variants__prices.fk_product__variants__prices__owner"]
        ?.def,
    ).toMatch(/REFERENCES .*product\(id\) ON DELETE CASCADE/);
  });

  it("rejects a link to a row that does not exist", async () => {
    await expect(
      adapter.insert(product, { title: "A", brand: "nobody" }),
    ).rejects.toBeInstanceOf(LinkTargetMissingError);
    await expect(
      adapter.insert(product, { title: "B", categories: ["nobody"] }),
    ).rejects.toBeInstanceOf(LinkTargetMissingError);
    expect(await countRows("product")).toBe(0);
    expect(await countRows("product__categories")).toBe(0);
  });

  it("clears a one() link and removes a pivot entry when the target is deleted", async () => {
    await adapter.insert(brand, { name: "Acme" }, { id: "b1" });
    await linkTargets("c1", "c2");
    const row = await adapter.insert(product, {
      title: "A",
      brand: "b1",
      categories: ["c1", "c2"],
    });

    await adapter.remove(brand, "b1");
    await adapter.remove(category, "c1");

    const found = await adapter.find(product, row.id);
    expect(found?.brand).toBeNull();
    expect(found?.categories).toEqual(["c2"]);
  });

  it("adds the constraints once: migrating again keeps one of each", async () => {
    const before = Object.keys(await foreignKeysOf()).sort();

    await adapter.sync([product, brand, category]);
    await client.exec(`delete from "${schema}"."njin_schema_meta"`);
    await adapter.sync([product, brand, category]);

    expect(Object.keys(await foreignKeysOf()).sort()).toEqual(before);
  });

  it("upgrades a database whose rows already link to missing records: enforced for new writes only", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The state before foreign keys existed: a dangling link and no constraint.
      await client.exec(
        `alter table "${schema}"."product" drop constraint "fk_product_brand"`,
      );
      await client.exec(`delete from "${schema}"."njin_schema_meta"`);
      await client.query(
        `insert into "${schema}"."product" ("id", "title", "brand") values ('old', 'Old', 'gone')`,
      );

      await adapter.sync([product, brand, category]);

      const key = (await foreignKeysOf())["product.fk_product_brand"];
      expect(key?.valid).toBe(false); // NOT VALID: existing rows are not checked
      expect(warn.mock.calls.flat().join(" ")).not.toContain("Could not add");
      await expect(
        adapter.insert(product, { title: "New", brand: "nobody" }),
      ).rejects.toBeInstanceOf(LinkTargetMissingError);
      // The old row is untouched.
      expect((await adapter.find(product, "old"))?.brand).toBe("gone");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("migrations", () => {
  it("only adds: a new field becomes a column and existing data survives", async () => {
    const v1: TableDef = { name: "note", fields: [str("title")], search: [] };
    await adapter.sync([v1]);
    const row = await adapter.insert(v1, { title: "Hello" });

    const v2: TableDef = {
      name: "note",
      fields: [
        str("title"),
        str("body"),
        {
          kind: "array",
          name: "labels",
          of: { kind: "scalar", type: "string" },
        },
        { kind: "object", name: "meta", fields: [str("author")] },
      ],
      search: [],
    };
    await adapter.sync([v2]);

    expect(await columnsOf("note")).toMatchObject({
      title: "text",
      body: "text",
      meta__author: "text",
    });
    expect(await tablesOf()).toContain("note__labels");

    const found = await adapter.find(v2, row.id);
    expect(found?.title).toBe("Hello");
    expect(found?.body).toBeNull();
    expect(found?.labels).toEqual([]);
  });

  it("never drops a column that left the schema", async () => {
    const v1: TableDef = {
      name: "note",
      fields: [str("title"), str("old")],
      search: [],
    };
    await adapter.sync([v1]);
    await adapter.insert(v1, { title: "Hello", old: "kept" });

    await adapter.sync([{ name: "note", fields: [str("title")], search: [] }]);

    expect(await columnsOf("note")).toHaveProperty("old");
  });

  it("is a no-op the second time (recorded schema hash)", async () => {
    const tables = [product, brand, category];
    await adapter.sync(tables);

    // A column dropped behind its back stays dropped: a matching hash skips all DDL.
    await client.exec(`alter table "${schema}"."product" drop column "title"`);
    await adapter.sync(tables);
    expect(await columnsOf("product")).not.toHaveProperty("title");

    // Change the schema and the DDL runs again, restoring it.
    await adapter.sync([...tables, { name: "other", fields: [], search: [] }]);
    expect(await columnsOf("product")).toHaveProperty("title");
  });

  it("keeps two adapters on different schemas apart", async () => {
    await client.exec(`create schema "${schema}_b"`);
    const other = await open(client, { schema: `${schema}_b` });
    const t: TableDef = { name: "note", fields: [str("title")], search: [] };
    await adapter.sync([t]);
    await other.sync([t]);

    await adapter.insert(t, { title: "one" });
    expect(await adapter.count(t)).toBe(1);
    expect(await other.count(t)).toBe(0);
  });
});

describe("free-form document tables", () => {
  const vars: TableDef = {
    name: "vars",
    fields: [],
    search: [],
    document: true,
  };

  beforeEach(async () => {
    await adapter.sync([vars]);
  });

  it("keeps undeclared keys together, merged on update", async () => {
    await adapter.upsert(vars, "general", {
      siteName: "My Site",
      theme: { dark: true },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const row = await adapter.upsert(vars, "general", { siteName: "Renamed" });

    expect(row).toMatchObject({
      id: "general",
      siteName: "Renamed",
      theme: { dark: true },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await columnsOf("vars")).toMatchObject({ data: "jsonb" });
  });
});

describe("identifier length", () => {
  it("cuts a name past Postgres' limit deterministically, without collisions", async () => {
    const long = `${"x".repeat(40)}_${"y".repeat(40)}`;
    const t: TableDef = {
      name: "wide",
      fields: [
        {
          kind: "array",
          name: `${long}_a`,
          of: { kind: "scalar", type: "string" },
        },
        {
          kind: "array",
          name: `${long}_b`,
          of: { kind: "scalar", type: "string" },
        },
      ],
      search: [],
    };
    await adapter.sync([t]);

    const row = await adapter.insert(t, {
      [`${long}_a`]: ["1"],
      [`${long}_b`]: ["2"],
    });
    const found = await adapter.find(t, row.id);

    expect(found?.[`${long}_a`]).toEqual(["1"]);
    expect(found?.[`${long}_b`]).toEqual(["2"]);
    for (const name of await tablesOf())
      expect(name.length).toBeLessThanOrEqual(63);
  });
});

describe("without pg_trgm", () => {
  it("still searches, by counting shared trigrams in plain SQL", async () => {
    const bare = await open(plain);
    const post: TableDef = {
      name: "post",
      fields: [str("title")],
      search: [{ table: "post", field: "title" }],
    };
    await bare.sync([post]);

    expect(bare.capabilities.search).toBe("fuzzy");

    await bare.insert(post, { title: "Getting started with Next.js" });
    await bare.insert(post, { title: "Cooking pasta" });
    const result = await bare.list(post, {
      search: "next.js",
      page: 1,
      limit: 10,
      populate: [],
    });

    expect(result.rows.map((r) => r.title)).toEqual([
      "Getting started with Next.js",
    ]);
  });

  it("reports fuzzy search when the extension is there", async () => {
    await adapter.sync([product]);
    expect(adapter.capabilities.search).toBe("fuzzy");
  });
});

describe("describe()", () => {
  it("shows host and database but never credentials", () => {
    expect(
      postgresAdapter({
        url: "postgres://admin:hunter2@db.example.com:5432/app",
      }).describe!(),
    ).toBe("db.example.com:5432/app");
    expect(
      postgresAdapter({ url: "postgres://u:p@h/app", schema: "tenant_1" })
        .describe!(),
    ).toBe("h/app (tenant_1)");
  });

  it("says so when the connection is supplied by the caller", () => {
    expect(
      postgresAdapter({ connect: () => ({ client: {} as never }) }).describe!(),
    ).toBe("custom connection");
  });
});

// ---------------------------------------------------------------------------------------
// Migration safety
// ---------------------------------------------------------------------------------------

// A database that reports every statement it runs and can be told to fail on some of them.
const watched = (fail?: (statement: string) => boolean) => {
  const statements: string[] = [];
  const wrap = (target: SqlClient): SqlClient => ({
    query: (text, params) => {
      statements.push(text);
      if (fail?.(text)) {
        return Promise.reject(
          new Error(`injected failure: ${text.slice(0, 60)}`),
        );
      }
      return target.query(text, params);
    },
    transaction: (fn) => target.transaction((tx) => fn(wrap(tx))),
  });

  const created = postgresAdapter({
    schema,
    connect: () => ({ client: wrap(pgliteClient(client)) }),
  });
  return { adapter: created, statements };
};

const notes: TableDef = {
  name: "note",
  fields: [
    str("title"),
    { kind: "array", name: "tags", of: { kind: "scalar", type: "string" } },
  ],
  search: [],
};

describe("migration safety", () => {
  it("warns, once, when a field changes type — and does not touch the column", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const asText: TableDef = {
        name: "gauge",
        fields: [str("reading")],
        search: [],
      };
      const asNumber: TableDef = {
        name: "gauge",
        fields: [{ kind: "scalar", name: "reading", type: "number" }],
        search: [],
      };
      await adapter.sync([asText]);
      expect(warn).not.toHaveBeenCalled();

      await adapter.sync([asNumber]);
      await adapter.sync([asNumber, { name: "other", fields: [], search: [] }]);

      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("gauge.reading");
      expect(messages[0]).toContain('"text"');
      expect(messages[0]).toContain("double precision");
      expect(messages[0]).toContain("ALTER TABLE");

      expect(await columnsOf("gauge")).toMatchObject({ reading: "text" });
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet when nothing changed type", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await adapter.sync([product, brand, category]);
      await adapter.sync([product, brand, category]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("rolls the whole migration back when a statement fails, then succeeds on retry", async () => {
    const broken = watched((statement) => statement.includes("note__tags"));
    await broken.adapter.connect();

    await expect(broken.adapter.sync([notes])).rejects.toThrow(
      /injected failure/,
    );

    // Nothing half-built: not the table created before the failing statement, and no recorded
    // schema hash that would make the next boot skip the work.
    expect(await tablesOf()).not.toContain("note");
    expect(await tablesOf()).not.toContain("njin_schema_meta");

    await adapter.sync([notes]);
    expect(await tablesOf()).toEqual(
      expect.arrayContaining(["note", "note__tags"]),
    );
  });

  it("takes the schema lock before changing anything, and a recorded schema does no DDL", async () => {
    const first = watched();
    await first.adapter.connect();
    await first.adapter.sync([notes]);

    const lockAt = first.statements.findIndex((s) =>
      s.includes("pg_advisory_xact_lock"),
    );
    const firstDdl = first.statements.findIndex((s) =>
      /^(create|alter) /i.test(s),
    );
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(firstDdl);

    // A second process booting against the already-migrated database.
    const second = watched();
    await second.adapter.connect();
    await second.adapter.sync([notes]);

    expect(
      second.statements.some((s) => s.includes("pg_advisory_xact_lock")),
    ).toBe(true);
    expect(second.statements.some((s) => /^alter table/i.test(s))).toBe(false);
    expect(
      second.statements.some((s) =>
        /^create table if not exists "[^"]+"\."note/i.test(s),
      ),
    ).toBe(false);
  });

  it("two adapters booting at the same time both end up with the full schema", async () => {
    // PGlite runs one query at a time, so this checks they don't trip over each other, not
    // true parallelism — that needs a real server (postgres_server.test.ts).
    const a = await open();
    const b = await open();

    const results = await Promise.allSettled([
      a.sync([notes]),
      b.sync([notes]),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await tablesOf()).toEqual(
      expect.arrayContaining(["note", "note__tags"]),
    );
  });

  it("a unique index that can't be built (existing duplicates) is reported and the rest still migrates", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loose: TableDef = {
        name: "account",
        fields: [str("email")],
        search: [],
      };
      await adapter.sync([loose]);
      await adapter.insert(loose, { email: "same@example.com" });
      await adapter.insert(loose, { email: "same@example.com" });

      const strict: TableDef = {
        name: "account",
        fields: [
          { kind: "scalar", name: "email", type: "string", unique: true },
        ],
        search: [],
      };
      await adapter.sync([strict, notes]);

      expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toContain(
        "account.email",
      );
      // The migration went on to build the other table, inside the same transaction.
      expect(await tablesOf()).toContain("note__tags");
      expect(await adapter.count(strict)).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("what a failure reveals", () => {
  it("does not put the query or its parameters in the error that reaches logs", async () => {
    const account: TableDef = {
      name: "account",
      fields: [str("email"), str("secret")],
      search: [],
    };
    await adapter.sync([account]);
    await adapter.insert(
      account,
      { email: "a@example.com", secret: "S3CRET-HASH" },
      { id: "dup" },
    );

    const error = await adapter
      .insert(
        account,
        { email: "victim@example.com", secret: "S3CRET-HASH" },
        { id: "dup" },
      )
      .then(
        () => undefined,
        (e: unknown) => e as Error & Record<string, unknown>,
      );

    expect(error).toBeDefined();
    const everything = `${error?.message} ${JSON.stringify(error, Object.getOwnPropertyNames(error as object))}`;
    expect(everything).not.toContain("S3CRET-HASH");
    expect(everything).not.toContain("victim@example.com");
    expect(everything).not.toContain("insert into");
    expect(error).not.toHaveProperty("params");
    expect(error).not.toHaveProperty("query");

    // Still enough to act on: what kind of failure it was.
    expect(error?.name).toBe("DbError");
    expect(error?.code).toBe("23505");
  });

  it("leaves errors that did not come from the driver untouched", async () => {
    await expect(
      adapter.insert(product, { title: "x", releasedAt: "not a date" }),
    ).rejects.toThrow(/valid datetime/);
  });
});

describe("free-form documents and hostile keys", () => {
  it("keeps __proto__ in a document from changing the row's prototype", async () => {
    const vars: TableDef = {
      name: "vars",
      fields: [],
      search: [],
      document: true,
    };
    await adapter.sync([vars]);

    await adapter.upsert(
      vars,
      "general",
      JSON.parse(
        '{"siteName":"x","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
      ),
    );
    const row = await adapter.find(vars, "general");

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect((row as Record<string, unknown>).polluted).toBeUndefined();
    expect(row?.siteName).toBe("x");
  });
});
