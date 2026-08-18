import { describe, expect, it, mock } from "bun:test";
import { RecordId, Table } from "surrealdb";

// makeModel's create/update/destroy talk to SurrealDB via `surreal()` — replace it with
// an in-memory fake so hook wiring can be verified without a live database connection.
const records = new Map<string, Record<string, unknown>>();

const fakeDb = {
  create: (table: Table) => ({
    content: (data: Record<string, unknown>) => ({
      output: async (_mode: string) => {
        const id = new RecordId(table.name, "1");
        const record = { ...data, id };
        records.set(String(id), record);
        return [record];
      },
    }),
  }),
  update: (id: RecordId) => ({
    merge: async (data: Record<string, unknown>) => {
      const existing = records.get(String(id)) ?? {};
      const record = { ...existing, ...data, id };
      records.set(String(id), record);
      return record;
    },
  }),
  delete: async (id: RecordId) => {
    const record = records.get(String(id)) ?? { id };
    records.delete(String(id));
    return record;
  },
  queries: [] as { sql: string; params: Record<string, unknown> }[],
  query: async function (sql: string, params: Record<string, unknown> = {}) {
    fakeDb.queries.push({ sql, params });
    return [[], [{ count: 0 }]];
  },
};

mock.module("../../../src/modules/surreal", () => ({
  default: () => fakeDb,
}));

const { makeModel, afterCreate, afterDestroy, afterUpdate, beforeCreate, beforeDestroy, beforeUpdate } = await import(
  "../../../src/core/model/index"
);
const { text } = await import("../../../src/core/model/data_type/text");
const z = (await import("zod")).default;

describe("makeModel hook wiring", () => {
  it("runs beforeCreate/afterCreate around create()", async () => {
    const post = makeModel(`post_${crypto.randomUUID().replace(/-/g, "")}`, {
      name: "Post",
      searchFields: [],
      schema: z.object({ title: text({ label: "Title" }) }),
    });

    const events: string[] = [];
    let createdRecord: unknown;

    beforeCreate(post, (data) => {
      events.push("beforeCreate");
      return { title: `${data.title}!` };
    });
    afterCreate(post, (record) => {
      events.push("afterCreate");
      createdRecord = record;
    });

    const result = await post.create({ title: "Hello" });

    expect(events).toEqual(["beforeCreate", "afterCreate"]);
    expect(result.title).toBe("Hello!");
    expect(createdRecord).toEqual(result);
  });

  it("runs beforeUpdate/afterUpdate around update()", async () => {
    const post = makeModel(`post_${crypto.randomUUID().replace(/-/g, "")}`, {
      name: "Post",
      searchFields: [],
      schema: z.object({ title: text({ label: "Title" }) }),
    });

    const created = await post.create({ title: "Hello" });
    const id = created.id.id as string;

    const events: string[] = [];
    let receivedContext: unknown;

    beforeUpdate(post, (data, context) => {
      events.push("beforeUpdate");
      receivedContext = context;
      return { title: `${data.title}?` };
    });
    afterUpdate(post, () => {
      events.push("afterUpdate");
    });

    const result = await post.update(id, { title: "Hi" });

    expect(events).toEqual(["beforeUpdate", "afterUpdate"]);
    expect(receivedContext).toEqual({ id });
    expect(result.title).toBe("Hi?");
  });

  it("runs beforeDestroy/afterDestroy around destroy()", async () => {
    const post = makeModel(`post_${crypto.randomUUID().replace(/-/g, "")}`, {
      name: "Post",
      searchFields: [],
      schema: z.object({ title: text({ label: "Title" }) }),
    });

    const created = await post.create({ title: "Hello" });
    const id = created.id.id as string;

    const events: string[] = [];
    let receivedId: unknown;

    beforeDestroy(post, (destroyId) => {
      events.push("beforeDestroy");
      receivedId = destroyId;
    });
    afterDestroy(post, () => {
      events.push("afterDestroy");
    });

    await post.destroy(id);

    expect(events).toEqual(["beforeDestroy", "afterDestroy"]);
    expect(receivedId).toBe(id);
  });

  it("aborts create() when a beforeCreate hook throws", async () => {
    const post = makeModel(`post_${crypto.randomUUID().replace(/-/g, "")}`, {
      name: "Post",
      searchFields: [],
      schema: z.object({ title: text({ label: "Title" }) }),
    });

    beforeCreate(post, () => {
      throw new Error("nope");
    });

    await expect(post.create({ title: "Hello" })).rejects.toThrow("nope");
  });
});

