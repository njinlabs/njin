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
  query: async () => [[{ count: 0 }]],
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
