import { describe, expect, it } from "bun:test";
import { useTestDb } from "../../helpers/test_db";

const db = await useTestDb();

const { makeModel, afterPublish, afterUnpublish, isDraftable } = await import(
  "../../../src/core/model/index"
);
const { HttpError } = await import("../../../src/core/http_error");
const { text } = await import("../../../src/core/model/data_type/text");
const { array } = await import("../../../src/core/model/data_type/array");
const { relation } = await import("../../../src/core/model/data_type/relation");
const z = (await import("zod")).default;

const unique = (base: string) =>
  `${base}_${crypto.randomUUID().replace(/-/g, "")}`;

const linkId = (value: unknown) =>
  typeof value === "string" ? value : (value as { id: string }).id;

const buildAuthor = () =>
  makeModel(unique("author"), {
    name: "Author",
    searchFields: [],
    schema: z.object({ name: text({ label: "Name" }) }),
  });

const buildArticle = (author = buildAuthor()) => {
  const article = makeModel(unique("article"), {
    name: "Article",
    searchFields: ["title"],
    draftable: true,
    schema: z.object({
      slug: text({ label: "Slug", unique: true }),
      title: text({ label: "Title" }),
      tags: array({ label: "Tags" }, z.string()).optional(),
      author: relation({ label: "Author" }, author).optional(),
    }),
  });
  return { article, author };
};

const setup = async () => {
  const { article, author } = buildArticle();
  await db.sync([author.def, article.def, article.publishedDef]);
  return { article, author };
};

