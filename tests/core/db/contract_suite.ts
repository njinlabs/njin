import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DbAdapter, TableDef } from "../../../src/core/db/contract";

// The behavioural contract every DbAdapter has to satisfy. Run it against an adapter with
// describeAdapter(name, factory) — see surreal_adapter.test.ts. Nothing in here may assume a
// particular database: ids are opaque strings, and search is only checked as far as the
// adapter's own `capabilities.search` promises.

const author: TableDef = {
  name: "author",
  fields: [{ kind: "scalar", name: "name", type: "string" }],
  search: [{ table: "author", field: "name" }],
};

const category: TableDef = {
  name: "category",
  fields: [{ kind: "scalar", name: "name", type: "string" }],
  search: [],
};

const post: TableDef = {
  name: "post",
  fields: [
    { kind: "scalar", name: "title", type: "string" },
    { kind: "scalar", name: "status", type: "string" },
    { kind: "scalar", name: "views", type: "number" },
    { kind: "scalar", name: "published", type: "boolean" },
    // Shapeless data (z.any(), z.record()): the one place a SQL adapter keeps JSON.
    { kind: "scalar", name: "extra", type: "json" },
    { kind: "array", name: "tags", of: { kind: "scalar", type: "string" } },
    {
      kind: "object",
      name: "seo",
      fields: [
        { kind: "scalar", name: "title", type: "string" },
        { kind: "scalar", name: "description", type: "string" },
      ],
    },
    {
      kind: "array",
      name: "items",
      of: {
        kind: "object",
        fields: [
          { kind: "scalar", name: "sku", type: "string" },
          { kind: "scalar", name: "qty", type: "number" },
        ],
      },
    },
    { kind: "one", name: "author", target: "author" },
    { kind: "many", name: "categories", target: "category" },
  ],
  search: [
    { table: "post", field: "title" },
    { table: "author", field: "name", via: "author" },
  ],
};

// A free-form document table, like njin's VARS groups.
const settings: TableDef = {
  name: "settings",
  fields: [],
  search: [],
  document: true,
};

const ALL = [author, category, post, settings];

let tick = 0;
const stamp = () => {
  // Monotonic, valid ISO strings — createdAt/updatedAt are the model layer's job, so the
  // suite supplies them like the model would.
  tick += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
};
const meta = () => ({ createdAt: stamp(), updatedAt: stamp() });

