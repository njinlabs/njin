import { describe, expect, it } from "bun:test";
import type { ListQuery } from "../../../src/core/db/contract";
import { useTestDb } from "../../helpers/test_db";

// makeModel talks to the database through the db module — swap it for a real in-memory
// adapter (recording every call) so the model layer is exercised end to end.
const db = await useTestDb();

const {
  makeModel,
  afterCreate,
  afterDestroy,
  afterUpdate,
  beforeCreate,
  beforeDestroy,
  beforeUpdate,
} = await import("../../../src/core/model/index");
const { text } = await import("../../../src/core/model/data_type/text");
const { numeric } = await import("../../../src/core/model/data_type/numeric");
const { boolean } = await import("../../../src/core/model/data_type/boolean");
const { relation } = await import("../../../src/core/model/data_type/relation");
const { relationMany } = await import(
  "../../../src/core/model/data_type/relation_many"
);
const z = (await import("zod")).default;

type AnyModel = ReturnType<typeof makeModel>;

const unique = (base: string) =>
  `${base}_${crypto.randomUUID().replace(/-/g, "")}`;

// Registers the model's table with the test database (what the db module's spin() does).
const sync = async <M extends AnyModel>(first: M, ...rest: AnyModel[]) => {
  await db.sync([first.def, ...rest.map((m) => m.def)]);
  return first;
};

// The ListQuery the model passed to the adapter on its most recent read().
const lastQuery = () => {
  const lists = db.callsTo("list");
  return lists[lists.length - 1]![1] as ListQuery;
};