describe("makeModel read() filter whitelist", () => {
  it("ignores a filter key that isn't a real schema field, even one only reachable via Object.prototype", async () => {
    const post = makeModel(`post_${crypto.randomUUID().replace(/-/g, "")}`, {
      name: "Post",
      searchFields: [],
      schema: z.object({ title: text({ label: "Title" }) }),
    });

    fakeDb.queries.length = 0;

    // `"constructor" in {}` is true (inherited from Object.prototype) even though no
    // schema field is named "constructor" — a plain `key in shape` check would let this
    // through and interpolate "constructor" as a raw SQL field name.
    await post.read({ filters: { constructor: "evil" } as never });

    const [call] = fakeDb.queries;
    expect(call!.sql).not.toContain("constructor");
    expect(call!.params).not.toHaveProperty("f_constructor");
  });

  it("still applies a filter on a real schema field", async () => {
    const post = makeModel(`post_${crypto.randomUUID().replace(/-/g, "")}`, {
      name: "Post",
      searchFields: [],
      schema: z.object({ title: text({ label: "Title" }) }),
    });

    fakeDb.queries.length = 0;

    await post.read({ filters: { title: "Hello" } });

    const [call] = fakeDb.queries;
    expect(call!.sql).toContain("title = $f_title");
    expect(call!.params.f_title).toBe("Hello");
  });
});

describe("makeModel read() search", () => {
  it("matches with the @N@ full-text operator and orders by relevance, stripping __relevance from results", async () => {
    const post = makeModel(`post_${crypto.randomUUID().replace(/-/g, "")}`, {
      name: "Post",
      searchFields: ["title", "body"],
      schema: z.object({ title: text({ label: "Title" }), body: text({ label: "Body" }) }),
    });

    fakeDb.queries.length = 0;
    const originalQuery = fakeDb.query;
    fakeDb.query = (async (sql: string, params: Record<string, unknown> = {}) => {
      fakeDb.queries.push({ sql, params });
      return [[{ title: "Hello", body: "World", __relevance: 1.5 }], [{ count: 1 }]];
    }) as typeof fakeDb.query;

    try {
      const result = await post.read({ search: "hello" });

      const [call] = fakeDb.queries;
      // @N@, not string::similarity::jaro_winkler — a whole-field comparison would score a
      // short query against a long field far below any usable threshold.
      expect(call!.sql).toContain("(title @1@ $search OR body @2@ $search)");
      expect(call!.sql).toContain("(search::score(1) + search::score(2)) AS __relevance");
      expect(call!.sql).toContain("ORDER BY __relevance DESC");
      expect(call!.params.search).toBe("hello");

      expect(result.data).toEqual([{ title: "Hello", body: "World" }] as never);
    } finally {
      fakeDb.query = originalQuery;
    }
  });

  it("lets an explicit sort win over relevance ordering", async () => {
    const post = makeModel(`post_${crypto.randomUUID().replace(/-/g, "")}`, {
      name: "Post",
      searchFields: ["title"],
      schema: z.object({ title: text({ label: "Title" }) }),
    });

    fakeDb.queries.length = 0;

    await post.read({ search: "hello", sort: "title", order: "desc" });

    const [call] = fakeDb.queries;
    expect(call!.sql).toContain("ORDER BY title DESC");
    expect(call!.sql).not.toContain("__relevance");
  });
});