export const describeAdapter = (
  name: string,
  factory: () => DbAdapter | Promise<DbAdapter>,
) => {
  describe(`DbAdapter contract: ${name}`, () => {
    let db: DbAdapter;

    beforeEach(async () => {
      db = await factory();
      await db.connect();
      await db.sync(ALL);
    });

    afterEach(async () => {
      await db.close();
    });

    const mkPost = (data: Record<string, unknown> = {}, id?: string) =>
      db.insert(
        post,
        {
          title: "Hello",
          status: "draft",
          views: 0,
          published: false,
          tags: [],
          ...meta(),
          ...data,
        },
        id ? { id } : undefined,
      );

    describe("ids", () => {
      it("generates a plain string id", async () => {
        const row = await mkPost();
        expect(typeof row.id).toBe("string");
        expect(row.id).not.toContain(":");
        expect(row.id.length).toBeGreaterThan(0);
      });

      it("honours an explicit id and rejects a duplicate", async () => {
        const row = await mkPost({}, "fixed");
        expect(row.id).toBe("fixed");
        await expect(mkPost({}, "fixed")).rejects.toThrow();
      });

      it("round-trips through find()", async () => {
        const row = await mkPost({ title: "Round trip" });
        const found = await db.find(post, row.id);
        expect(found?.id).toBe(row.id);
        expect(found?.title).toBe("Round trip");
      });

      it("find() returns null for a missing id", async () => {
        expect(await db.find(post, "nope")).toBeNull();
      });
    });

    describe("structured fields", () => {
      it("stores and returns nested objects and arrays as plain values", async () => {
        const row = await mkPost({
          tags: ["a", "b", "c"],
          seo: { title: "S", description: "D" },
          items: [
            { sku: "x", qty: 1 },
            { sku: "y", qty: 2 },
          ],
        });
        const found = await db.find(post, row.id);
        expect(found?.tags).toEqual(["a", "b", "c"]);
        expect(found?.seo).toEqual({ title: "S", description: "D" });
        expect(found?.items).toEqual([
          { sku: "x", qty: 1 },
          { sku: "y", qty: 2 },
        ]);
      });

      it("preserves array order", async () => {
        const row = await mkPost({ tags: ["z", "a", "m"] });
        expect((await db.find(post, row.id))?.tags).toEqual(["z", "a", "m"]);
      });
    });

    describe("update", () => {
      it("changes only the keys present", async () => {
        const row = await mkPost({ title: "Old", views: 5 });
        const updated = await db.update(post, row.id, { title: "New" });
        expect(updated?.title).toBe("New");
        expect(updated?.views).toBe(5);
      });

      it("merges an object field key by key", async () => {
        const row = await mkPost({ seo: { title: "T", description: "D" } });
        const updated = await db.update(post, row.id, {
          seo: { title: "T2" },
        });
        expect(updated?.seo).toEqual({ title: "T2", description: "D" });
      });

      it("replaces an array as a whole", async () => {
        const row = await mkPost({ tags: ["a", "b", "c"] });
        const updated = await db.update(post, row.id, { tags: ["x"] });
        expect(updated?.tags).toEqual(["x"]);
      });

      it("leaves undefined alone and clears with null", async () => {
        const row = await mkPost({ title: "Keep", views: 9 });
        const updated = await db.update(post, row.id, {
          title: undefined,
          views: null,
        });
        expect(updated?.title).toBe("Keep");
        expect(updated?.views).toBeNull();
      });

      it("returns null for a missing row and does not create it", async () => {
        expect(await db.update(post, "ghost", { title: "x" })).toBeNull();
        expect(await db.find(post, "ghost")).toBeNull();
      });
    });

    describe("upsert", () => {
      it("creates the row, then patches it", async () => {
        const first = await db.upsert(post, "u1", {
          title: "One",
          seo: { title: "A", description: "B" },
          ...meta(),
        });
        expect(first.id).toBe("u1");

        const second = await db.upsert(post, "u1", { seo: { title: "C" } });
        expect(second.title).toBe("One");
        expect(second.seo).toEqual({ title: "C", description: "B" });
        expect(await db.count(post)).toBe(1);
      });
    });

    describe("remove", () => {
      it("returns the removed row, then null", async () => {
        const row = await mkPost({ title: "Bye" });
        const removed = await db.remove(post, row.id);
        expect(removed?.id).toBe(row.id);
        expect(removed?.title).toBe("Bye");
        expect(await db.find(post, row.id)).toBeNull();
        expect(await db.remove(post, row.id)).toBeNull();
      });
    });

    describe("relations", () => {
      it("accepts plain id strings and returns them unpopulated as strings", async () => {
        const a = await db.insert(author, { name: "Ann", ...meta() });
        const c1 = await db.insert(category, { name: "C1", ...meta() });
        const c2 = await db.insert(category, { name: "C2", ...meta() });
        const row = await mkPost({ author: a.id, categories: [c2.id, c1.id] });

        const found = await db.find(post, row.id);
        expect(found?.author).toBe(a.id);
        expect(found?.categories).toEqual([c2.id, c1.id]);
      });

      it("populates a one link and a many link, in order", async () => {
        const a = await db.insert(author, { name: "Ann", ...meta() });
        const c1 = await db.insert(category, { name: "C1", ...meta() });
        const c2 = await db.insert(category, { name: "C2", ...meta() });
        const row = await mkPost({ author: a.id, categories: [c2.id, c1.id] });

        const found = await db.find(post, row.id, {
          populate: ["author", "categories"],
        });
        expect(found?.author).toMatchObject({ id: a.id, name: "Ann" });
        const categories = found?.categories as { id: string; name: string }[];
        expect(categories.map((c) => c.name)).toEqual(["C2", "C1"]);
      });

      it("leaves a dangling link as its raw id when populating", async () => {
        const a = await db.insert(author, { name: "Gone", ...meta() });
        const row = await mkPost({ author: a.id });
        await db.remove(author, a.id);

        const found = await db.find(post, row.id, { populate: ["author"] });
        expect(found?.author).toBe(a.id);
      });

      it("ignores populate names that are not relation fields", async () => {
        const row = await mkPost();
        const found = await db.find(post, row.id, { populate: ["title"] });
        expect(found?.title).toBe("Hello");
      });
    });

    describe("list", () => {
      beforeEach(async () => {
        await mkPost(
          {
            title: "Alpha",
            status: "live",
            views: 10,
            published: true,
            tags: ["x", "y"],
          },
          "p1",
        );
        await mkPost(
          {
            title: "Beta",
            status: "live",
            views: 20,
            published: false,
            tags: ["y"],
          },
          "p2",
        );
        await mkPost(
          {
            title: "Gamma",
            status: "draft",
            views: 30,
            published: true,
            tags: [],
          },
          "p3",
        );
        await mkPost(
          {
            title: "alphabet soup",
            status: "draft",
            views: 40,
            published: false,
            tags: ["z"],
          },
          "p4",
        );
      });

      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
      const base = { page: 1, limit: 20, populate: [] as string[] };

      it("returns rows with the total", async () => {
        const res = await db.list(post, base);
        expect(res.total).toBe(4);
        expect(res.rows).toHaveLength(4);
        expect(typeof res.rows[0]!.id).toBe("string");
      });

      it("paginates and reports the full total", async () => {
        const sort = { field: "views", order: "asc" as const };
        const p1 = await db.list(post, { ...base, limit: 3, page: 1, sort });
        const p2 = await db.list(post, { ...base, limit: 3, page: 2, sort });
        expect(ids(p1.rows)).toEqual(["p1", "p2", "p3"]);
        expect(ids(p2.rows)).toEqual(["p4"]);
        expect(p1.total).toBe(4);
        expect(p2.total).toBe(4);
      });

      it("sorts ascending and descending", async () => {
        const asc = await db.list(post, {
          ...base,
          sort: { field: "views", order: "asc" },
        });
        const desc = await db.list(post, {
          ...base,
          sort: { field: "views", order: "desc" },
        });
        expect(ids(asc.rows)).toEqual(["p1", "p2", "p3", "p4"]);
        expect(ids(desc.rows)).toEqual(["p4", "p3", "p2", "p1"]);
      });

      const filtered = async (
        field: string,
        op: string,
        value: string | number | boolean,
      ) =>
        ids(
          (
            await db.list(post, {
              ...base,
              where: [{ field, op: op as never, value }],
              sort: { field: "views", order: "asc" },
            })
          ).rows,
        );

      it("$eq / $ne", async () => {
        expect(await filtered("status", "$eq", "live")).toEqual(["p1", "p2"]);
        expect(await filtered("status", "$ne", "live")).toEqual(["p3", "p4"]);
        expect(await filtered("published", "$eq", true)).toEqual(["p1", "p3"]);
      });

      it("$gt / $gte / $lt / $lte", async () => {
        expect(await filtered("views", "$gt", 20)).toEqual(["p3", "p4"]);
        expect(await filtered("views", "$gte", 20)).toEqual(["p2", "p3", "p4"]);
        expect(await filtered("views", "$lt", 20)).toEqual(["p1"]);
        expect(await filtered("views", "$lte", 20)).toEqual(["p1", "p2"]);
      });

      it("$contains / $startsWith / $ieq are case-insensitive", async () => {
        expect(await filtered("title", "$contains", "ALPH")).toEqual([
          "p1",
          "p4",
        ]);
        expect(await filtered("title", "$startsWith", "ALPHA")).toEqual([
          "p1",
          "p4",
        ]);
        expect(await filtered("title", "$ieq", "BETA")).toEqual(["p2"]);
      });

      it("$in matches an array field containing the value", async () => {
        expect(await filtered("tags", "$in", "y")).toEqual(["p1", "p2"]);
        expect(await filtered("tags", "$in", "nope")).toEqual([]);
      });

      it("filters on id", async () => {
        expect(await filtered("id", "$eq", "p3")).toEqual(["p3"]);
        expect(await filtered("id", "$ne", "p3")).toEqual(["p1", "p2", "p4"]);
      });

      it("ANDs several conditions", async () => {
        const res = await db.list(post, {
          ...base,
          where: [
            { field: "status", op: "$eq", value: "draft" },
            { field: "published", op: "$eq", value: true },
          ],
        });
        expect(ids(res.rows)).toEqual(["p3"]);
        expect(res.total).toBe(1);
      });

      it("projects selected fields, always including id", async () => {
        const res = await db.list(post, {
          ...base,
          select: { fields: ["title"], nested: {} },
          sort: { field: "views", order: "asc" },
        });
        expect(res.rows[0]).toEqual({ id: "p1", title: "Alpha" });
      });

      it("projects fields of a linked row", async () => {
        const a = await db.insert(author, { name: "Ann", ...meta() });
        await db.update(post, "p1", { author: a.id });

        const res = await db.list(post, {
          ...base,
          where: [{ field: "id", op: "$eq", value: "p1" }],
          select: { fields: ["title"], nested: { author: ["name"] } },
        });
        expect(res.rows[0]).toEqual({
          id: "p1",
          title: "Alpha",
          author: { id: a.id, name: "Ann" },
        });
      });

      it("populates relations on request", async () => {
        const a = await db.insert(author, { name: "Ann", ...meta() });
        await db.update(post, "p1", { author: a.id });

        const bare = await db.list(post, {
          ...base,
          where: [{ field: "id", op: "$eq", value: "p1" }],
        });
        expect(bare.rows[0]!.author).toBe(a.id);

        const full = await db.list(post, {
          ...base,
          populate: ["author"],
          where: [{ field: "id", op: "$eq", value: "p1" }],
        });
        expect(full.rows[0]!.author).toMatchObject({ id: a.id, name: "Ann" });
      });

      it("rejects an unsafe field name instead of querying with it", async () => {
        await expect(
          db.list(post, {
            ...base,
            where: [{ field: "title; DELETE post", op: "$eq", value: "x" }],
          }),
        ).rejects.toThrow();
        expect(await db.count(post)).toBe(4);
      });
    });

    describe("count / removeWhere / countBy", () => {
      beforeEach(async () => {
        await mkPost({ status: "a", createdAt: "2026-01-05T00:00:00.000Z" });
        await mkPost({ status: "a", createdAt: "2026-01-20T00:00:00.000Z" });
        await mkPost({ status: "b", createdAt: "2026-02-03T00:00:00.000Z" });
      });

      it("counts, with and without conditions, on an empty table too", async () => {
        expect(await db.count(post)).toBe(3);
        expect(
          await db.count(post, [{ field: "status", op: "$eq", value: "a" }]),
        ).toBe(2);
        expect(await db.count(category)).toBe(0);
      });

      it("removeWhere deletes matching rows and reports how many", async () => {
        const removed = await db.removeWhere(post, [
          { field: "status", op: "$eq", value: "a" },
        ]);
        expect(removed).toBe(2);
        expect(await db.count(post)).toBe(1);
      });

      it("countBy groups on a field, most frequent first", async () => {
        const res = await db.countBy({ table: "post", groupBy: "status" });
        expect(res).toEqual([
          { key: "a", count: 2 },
          { key: "b", count: 1 },
        ]);
      });

      it("countBy groups on a string prefix, ascending by key", async () => {
        const res = await db.countBy({
          table: "post",
          groupBy: "createdAt",
          prefix: 7,
        });
        expect(res).toEqual([
          { key: "2026-01", count: 2 },
          { key: "2026-02", count: 1 },
        ]);
      });

      it("countBy honours conditions", async () => {
        const res = await db.countBy({
          table: "post",
          groupBy: "status",
          where: [
            {
              field: "createdAt",
              op: "$gte",
              value: "2026-02-01T00:00:00.000Z",
            },
          ],
        });
        expect(res).toEqual([{ key: "b", count: 1 }]);
      });
    });

    describe("shapeless and free-form data", () => {
      const samples: unknown[] = [
        { a: [1, "two", { three: 3 }], nested: { deep: { deeper: true } } },
        "just a string",
        'a "quoted" string with \\ and \n and unicode ✓',
        42,
        3.5,
        true,
        false,
        [1, 2, 3],
        [],
        {},
        '{"looks":"like json"}',
      ];

      it("round-trips any JSON value in a json field, unchanged and not double-encoded", async () => {
        for (const sample of samples) {
          const row = await mkPost({ extra: sample });
          const found = await db.find(post, row.id);
          expect(found?.extra).toEqual(sample);
        }
      });

      it("clears a json field with null", async () => {
        const row = await mkPost({ extra: { a: 1 } });
        const updated = await db.update(post, row.id, { extra: null });
        expect(updated?.extra ?? null).toBeNull();
      });

      it("keeps free-form documents: undeclared keys stored and read back, nested values intact", async () => {
        const stamp = "2026-05-06T07:08:09.010Z";
        await db.upsert(settings, "general", {
          siteName: "My Site",
          theme: { dark: true, accents: ["red", "blue"] },
          maintenance: false,
          updatedAt: stamp,
        });

        const found = await db.find(settings, "general");
        expect(found).toMatchObject({
          id: "general",
          siteName: "My Site",
          theme: { dark: true, accents: ["red", "blue"] },
          maintenance: false,
          updatedAt: stamp,
        });
      });

      it("merges a document update key by key and leaves the rest", async () => {
        await db.upsert(settings, "seo", { title: "T", description: "D" });
        const merged = await db.upsert(settings, "seo", { title: "T2" });

        expect(merged).toMatchObject({ title: "T2", description: "D" });
        expect(await db.count(settings)).toBe(1);
      });

      it("keeps documents separate by id, and returns null for a missing one", async () => {
        await db.upsert(settings, "a", { v: 1 });
        await db.upsert(settings, "b", { v: 2 });

        expect((await db.find(settings, "a"))?.v).toBe(1);
        expect((await db.find(settings, "b"))?.v).toBe(2);
        expect(await db.find(settings, "missing")).toBeNull();
      });
    });

    // Everything below feeds an adapter the kind of input an attacker controls and checks two
    // things: nothing is executed (the data is intact afterwards) and nothing is mistaken for
    // syntax (hostile text is stored and compared as plain text).
    describe("hostile input", () => {
      const PAYLOADS = [
        "' OR '1'='1",
        "'; DROP TABLE post; --",
        '" OR 1=1 --',
        "x') OR true --",
        "' OR 1=1 --",
        "post:abc",
        "$parent",
        "]); DELETE post; //",
        "1; DELETE post",
        "title = 'x' OR id != 'y'",
        " ‮ unicode",
      ];
      const base = { page: 1, limit: 50, populate: [] as string[] };

      const seedThree = async () => {
        await mkPost({ title: "100% sure", status: "a" }, "h1");
        await mkPost({ title: "snake_case name", status: "b" }, "h2");
        await mkPost({ title: "plain title", status: "c" }, "h3");
      };

      const intact = async () => {
        expect(await db.count(post)).toBe(3);
        expect((await db.find(post, "h3"))?.title).toBe("plain title");
      };

      it("compares a hostile value as plain text, whatever the operator", async () => {
        await seedThree();

        for (const payload of PAYLOADS) {
          for (const op of [
            "$eq",
            "$ne",
            "$contains",
            "$startsWith",
            "$ieq",
          ] as const) {
            const res = await db.list(post, {
              ...base,
              where: [{ field: "title", op, value: payload }],
            });
            // "$ne" matches everything (nothing equals the payload); the rest match nothing.
            expect(res.total).toBe(op === "$ne" ? 3 : 0);
          }
        }
        await intact();
      });

      it("treats LIKE wildcards in $contains/$startsWith as literal characters", async () => {
        await seedThree();

        const contains = async (value: string) =>
          (
            await db.list(post, {
              ...base,
              where: [{ field: "title", op: "$contains", value }],
            })
          ).rows.map((r) => r.id);

        expect(await contains("%")).toEqual(["h1"]);
        expect(await contains("_")).toEqual(["h2"]);
        expect(await contains("%%")).toEqual([]);
        expect(
          (
            await db.list(post, {
              ...base,
              where: [{ field: "title", op: "$startsWith", value: "_" }],
            })
          ).total,
        ).toBe(0);
      });

      it("stores hostile text exactly as given and reads it back unchanged", async () => {
        for (const payload of PAYLOADS) {
          const row = await mkPost({
            title: payload,
            tags: [payload],
            seo: { title: payload, description: payload },
          });
          const found = await db.find(post, row.id);

          expect(found?.title).toBe(payload);
          expect(found?.tags).toEqual([payload]);
          expect(found?.seo).toEqual({ title: payload, description: payload });

          const byValue = await db.list(post, {
            ...base,
            where: [{ field: "title", op: "$eq", value: payload }],
          });
          expect(byValue.rows.map((r) => r.id)).toEqual([row.id]);
        }
        expect(await db.count(post)).toBe(PAYLOADS.length);
      });

      it("never lets a hostile search string run as a query", async () => {
        await seedThree();
        if (db.capabilities.search === "none") return;

        for (const payload of PAYLOADS) {
          const res = await db.list(post, { ...base, search: payload });
          expect(Array.isArray(res.rows)).toBe(true);
        }
        await intact();
      });

      it("rejects a hostile field name in a condition, sort or grouping, without running it", async () => {
        await seedThree();

        for (const payload of PAYLOADS) {
          await expect(
            db.list(post, {
              ...base,
              where: [{ field: payload, op: "$eq", value: "x" }],
            }),
          ).rejects.toThrow();
          await expect(
            db.list(post, { ...base, sort: { field: payload, order: "asc" } }),
          ).rejects.toThrow();
          await expect(
            db.countBy({ table: "post", groupBy: payload }),
          ).rejects.toThrow();
        }
        await intact();
      });

      it("ignores a hostile name in populate or select instead of building a query from it", async () => {
        await seedThree();

        for (const payload of PAYLOADS) {
          const outcome = await db
            .list(post, {
              ...base,
              populate: [payload],
              select: { fields: ["title", payload], nested: {} },
            })
            .then(
              () => "ok",
              () => "rejected",
            );
          expect(["ok", "rejected"]).toContain(outcome);
        }
        await intact();
      });

      it("treats a hostile id as an ordinary, unknown id", async () => {
        await seedThree();

        for (const payload of PAYLOADS) {
          expect(await db.find(post, payload)).toBeNull();
          expect(await db.update(post, payload, { title: "x" })).toBeNull();
          expect(await db.remove(post, payload)).toBeNull();
        }
        await intact();
      });

      it("accepts a hostile string as an explicit id and finds it again by that same id", async () => {
        for (const payload of PAYLOADS) {
          const row = await mkPost({ title: "t" }, payload);
          expect(row.id).toBe(payload);
          expect((await db.find(post, payload))?.title).toBe("t");
          expect((await db.remove(post, payload))?.id).toBe(payload);
        }
        expect(await db.count(post)).toBe(0);
      });

      it("rejects a hostile filter value as a relation id without side effects", async () => {
        await seedThree();
        for (const payload of PAYLOADS) {
          const res = await db.list(post, {
            ...base,
            where: [{ field: "author", op: "$eq", value: payload }],
          });
          expect(res.total).toBe(0);
        }
        await intact();
      });

      it("keeps __proto__ and similar keys in stored data from touching any prototype", async () => {
        const poisoned = JSON.parse(
          '{"title":"p","seo":{"title":"x","__proto__":{"polluted":true}},"items":[{"sku":"a","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}]}',
        );
        const row = await mkPost(poisoned);
        const found = await db.find(post, row.id);

        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.getPrototypeOf(found)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(found?.seo)).toBe(Object.prototype);
        const items = (found?.items ?? []) as { sku: string }[];
        expect(items[0]?.sku).toBe("a");
      });
    });

    describe("sync", () => {
      it("is idempotent", async () => {
        await db.sync(ALL);
        await db.sync(ALL);
        const row = await mkPost();
        expect(await db.find(post, row.id)).not.toBeNull();
      });
    });

    describe("search", () => {
      const base = { page: 1, limit: 20, populate: [] as string[] };

      // Skipped for an adapter that says it has no search at all.
      const searchIt = (title: string, fn: () => Promise<void>) =>
        it(title, async () => {
          if (db.capabilities.search === "none") return;
          await fn();
        });

      searchIt("finds a term anywhere in a searched field", async () => {
        await mkPost({ title: "Getting started with Next.js" }, "s1");
        await mkPost({ title: "Cooking pasta" }, "s2");

        const res = await db.list(post, { ...base, search: "next.js" });
        expect(res.rows.map((r) => r.id)).toEqual(["s1"]);
        expect(res.total).toBe(1);
      });

      searchIt("is case-insensitive", async () => {
        await mkPost({ title: "Getting started with Next.js" }, "s1");
        const res = await db.list(post, { ...base, search: "NEXT.JS" });
        expect(res.rows.map((r) => r.id)).toEqual(["s1"]);
      });

      searchIt("matches through a linked row's field", async () => {
        const a = await db.insert(author, { name: "Red Wing", ...meta() });
        await mkPost({ title: "Boots", author: a.id }, "s1");
        await mkPost({ title: "Sandals" }, "s2");

        const res = await db.list(post, { ...base, search: "red wing" });
        expect(res.rows.map((r) => r.id)).toEqual(["s1"]);
      });

      searchIt("ranks a real containment above a partial overlap", async () => {
        await mkPost({ title: "Notebook stand" }, "weak");
        await mkPost({ title: "The best notebook ever" }, "strong");

        const res = await db.list(post, { ...base, search: "best notebook" });
        expect(res.rows[0]!.id).toBe("strong");
      });

      searchIt("an explicit sort wins over relevance", async () => {
        await mkPost({ title: "alpha book", views: 1 }, "a");
        await mkPost({ title: "alpha book alpha book", views: 2 }, "b");

        const res = await db.list(post, {
          ...base,
          search: "alpha",
          sort: { field: "views", order: "desc" as const },
        });
        expect(res.rows.map((r) => r.id)).toEqual(["b", "a"]);
      });

      searchIt("combines with filters", async () => {
        await mkPost({ title: "alpha one", status: "live" }, "a");
        await mkPost({ title: "alpha two", status: "draft" }, "b");

        const res = await db.list(post, {
          ...base,
          search: "alpha",
          where: [{ field: "status", op: "$eq", value: "live" }],
        });
        expect(res.rows.map((r) => r.id)).toEqual(["a"]);
      });

      searchIt("never leaks its ranking column into rows", async () => {
        await mkPost({ title: "alpha one" }, "a");
        const res = await db.list(post, { ...base, search: "alpha" });
        expect(Object.keys(res.rows[0]!)).not.toContain("__relevance");
      });
    });
  });
};