describe("makeModel hook wiring", () => {
  const build = () =>
    makeModel(unique("post"), {
      name: "Post",
      searchFields: [],
      schema: z.object({ title: text({ label: "Title" }) }),
    });

  it("runs beforeCreate/afterCreate around create()", async () => {
    const post = await sync(build());

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

  it("returns a plain string id with timestamps", async () => {
    const post = await sync(build());

    const result = await post.create({ title: "Hello" });

    expect(typeof result.id).toBe("string");
    // Two separate clock reads, so they can differ by a millisecond.
    expect(Number.isNaN(Date.parse(result.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(result.updatedAt))).toBe(false);
    expect(
      Date.parse(result.updatedAt) - Date.parse(result.createdAt),
    ).toBeLessThan(50);
  });

  it("runs beforeUpdate/afterUpdate around update()", async () => {
    const post = await sync(build());

    const created = await post.create({ title: "Hello" });
    const id = created.id;

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
    const post = await sync(build());

    const created = await post.create({ title: "Hello" });
    const id = created.id;

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
    expect(await post.show(id)).toBeUndefined();
  });

  it("aborts create() when a beforeCreate hook throws", async () => {
    const post = await sync(build());

    beforeCreate(post, () => {
      throw new Error("nope");
    });

    await expect(post.create({ title: "Hello" })).rejects.toThrow("nope");
  });
});

describe("makeModel unique fields", () => {
  const build = () =>
    makeModel(unique("account"), {
      name: "Account",
      searchFields: [],
      schema: z.object({
        email: text({ label: "Email", unique: true }),
      }),
    });

  it("rejects a duplicate on create and on update, but lets a record keep its own value", async () => {
    const account = await sync(build());

    const first = await account.create({ email: "a@example.com" });
    const second = await account.create({ email: "b@example.com" });

    await expect(account.create({ email: "a@example.com" })).rejects.toThrow(
      /must be unique/,
    );
    await expect(
      account.update(second.id, { email: "a@example.com" }),
    ).rejects.toThrow(/must be unique/);

    // Updating a record to the value it already has is not a duplicate of itself.
    const same = await account.update(first.id, { email: "a@example.com" });
    expect(same.email).toBe("a@example.com");
  });
});

describe("makeModel read() filter whitelist", () => {
  const build = () =>
    makeModel(unique("post"), {
      name: "Post",
      searchFields: [],
      schema: z.object({ title: text({ label: "Title" }) }),
    });

  it("ignores a filter key that isn't a real schema field, even one only reachable via Object.prototype", async () => {
    const post = await sync(build());

    // `"constructor" in {}` is true (inherited from Object.prototype) even though no
    // schema field is named "constructor" — a plain `key in shape` check would let this
    // through and hand "constructor" to the adapter as a field name.
    await post.read({ filters: { constructor: "evil" } as never });

    expect(lastQuery().where).toEqual([]);
  });

  it("still applies a filter on a real schema field", async () => {
    const post = await sync(build());
    await post.create({ title: "Hello" });
    await post.create({ title: "World" });

    const result = await post.read({ filters: { title: "Hello" } });

    expect(lastQuery().where).toEqual([
      { field: "title", op: "$eq", value: "Hello" },
    ]);
    expect(result.data.map((r) => r.title)).toEqual(["Hello"]);
    expect(result.meta.total).toBe(1);
  });
});

describe("makeModel read() select", () => {
  const build = () =>
    makeModel(unique("post"), {
      name: "Post",
      searchFields: [],
      schema: z.object({
        title: text({ label: "Title" }),
        slug: text({ label: "Slug" }),
      }),
    });

  it("projects only the selected fields, always including id", async () => {
    const post = await sync(build());
    const created = await post.create({ title: "T", slug: "s" });

    const result = await post.read({ select: ["title", "createdAt"] });

    expect(lastQuery().select).toEqual({
      fields: ["title", "createdAt"],
      nested: {},
    });
    expect(result.data[0]).toEqual({
      id: created.id,
      title: "T",
      createdAt: created.createdAt,
    } as never);
  });

  it("selects everything when select is omitted or has no valid field", async () => {
    const post = await sync(build());

    for (const select of [undefined, [], ["nope"]]) {
      await post.read({ select });
      expect(lastQuery().select).toBeUndefined();
    }
  });

  it("drops unknown, prototype-inherited and injection-shaped field names", async () => {
    const post = await sync(build());

    await post.read({
      select: [
        "constructor",
        "__proto__",
        "toString",
        "title, (SELECT * FROM user) AS leak",
        "title FROM user; --",
        "slug",
        "slug",
        42 as never,
      ],
    });

    expect(lastQuery().select).toEqual({ fields: ["slug"], nested: {} });
  });

  it("only populates relations that are selected", async () => {
    const author = makeModel(unique("author"), {
      name: "Author",
      searchFields: [],
      schema: z.object({ name: text({ label: "Name" }) }),
    });
    const post = makeModel(unique("post"), {
      name: "Post",
      searchFields: [],
      schema: z.object({
        title: text({ label: "Title" }),
        author: relation({ label: "Author" }, author),
      }),
    });
    await sync(author, post);

    await post.read({ select: ["title"] });
    expect(lastQuery().populate).toEqual([]);

    await post.read({ select: ["title", "author"] });
    expect(lastQuery().populate).toEqual(["author"]);
  });
});

describe("makeModel read() select on relations", () => {
  const build = async () => {
    const author = makeModel(unique("author"), {
      name: "Author",
      searchFields: [],
      schema: z.object({
        name: text({ label: "Name" }),
        secret: text({ label: "Secret" }),
      }),
    });
    const tag = makeModel(unique("tag"), {
      name: "Tag",
      searchFields: [],
      schema: z.object({ label: text({ label: "Label" }) }),
    });
    const post = makeModel(unique("post"), {
      name: "Post",
      searchFields: [],
      schema: z.object({
        title: text({ label: "Title" }),
        author: relation({ label: "Author" }, author),
        tags: relationMany({ label: "Tags" }, tag),
      }),
    });
    await sync(author, tag, post);
    return { post, author, tag };
  };

  const queryOf = async (select: string[], populate?: string[] | "none") => {
    const { post } = await build();
    await post.read({ select, populate });
    return lastQuery();
  };

  it("projects the picked fields of a related record and does not populate it", async () => {
    const q = await queryOf(["title", "author.name"]);
    expect(q.select).toEqual({
      fields: ["title"],
      nested: { author: ["name"] },
    });
    expect(q.populate).toEqual([]);
  });

  it("groups several fields per relation and supports multi relations", async () => {
    const q = await queryOf(["author.name", "author.secret", "tags.label"]);
    expect(q.select).toEqual({
      fields: [],
      nested: { author: ["name", "secret"], tags: ["label"] },
    });
  });

  it("accepts id/createdAt/updatedAt on the related record", async () => {
    const q = await queryOf(["author.createdAt", "author.id"]);
    expect(q.select!.nested).toEqual({ author: ["createdAt", "id"] });
  });

  it("lets the nested projection win over the same relation selected whole", async () => {
    const q = await queryOf(["author", "author.name"]);
    expect(q.select).toEqual({ fields: [], nested: { author: ["name"] } });
    expect(q.populate).toEqual([]);
  });

  it("still populates a relation selected whole next to a nested one", async () => {
    const q = await queryOf(["author.name", "tags"]);
    expect(q.select).toEqual({
      fields: ["tags"],
      nested: { author: ["name"] },
    });
    expect(q.populate).toEqual(["tags"]);
  });

  it("drops nested entries that point at unknown relations, unknown target fields, or too deep", async () => {
    const q = await queryOf([
      "title.x", // not a relation
      "author.nope", // not a field of the target
      "author.constructor", // inherited, not an own field
      "author.name.deep", // two levels
      "constructor.name",
      "author.name) AS x, (SELECT * FROM user",
      "author.",
      ".name",
    ]);
    expect(q.select).toBeUndefined();
  });

  it("returns the projected related record for real", async () => {
    const { post, author, tag } = await build();
    const a = await author.create({ name: "Ann", secret: "s3" });
    const t = await tag.create({ label: "news" });
    await post.create({ title: "Hello", author: a.id, tags: [t.id] } as never);

    const result = await post.read({
      select: ["title", "author.name", "tags.label"],
    });

    expect(result.data[0]).toMatchObject({
      title: "Hello",
      author: { id: a.id, name: "Ann" },
      tags: [{ id: t.id, label: "news" }],
    });
    expect((result.data[0] as { author: object }).author).not.toHaveProperty(
      "secret",
    );
  });
});

describe("makeModel read() filter values and limit", () => {
  const make = () =>
    makeModel(unique("item"), {
      name: "Item",
      searchFields: [],
      schema: z.object({
        title: text({ label: "Title" }),
        price: numeric({ label: "Price" }),
        active: boolean({ label: "Active" }),
      }),
    });

  it("converts numeric and boolean filter values to their real types", async () => {
    const item = await sync(make());
    await item.create({ title: "ab cheap", price: 50, active: true });
    await item.create({ title: "AB pricey", price: 150, active: true });
    await item.create({ title: "AB off", price: 200, active: false });

    const result = await item.read({
      filters: {
        price: { $gt: "100" },
        active: "true",
        title: { $contains: "AB" },
      },
    });

    expect(lastQuery().where).toEqual([
      { field: "price", op: "$gt", value: 100 },
      { field: "active", op: "$eq", value: true },
      { field: "title", op: "$contains", value: "AB" },
    ]);
    expect(result.data.map((r) => r.title)).toEqual(["AB pricey"]);
  });

  it("drops a numeric filter whose value isn't a number", async () => {
    const item = await sync(make());

    await item.read({ filters: { price: "abc" } });

    expect(lastQuery().where).toEqual([]);
  });

  it("ignores filters whose value is undefined", async () => {
    const item = await sync(make());

    await item.read({ filters: { title: undefined } });

    expect(lastQuery().where).toEqual([]);
  });

  it("never passes a non-numeric limit on", async () => {
    const item = await sync(make());

    await item.read({ limit: "1; DELETE item; //" as never });

    expect(lastQuery().limit).toBe(20);
    expect(lastQuery().page).toBe(1);
  });

  it("ignores an unknown filter operator", async () => {
    const item = await sync(make());

    await item.read({ filters: { title: { $regex: ".*" } as never } });

    expect(lastQuery().where).toEqual([]);
  });

  it("ignores a sort field that isn't in the schema", async () => {
    const item = await sync(make());

    await item.read({ sort: "constructor" });
    expect(lastQuery().sort).toBeUndefined();

    await item.read({ sort: "price", order: "desc" });
    expect(lastQuery().sort).toEqual({ field: "price", order: "desc" });
  });
});

describe("makeModel show()", () => {
  it("populates relation fields when the model has any", async () => {
    const author = makeModel(unique("author"), {
      name: "Author",
      searchFields: [],
      schema: z.object({ name: text({ label: "Name" }) }),
    });
    const post = makeModel(unique("post"), {
      name: "Post",
      searchFields: [],
      schema: z.object({
        title: text({ label: "Title" }),
        author: relation({ label: "Author" }, author),
      }),
    });
    await sync(author, post);

    const a = await author.create({ name: "Ann" });
    const p = await post.create({ title: "Hello", author: a.id } as never);

    const shown = await post.show(p.id);

    expect(db.callsTo("find").at(-1)![2]).toEqual({ populate: ["author"] });
    expect(shown.author).toMatchObject({ id: a.id, name: "Ann" });
  });

  it("asks for no population for a model without relations", async () => {
    const plain = await sync(
      makeModel(unique("plain"), {
        name: "Plain",
        searchFields: [],
        schema: z.object({ title: text({ label: "Title" }) }),
      }),
    );
    const p = await plain.create({ title: "x" });

    await plain.show(p.id);

    expect(db.callsTo("find").at(-1)![2]).toEqual({ populate: [] });
  });

  it("returns undefined for a record that doesn't exist", async () => {
    const plain = await sync(
      makeModel(unique("plain"), {
        name: "Plain",
        searchFields: [],
        schema: z.object({ title: text({ label: "Title" }) }),
      }),
    );

    expect(await plain.show("missing")).toBeUndefined();
  });
});

describe("filtersQuerySchema", () => {
  it("keeps operator objects intact and never stringifies them", async () => {
    const { filtersQuerySchema } = await import(
      "../../../src/core/model/index"
    );

    expect(
      filtersQuerySchema.parse({ price: { $gt: "100" }, title: "x" }),
    ).toEqual({ price: { $gt: "100" }, title: "x" });
    expect(filtersQuerySchema.safeParse({ price: 5 }).success).toBe(false);
  });
});

describe("makeModel read() search", () => {
  const build = () =>
    makeModel(unique("post"), {
      name: "Post",
      searchFields: ["title", "body"],
      schema: z.object({
        title: text({ label: "Title" }),
        body: text({ label: "Body" }),
      }),
    });

  it("describes the searchable fields to the adapter and returns ranked results without leaking the ranking column", async () => {
    const post = await sync(build());
    await post.create({ title: "Hello", body: "World" });
    await post.create({ title: "Unrelated", body: "Nothing here" });

    const result = await post.read({ search: "hello" });

    expect(post.def.search).toEqual([
      { table: post.prefix, field: "title" },
      { table: post.prefix, field: "body" },
    ]);
    expect(lastQuery().search).toBe("hello");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ title: "Hello", body: "World" });
    expect(Object.keys(result.data[0] as object)).not.toContain("__relevance");
  });

  it("does not pass a search on when the model has no searchFields", async () => {
    const plain = await sync(
      makeModel(unique("plain"), {
        name: "Plain",
        searchFields: [],
        schema: z.object({ title: text({ label: "Title" }) }),
      }),
    );

    await plain.read({ search: "hello" });

    expect(lastQuery().search).toBeUndefined();
  });

  it("lets an explicit sort win over relevance ordering", async () => {
    const post = await sync(build());

    await post.read({ search: "hello", sort: "title", order: "desc" });

    expect(lastQuery().sort).toEqual({ field: "title", order: "desc" });
  });
});

describe("makeModel read() nested relation search", () => {
  it("describes a relation searchField as a target on the linked table, reached via the local field", async () => {
    const author = makeModel(unique("author"), {
      name: "Author",
      searchFields: ["name"],
      schema: z.object({ name: text({ label: "Name" }) }),
    });
    const post = makeModel(unique("post"), {
      name: "Post",
      searchFields: ["title", "author.name"],
      schema: z.object({
        title: text({ label: "Title" }),
        author: relation({ label: "Author" }, author),
      }),
    });

    expect(post.def.search).toEqual([
      { table: post.prefix, field: "title" },
      { table: author.prefix, field: "name", via: "author" },
    ]);

    await sync(author, post);
    const a = await author.create({ name: "Red Wing" });
    await post.create({ title: "Boots", author: a.id } as never);
    await post.create({ title: "Sandals" } as never);

    const result = await post.read({ search: "red wing" });
    expect(result.data.map((r) => r.title)).toEqual(["Boots"]);
  });

  it("describes a multi_relation searchField the same way", async () => {
    const tag = makeModel(unique("tag"), {
      name: "Tag",
      searchFields: ["name"],
      schema: z.object({ name: text({ label: "Name" }) }),
    });
    const post = makeModel(unique("post"), {
      name: "Post",
      searchFields: ["tags.name"],
      schema: z.object({
        title: text({ label: "Title" }),
        tags: relationMany({ label: "Tags" }, tag),
      }),
    });

    expect(post.def.search).toEqual([
      { table: tag.prefix, field: "name", via: "tags" },
    ]);

    await sync(tag, post);
    const t = await tag.create({ name: "typescript" });
    await post.create({ title: "A", tags: [t.id] } as never);
    await post.create({ title: "B", tags: [] } as never);

    const result = await post.read({ search: "typescript" });
    expect(result.data.map((r) => r.title)).toEqual(["A"]);
  });

  it("throws at model-definition time when a searchField references a non-relation field", () => {
    expect(() =>
      makeModel(unique("post"), {
        name: "Post",
        searchFields: ["title.name"],
        schema: z.object({ title: text({ label: "Title" }) }),
      }),
    ).toThrow(/is not a relation\/file field/);
  });

  it("throws at model-definition time on more than one level of nesting", () => {
    expect(() =>
      makeModel(unique("post"), {
        name: "Post",
        searchFields: ["author.company.name"],
        schema: z.object({ title: text({ label: "Title" }) }),
      }),
    ).toThrow(/more than one level of nesting/);
  });

  it("throws at model-definition time when the target field doesn't exist on an already-registered target model", () => {
    const author = makeModel(unique("author"), {
      name: "Author",
      searchFields: [],
      schema: z.object({ name: text({ label: "Name" }) }),
    });

    expect(() =>
      makeModel(unique("post"), {
        name: "Post",
        searchFields: ["author.nickname"],
        schema: z.object({
          title: text({ label: "Title" }),
          author: relation({ label: "Author" }, author),
        }),
      }),
    ).toThrow(/does not exist on model/);
  });
});