describe("draftable model", () => {
  it("starts a new record as a draft that is not live", async () => {
    const { article } = await setup();

    const created = await article.create({ slug: "a", title: "First" });

    expect(created.status).toBe("draft");
    expect(created.publishedAt).toBeNull();
    expect((await article.read()).data).toHaveLength(1);
    expect((await article.published.read()).data).toHaveLength(0);
    expect(await article.published.show(created.id)).toBeUndefined();
  });

  it("publish() copies the working copy, arrays and relations included", async () => {
    const { article, author } = await setup();
    const writer = await author.create({ name: "Budi" });
    const created = await article.create({
      slug: "a",
      title: "First",
      tags: ["x", "y"],
      author: writer.id as never,
    });

    const published = await article.publish(created.id);

    expect(published.status).toBe("published");
    expect(published.publishedAt).toBeTruthy();

    const live = await article.published.show(created.id);
    expect(live.title).toBe("First");
    expect(live.tags).toEqual(["x", "y"]);
    // Populated or not depends on the adapter; what matters is the link survives the copy.
    expect(linkId(live.author)).toBe(writer.id);
    expect(linkId(live.author)).toBe(
      linkId((await article.show(created.id)).author),
    );
    expect(live.status).toBe("published");
  });

  it("editing a published record keeps the live copy and marks it changed", async () => {
    const { article } = await setup();
    const created = await article.create({ slug: "a", title: "Old" });
    await article.publish(created.id);

    const edited = await article.update(created.id, {
      title: "New",
      tags: ["z"],
    });

    expect(edited.status).toBe("changed");
    expect((await article.show(created.id)).title).toBe("New");

    const live = await article.published.show(created.id);
    expect(live.title).toBe("Old");
    expect(live.tags ?? []).toEqual([]);

    expect(
      (await article.read({ filters: { status: "changed" } })).data,
    ).toHaveLength(1);
    expect(
      (await article.published.read({ filters: { title: "Old" } })).data,
    ).toHaveLength(1);
  });

  it("publishing again replaces the live copy", async () => {
    const { article } = await setup();
    const created = await article.create({
      slug: "a",
      title: "Old",
      tags: ["x", "y"],
    });
    await article.publish(created.id);
    await article.update(created.id, { title: "New", tags: ["z"] });

    const record = await article.publish(created.id);

    expect(record.status).toBe("published");
    const live = await article.published.show(created.id);
    expect(live.title).toBe("New");
    expect(live.tags).toEqual(["z"]);
  });

  it("editing a draft stays a draft", async () => {
    const { article } = await setup();
    const created = await article.create({ slug: "a", title: "One" });

    const edited = await article.update(created.id, { title: "Two" });

    expect(edited.status).toBe("draft");
  });

  it("discard() puts the working copy back to what is live", async () => {
    const { article } = await setup();
    const created = await article.create({
      slug: "a",
      title: "Live",
      tags: ["x"],
    });
    await article.publish(created.id);
    await article.update(created.id, { title: "Wip", tags: ["y", "z"] });

    const restored = await article.discard(created.id);

    expect(restored.status).toBe("published");
    const working = await article.show(created.id);
    expect(working.title).toBe("Live");
    expect(working.tags).toEqual(["x"]);
  });

  it("discard() refuses a record that was never published", async () => {
    const { article } = await setup();
    const created = await article.create({ slug: "a", title: "One" });

    const error = await article.discard(created.id).catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as InstanceType<typeof HttpError>).statusCode).toBe(409);
  });

  it("unpublish() takes it offline and keeps the working copy as a draft", async () => {
    const { article } = await setup();
    const created = await article.create({ slug: "a", title: "One" });
    await article.publish(created.id);

    const record = await article.unpublish(created.id);

    expect(record.status).toBe("draft");
    expect(record.publishedAt).toBeNull();
    expect((await article.published.read()).data).toHaveLength(0);
    expect((await article.show(created.id)).title).toBe("One");
  });

  it("destroy() removes the published copy too", async () => {
    const { article } = await setup();
    const created = await article.create({ slug: "a", title: "One" });
    await article.publish(created.id);

    await article.destroy(created.id);

    expect((await article.published.read()).data).toHaveLength(0);
    expect((await article.read()).data).toHaveLength(0);
  });

  it("publish/unpublish/discard answer 404 for an unknown id", async () => {
    const { article } = await setup();

    for (const action of ["publish", "unpublish", "discard"] as const) {
      const error = await article[action]("missing").catch((e) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as InstanceType<typeof HttpError>).statusCode).toBe(404);
    }
  });

  it("a publish that fails halfway publishes nothing", async () => {
    const { article } = await setup();
    const created = await article.create({ slug: "a", title: "Old" });
    await article.publish(created.id);
    await article.update(created.id, { title: "New" });

    // The live copy is written first; the status update after it fails.
    db.failNext("update");
    await expect(article.publish(created.id)).rejects.toThrow("db down");

    expect((await article.published.show(created.id)).title).toBe("Old");
    expect((await article.show(created.id)).status).toBe("changed");
  });

  it("a first publish that fails halfway leaves no live copy", async () => {
    const { article } = await setup();
    const created = await article.create({ slug: "a", title: "One" });

    db.failNext("update");
    await expect(article.publish(created.id)).rejects.toThrow("db down");

    expect(await article.published.show(created.id)).toBeUndefined();
    expect((await article.show(created.id)).status).toBe("draft");
  });

  it("an unpublish that fails halfway keeps the record live", async () => {
    const { article } = await setup();
    const created = await article.create({ slug: "a", title: "One" });
    await article.publish(created.id);

    db.failNext("update");
    await expect(article.unpublish(created.id)).rejects.toThrow("db down");

    expect((await article.published.show(created.id)).title).toBe("One");
    expect((await article.show(created.id)).status).toBe("published");
  });

  it("does not fire afterPublish for a publish that was rolled back", async () => {
    const { article } = await setup();
    let fired = 0;
    afterPublish(article, () => {
      fired += 1;
    });
    const created = await article.create({ slug: "a", title: "One" });

    db.failNext("update");
    await article.publish(created.id).catch(() => {});

    expect(fired).toBe(0);
  });

  it("enforces unique on the working copy only", async () => {
    const { article } = await setup();
    const first = await article.create({ slug: "a", title: "One" });
    const second = await article.create({ slug: "b", title: "Two" });
    await article.publish(first.id);
    await article.publish(second.id);

    // Swap the slugs: only valid because the published table has no unique constraint.
    await article.update(first.id, { slug: "tmp" });
    await article.update(second.id, { slug: "a" });
    await article.update(first.id, { slug: "b" });
    await article.publish(second.id);
    await article.publish(first.id);

    expect((await article.published.show(second.id)).slug).toBe("a");
    expect((await article.published.show(first.id)).slug).toBe("b");
  });

  it("searches the published table", async () => {
    const { article } = await setup();
    const a = await article.create({ slug: "a", title: "Zebra crossing" });
    await article.create({ slug: "b", title: "Zebra draft" });
    await article.publish(a.id);

    const result = await article.published.read({ search: "Zebra" });

    expect(result.data.map((r) => r.id)).toEqual([a.id]);
  });

  it("fires afterPublish / afterUnpublish", async () => {
    const { article } = await setup();
    const events: string[] = [];
    afterPublish(article, (r) => {
      events.push(`publish:${r.status}`);
    });
    afterUnpublish(article, (r) => {
      events.push(`unpublish:${r.status}`);
    });
    const created = await article.create({ slug: "a", title: "One" });

    await article.publish(created.id);
    await article.unpublish(created.id);

    expect(events).toEqual(["publish:published", "unpublish:draft"]);
  });

  it("backfills records that predate draftable, once and without hooks", async () => {
    const { article } = await setup();
    let fired = 0;
    afterPublish(article, () => {
      fired += 1;
    });
    // Rows written before the model was draftable carry no status.
    await db.adapter.insert(article.def, {
      slug: "old",
      title: "Legacy",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const draft = await article.create({ slug: "new", title: "Fresh" });

    expect(await article.backfillPublished()).toBe(1);
    expect(await article.backfillPublished()).toBe(0);

    const live = (await article.published.read()).data;
    expect(live.map((r) => r.title)).toEqual(["Legacy"]);
    expect((await article.show(draft.id)).status).toBe("draft");
    expect(fired).toBe(0);
  });

  it("rejects a schema field that collides with the draft fields", () => {
    expect(() =>
      makeModel(unique("bad"), {
        name: "Bad",
        searchFields: [],
        draftable: true,
        schema: z.object({ status: text({ label: "Status" }) }),
      }),
    ).toThrow(/reserved/);
  });

  it("leaves non-draftable models without a published view", () => {
    const author = buildAuthor();

    expect(isDraftable(author)).toBe(false);
    expect("published" in author).toBe(false);
    expect(author.def.fields.some((f) => f.name === "status")).toBe(false);
  });
});
