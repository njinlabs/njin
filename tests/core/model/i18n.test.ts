import { describe, expect, it, mock } from "bun:test";
import * as realConfig from "../../../src/core/config";
import { useTestDb } from "../../helpers/test_db";

// A project with two languages. `settings` is swapped by the tests that need another config.
let settings: realConfig.ResolvedConfig["i18n"] = {
  locales: ["id", "en"],
  defaultLocale: "id",
};
mock.module("../../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ i18n: settings }),
}));

const db = await useTestDb();

const {
  makeModel,
  afterCreate,
  afterPublish,
  beforeCreate,
  UniqueConstraintError,
} = await import("../../../src/core/model/index");
const { HttpError } = await import("../../../src/core/http_error");
const { text } = await import("../../../src/core/model/data_type/text");
const { numeric } = await import("../../../src/core/model/data_type/numeric");
const { array } = await import("../../../src/core/model/data_type/array");
const { object } = await import("../../../src/core/model/data_type/object");
const { relation } = await import("../../../src/core/model/data_type/relation");
const { relationMany } = await import(
  "../../../src/core/model/data_type/relation_many"
);
const { toAdminSchema } = await import("../../../src/core/admin_schema");
const z = (await import("zod")).default;

type Rec = Record<string, any>;
const list = (value: unknown) => (value ?? []) as Rec[];
const obj = (value: unknown) => (value ?? {}) as Rec;

const unique = (base: string) =>
  `${base}_${crypto.randomUUID().replace(/-/g, "")}`;

const build = async () => {
  const author = makeModel(unique("author"), {
    name: "Author",
    searchFields: [],
    schema: z.object({ name: text({ label: "Name" }) }),
  });
  const article = makeModel(unique("article"), {
    name: "Article",
    i18n: true,
    searchFields: ["title", "author.name"],
    schema: z.object({
      slug: text({ label: "Slug", unique: true, localized: true }),
      title: text({ label: "Title", localized: true }),
      summary: text({ label: "Summary", localized: true }).optional(),
      views: numeric({ label: "Views" }).optional(),
      author: relation({ label: "Author" }, author, (r) => r.optional()),
      // per language, because it says so
      tags: array({ label: "Tags", localized: true }, z.string()).optional(),
      // the same in every language (no `localized`)
      labels: array({ label: "Labels" }, z.string()).optional(),
    }),
  });
  await db.sync([author.def, article.def, article.i18nDef]);

  const ann = await author.create({ name: "Ann" });
  const bob = await author.create({ name: "Bob" });
  return { author, article, ann, bob };
};

const sample = (ann: { id: string }, extra: Record<string, unknown> = {}) => ({
  slug: { id: "tentang", en: "about" },
  title: { id: "Tentang kami", en: "About us" },
  views: 5,
  author: ann.id,
  tags: { id: ["a"], en: ["b", "c"] },
  ...extra,
});

describe("i18n model storage", () => {
  it("keeps shared fields in one table and the languages in the other", async () => {
    const { article, ann } = await build();

    const created = await article.create(sample(ann));

    const main = await db.adapter.find(article.def, created.id);
    expect(main).toMatchObject({ views: 5 });
    expect(main).not.toHaveProperty("title");

    const idRow = await db.adapter.find(article.i18nDef, `${created.id}.id`);
    const enRow = await db.adapter.find(article.i18nDef, `${created.id}.en`);
    expect(idRow).toMatchObject({
      article_id: created.id,
      locale: "id",
      slug: "tentang",
      title: "Tentang kami",
      tags: ["a"],
      // the shared columns are copied onto the row so a language can be queried on its own
      views: 5,
      author: ann.id,
    });
    expect(enRow).toMatchObject({
      locale: "en",
      slug: "about",
      tags: ["b", "c"],
    });
    expect(enRow?.createdAt).toBe(created.createdAt);
  });

  it("returns every language of a record by default", async () => {
    const { article, ann } = await build();
    const created = await article.create(sample(ann));

    const record = await article.show(created.id);

    expect(record).toMatchObject({
      id: created.id,
      views: 5,
      slug: { id: "tentang", en: "about" },
      title: { id: "Tentang kami", en: "About us" },
      tags: { id: ["a"], en: ["b", "c"] },
    });
    expect(record?.author).toMatchObject({ id: ann.id, name: "Ann" });

    const { data } = await article.read();
    expect(data).toHaveLength(1);
    expect(data[0]?.title).toEqual({ id: "Tentang kami", en: "About us" });
  });

  it("deleting a record deletes every language of it", async () => {
    const { article, ann } = await build();
    const created = await article.create(sample(ann));

    await article.destroy(created.id);

    expect(await db.adapter.find(article.def, created.id)).toBeNull();
    expect(await db.adapter.count(article.i18nDef)).toBe(0);
  });
});

describe("a shared array", () => {
  it("is stored once, copied onto every language, and read in each", async () => {
    const { article, ann } = await build();
    const created = await article.create(sample(ann, { labels: ["x", "y"] }));

    const main = await db.adapter.find(article.def, created.id);
    expect(main?.labels).toEqual(["x", "y"]);
    for (const locale of ["id", "en"]) {
      const row = await db.adapter.find(
        article.i18nDef,
        `${created.id}.${locale}`,
      );
      expect(row?.labels).toEqual(["x", "y"]);
    }

    // every language at once: the array is the record's, not a { locale: value } map
    expect((await article.show(created.id))?.labels).toEqual(["x", "y"]);
    // one language: from that language's row
    expect((await article.show(created.id, { locale: "en" }))?.labels).toEqual([
      "x",
      "y",
    ]);
  });

  it("changes in every language at once, order kept", async () => {
    const { article, ann } = await build();
    const created = await article.create(sample(ann, { labels: ["x", "y"] }));

    await article.update(created.id, { labels: ["z", "a", "m"] });

    expect((await article.show(created.id))?.labels).toEqual(["z", "a", "m"]);
    for (const locale of ["id", "en"]) {
      expect((await article.show(created.id, { locale }))?.labels).toEqual([
        "z",
        "a",
        "m",
      ]);
    }
  });

  it("is copied onto a language added later, and can be filtered on", async () => {
    const { article, ann } = await build();
    const created = await article.create(
      sample(ann, {
        slug: { id: "satu" },
        title: { id: "Satu" },
        tags: { id: [] },
        labels: ["red", "blue"],
      }),
    );
    await article.create(
      sample(ann, {
        slug: { id: "dua", en: "two" },
        title: { id: "Dua", en: "Two" },
        labels: ["green"],
      }),
    );

    await article.update(created.id, {
      slug: { en: "one" },
      title: { en: "One" },
    });

    const en = await article.show(created.id, { locale: "en" });
    expect(en?.labels).toEqual(["red", "blue"]);

    const red = await article.read({
      locale: "en",
      filters: { labels: { $in: "red" } },
    });
    expect(red.data.map((r) => r.id)).toEqual([created.id]);
  });

  it("is deleted with the record", async () => {
    const { article, ann } = await build();
    const created = await article.create(sample(ann, { labels: ["x"] }));

    await article.destroy(created.id);

    expect(await db.adapter.find(article.def, created.id)).toBeNull();
    expect(await db.adapter.count(article.i18nDef)).toBe(0);
  });
});

describe("object fields", () => {
  const buildObjects = async () => {
    const page = makeModel(unique("page"), {
      name: "Page",
      i18n: true,
      searchFields: ["title"],
      schema: z.object({
        title: text({ label: "Title", localized: true }),
        // shared: the same in every language
        seo: object(
          { label: "SEO" },
          {
            title: z.string().optional(),
            description: z.string().optional(),
          },
          (o) => o.optional(),
        ),
        // shared, with an array inside it
        social: object(
          { label: "Social" },
          {
            handle: z.string().optional(),
            links: z.array(z.string()).optional(),
          },
          (o) => o.optional(),
        ),
        // per language, with an object and an array inside it
        meta: object(
          { label: "Meta", localized: true },
          {
            title: z.string().optional(),
            og: z.object({ image: z.string().optional() }).optional(),
            keywords: z.array(z.string()).optional(),
          },
          (o) => o.optional(),
        ),
      }),
    });
    await db.sync([page.def, page.i18nDef]);
    return page;
  };

  it("a shared object is stored once and copied onto every language", async () => {
    const page = await buildObjects();
    const created = await page.create({
      title: { id: "Satu", en: "One" },
      seo: { title: "S", description: "D" },
      social: { handle: "@x", links: ["a", "b"] },
    });

    expect(await db.adapter.find(page.def, created.id)).toMatchObject({
      seo: { title: "S", description: "D" },
      social: { handle: "@x", links: ["a", "b"] },
    });
    for (const locale of ["id", "en"]) {
      expect(
        await db.adapter.find(page.i18nDef, `${created.id}.${locale}`),
      ).toMatchObject({
        seo: { title: "S", description: "D" },
        social: { handle: "@x", links: ["a", "b"] },
      });
    }

    expect((await page.show(created.id))?.seo).toEqual({
      title: "S",
      description: "D",
    });
    const en = await page.show(created.id, { locale: "en" });
    expect(en?.seo).toEqual({ title: "S", description: "D" });
    expect(en?.social).toEqual({ handle: "@x", links: ["a", "b"] });
  });

  it("a change to a shared object merges key by key in every language", async () => {
    const page = await buildObjects();
    const created = await page.create({
      title: { id: "Satu", en: "One" },
      seo: { title: "S", description: "D" },
      social: { handle: "@x", links: ["a", "b"] },
    });

    await page.update(created.id, {
      seo: { description: "D2" },
      social: { links: ["z"] },
    });

    for (const locale of ["id", "en"] as const) {
      const row = await page.show(created.id, { locale });
      expect(row?.seo).toEqual({ title: "S", description: "D2" });
      expect(row?.social).toEqual({ handle: "@x", links: ["z"] });
    }
    expect((await page.show(created.id))?.seo).toEqual({
      title: "S",
      description: "D2",
    });
  });

  it("clears a shared object everywhere with null", async () => {
    const page = await buildObjects();
    const created = await page.create({
      title: { id: "Satu", en: "One" },
      seo: { title: "S" },
    });

    await page.update(created.id, { seo: null });

    expect((await page.show(created.id))?.seo ?? null).toBeNull();
    expect(
      (await page.show(created.id, { locale: "en", fallback: false }))?.seo ??
        null,
    ).toBeNull();
  });

  it("a localized object differs per language, nested object and array included", async () => {
    const page = await buildObjects();
    const created = await page.create({
      title: { id: "Satu", en: "One" },
      meta: {
        id: { title: "Meta ID", og: { image: "id.png" }, keywords: ["a"] },
        en: { title: "Meta EN", og: { image: "en.png" }, keywords: ["b", "c"] },
      },
    });

    const all = await page.show(created.id);
    expect(all?.meta).toEqual({
      id: { title: "Meta ID", og: { image: "id.png" }, keywords: ["a"] },
      en: { title: "Meta EN", og: { image: "en.png" }, keywords: ["b", "c"] },
    });

    const en = await page.show(created.id, { locale: "en" });
    expect(en?.meta).toEqual({
      title: "Meta EN",
      og: { image: "en.png" },
      keywords: ["b", "c"],
    });
  });

  it("changes a localized object key by key within the one language", async () => {
    const page = await buildObjects();
    const created = await page.create({
      title: { id: "Satu", en: "One" },
      meta: {
        id: { title: "Meta ID", og: { image: "id.png" } },
        en: { title: "Meta EN", og: { image: "en.png" } },
      },
    });

    await page.update(created.id, {
      meta: { en: { og: { image: "new.png" }, keywords: ["k"] } },
    });

    const meta = (await page.show(created.id))?.meta as Record<string, unknown>;
    expect(meta.id).toMatchObject({
      title: "Meta ID",
      og: { image: "id.png" },
    });
    expect(meta.en).toMatchObject({
      title: "Meta EN",
      og: { image: "new.png" },
      keywords: ["k"],
    });
  });

  it("fills an empty localized object from the default language", async () => {
    const page = await buildObjects();
    const created = await page.create({
      title: { id: "Satu", en: "One" },
      meta: { id: { title: "Meta ID", keywords: ["a"] } },
    });

    const filled = await page.show(created.id, { locale: "en" });
    expect(filled?.meta).toMatchObject({ title: "Meta ID", keywords: ["a"] });

    const strict = await page.show(created.id, {
      locale: "en",
      fallback: false,
    });
    expect(strict?.meta ?? null).toBeNull();
  });

  it("a language added later gets the shared object and its own localized one", async () => {
    const page = await buildObjects();
    const created = await page.create({
      title: { id: "Satu" },
      seo: { title: "S" },
    });

    await page.update(created.id, {
      title: { en: "One" },
      meta: { en: { title: "Meta EN" } },
    });

    const en = await page.show(created.id, { locale: "en", fallback: false });
    // a sub-field that was never set is null (SQL) or missing (SurrealDB)
    expect(en?.seo).toMatchObject({ title: "S" });
    expect(
      en?.seo && (en.seo as { description?: string }).description,
    ).toBeFalsy();
    expect(en?.meta).toMatchObject({ title: "Meta EN" });
  });

  it("counts an object with nothing set as empty when falling back", async () => {
    const page = await buildObjects();
    const created = await page.create({
      title: { id: "Satu", en: "One" },
      meta: { id: { title: "Meta ID" }, en: { title: "Meta EN" } },
    });

    await page.update(created.id, { meta: { en: { title: null } } });

    const filled = await page.show(created.id, { locale: "en" });
    expect(filled?.meta).toMatchObject({ title: "Meta ID" });
    const strict = await page.show(created.id, {
      locale: "en",
      fallback: false,
    });
    expect(
      (strict?.meta as { title?: string } | null)?.title ?? null,
    ).toBeNull();
  });
});

describe("reading one language", () => {
  it("returns flat records of that language, with the record's id", async () => {
    const { article, ann } = await build();
    const created = await article.create(sample(ann));

    const { data, meta } = await article.read({ locale: "en" });

    expect(meta.total).toBe(1);
    expect(data[0]).toMatchObject({
      id: created.id,
      locale: "en",
      slug: "about",
      title: "About us",
      views: 5,
      tags: ["b", "c"],
    });
    expect(data[0]).not.toHaveProperty("article_id");
    expect((data[0]!.author as { name: string }).name).toBe("Ann");

    const shown = await article.show(created.id, { locale: "id" });
    expect(shown).toMatchObject({ id: created.id, title: "Tentang kami" });
  });

  it("filters, sorts and searches any column of the language directly", async () => {
    const { article, ann, bob } = await build();
    await article.create(
      sample(ann, {
        slug: { en: "b-post" },
        title: { en: "Beta" },
        views: 1,
        tags: { en: [] },
      }),
    );
    await article.create(
      sample(bob, {
        slug: { en: "a-post" },
        title: { en: "Alpha" },
        views: 9,
        tags: { en: [] },
      }),
    );

    const bySlug = await article.read({
      locale: "en",
      filters: { slug: "a-post" },
    });
    expect(bySlug.data.map((r) => r.title)).toEqual(["Alpha"]);

    // a shared column, answered by the same table
    const byAuthor = await article.read({
      locale: "en",
      filters: { author: ann.id },
    });
    expect(byAuthor.data.map((r) => r.title)).toEqual(["Beta"]);

    const sorted = await article.read({ locale: "en", sort: "title" });
    expect(sorted.data.map((r) => r.title)).toEqual(["Alpha", "Beta"]);
    const byViews = await article.read({
      locale: "en",
      sort: "views",
      order: "desc",
    });
    expect(byViews.data.map((r) => r.title)).toEqual(["Alpha", "Beta"]);

    const searched = await article.read({ locale: "en", search: "Alph" });
    expect(searched.data.map((r) => r.title)).toEqual(["Alpha"]);
    const byAuthorName = await article.read({ locale: "en", search: "Bob" });
    expect(byAuthorName.data.map((r) => r.title)).toEqual(["Alpha"]);

    const paged = await article.read({
      locale: "en",
      sort: "title",
      limit: 1,
      page: 2,
    });
    expect(paged.data.map((r) => r.title)).toEqual(["Beta"]);
    expect(paged.meta).toMatchObject({ total: 2, pageCount: 2 });
  });

  it("only lists the records that exist in that language", async () => {
    const { article, ann } = await build();
    await article.create(
      sample(ann, { slug: { id: "x" }, title: { id: "X" }, tags: { id: [] } }),
    );
    await article.create(sample(ann));

    expect((await article.read({ locale: "id" })).data).toHaveLength(2);
    expect((await article.read({ locale: "en" })).data).toHaveLength(1);
  });

  it("fills a field the language lacks from the default language", async () => {
    const { article, ann } = await build();
    const created = await article.create(
      sample(ann, {
        summary: { id: "Ringkasan" },
        tags: { id: ["satu"], en: [] },
      }),
    );

    const filled = await article.show(created.id, { locale: "en" });
    expect(filled).toMatchObject({
      title: "About us",
      summary: "Ringkasan",
      tags: ["satu"],
    });

    const strict = await article.show(created.id, {
      locale: "en",
      fallback: false,
    });
    expect(strict?.summary ?? null).toBeNull();
    expect(strict?.tags ?? []).toEqual([]);
  });

  it("selects fields of a language", async () => {
    const { article, ann } = await build();
    await article.create(sample(ann));

    const { data } = await article.read({ locale: "en", select: ["title"] });

    expect(data[0]).toMatchObject({ title: "About us", locale: "en" });
    expect(data[0]).not.toHaveProperty("slug");
    expect(data[0]).not.toHaveProperty("article_id");
  });

  it("refuses a locale that is not configured", async () => {
    const { article } = await build();

    const error = await article.read({ locale: "fr" }).catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as InstanceType<typeof HttpError>).statusCode).toBe(400);
  });
});

describe("listing every language", () => {
  it("answers a shared filter and sort from the shared table", async () => {
    const { article, ann, bob } = await build();
    await article.create(sample(ann, { views: 3 }));
    await article.create(
      sample(bob, { views: 1, slug: { id: "dua", en: "two" } }),
    );

    const { data } = await article.read({ filters: { author: bob.id } });
    expect(data).toHaveLength(1);
    expect(data[0]?.views).toBe(1);

    const sorted = await article.read({ sort: "views" });
    expect(sorted.data.map((r) => r.views)).toEqual([1, 3]);
  });

  it("answers a condition on a localized field across languages, once per record", async () => {
    const { article, ann } = await build();
    const created = await article.create(
      sample(ann, { title: { id: "Kopi enak", en: "Good coffee" } }),
    );
    await article.create(
      sample(ann, {
        slug: { id: "teh", en: "tea" },
        title: { id: "Teh", en: "Tea" },
      }),
    );

    const viaId = await article.read({ search: "Kopi" });
    expect(viaId.data.map((r) => r.id)).toEqual([created.id]);

    const viaSlug = await article.read({ filters: { slug: "about" } });
    expect(viaSlug.data.map((r) => r.id)).toEqual([created.id]);
    expect(viaSlug.data[0]?.title).toEqual({
      id: "Kopi enak",
      en: "Good coffee",
    });

    // both languages match "coffee"/"kopi"-less text -> still one record
    const both = await article.read({ search: "Tea" });
    expect(both.data).toHaveLength(1);
  });
});

describe("writing", () => {
  it("a change to a shared field reaches every language", async () => {
    const { article, ann, bob } = await build();
    const created = await article.create(sample(ann));

    await article.update(created.id, { views: 42, author: bob.id });

    for (const locale of ["id", "en"]) {
      const row = await db.adapter.find(
        article.i18nDef,
        `${created.id}.${locale}`,
      );
      expect(row).toMatchObject({ views: 42, author: bob.id });
    }
    const byAuthor = await article.read({
      locale: "en",
      filters: { author: bob.id },
    });
    expect(byAuthor.data).toHaveLength(1);
  });

  it("changes only the languages that are given", async () => {
    const { article, ann } = await build();
    const created = await article.create(sample(ann));

    const updated = await article.update(created.id, {
      title: { en: "About" },
      tags: { en: ["z"] },
    });

    expect(updated?.title).toEqual({ id: "Tentang kami", en: "About" });
    expect(updated?.tags).toEqual({ id: ["a"], en: ["z"] });
  });

  it("clears an optional field of one language with null", async () => {
    const { article, ann } = await build();
    const created = await article.create(
      sample(ann, { summary: { id: "S1", en: "S2" } }),
    );

    const updated = await article.update(created.id, { summary: { en: null } });

    expect(updated?.summary).toEqual({ id: "S1", en: null });
  });

  it("adds a language with an update, copying the shared fields onto it", async () => {
    const { article, ann } = await build();
    const created = await article.create(
      sample(ann, {
        slug: { id: "satu" },
        title: { id: "Satu" },
        tags: { id: [] },
      }),
    );

    await article.update(created.id, {
      slug: { en: "one" },
      title: { en: "One" },
    });

    const row = await db.adapter.find(article.i18nDef, `${created.id}.en`);
    expect(row).toMatchObject({
      locale: "en",
      title: "One",
      views: 5,
      author: ann.id,
    });
    expect(row?.createdAt).toBe(created.createdAt);
    expect((await article.read({ locale: "en" })).data).toHaveLength(1);
  });

  it("refuses a new language that lacks a required field", async () => {
    const { article, ann } = await build();
    const created = await article.create(
      sample(ann, {
        slug: { id: "satu" },
        title: { id: "Satu" },
        tags: { id: [] },
      }),
    );

    const error = await article
      .update(created.id, { slug: { en: "one" } })
      .catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as InstanceType<typeof HttpError>).statusCode).toBe(422);
    expect(
      await db.adapter.find(article.i18nDef, `${created.id}.en`),
    ).toBeNull();
  });

  it("refuses to clear a required field", async () => {
    const { article, ann } = await build();
    const created = await article.create(sample(ann));

    const error = await article
      .update(created.id, { title: { en: null } })
      .catch((e) => e);

    expect((error as InstanceType<typeof HttpError>).statusCode).toBe(422);
  });

  it("needs at least one language, and a localized field given per locale", async () => {
    const { article, ann } = await build();

    const none = await article.create({ views: 1 }).catch((e) => e);
    expect((none as InstanceType<typeof HttpError>).statusCode).toBe(422);

    const flat = await article
      .create({ ...sample(ann), title: "plain string" })
      .catch((e) => e);
    expect((flat as InstanceType<typeof HttpError>).statusCode).toBe(422);
  });

  it("returns null for a record that does not exist", async () => {
    const { article } = await build();

    expect(await article.update("missing", { views: 1 })).toBeNull();
  });

  it("removes one language but never the last one", async () => {
    const { article, ann } = await build();
    const created = await article.create(sample(ann));

    const left = await article.removeLocale(created.id, "en");
    expect(left.title).toEqual({ id: "Tentang kami" });

    const error = await article.removeLocale(created.id, "id").catch((e) => e);
    expect((error as InstanceType<typeof HttpError>).statusCode).toBe(409);
    const missing = await article
      .removeLocale(created.id, "en")
      .catch((e) => e);
    expect((missing as InstanceType<typeof HttpError>).statusCode).toBe(404);
  });

  it("is atomic: a failing language leaves nothing behind", async () => {
    const { article, ann } = await build();

    db.failNext("insert"); // the first insert is the shared row's; fail the second one
    await article.create(sample(ann)).catch(() => {});
    // the shared row's insert was the one to fail here, so nothing was written at all
    expect(await db.adapter.count(article.def)).toBe(0);

    const first = await article.create(sample(ann));
    db.failNext("update");
    await expect(
      article.update(first.id, { views: 9, title: { en: "X" } }),
    ).rejects.toThrow("db down");
    expect(await db.adapter.find(article.def, first.id)).toMatchObject({
      views: 5,
    });
    expect(
      await db.adapter.find(article.i18nDef, `${first.id}.en`),
    ).toMatchObject({ title: "About us" });
  });
});

describe("unique localized fields", () => {
  it("are unique within a language, not across languages", async () => {
    const { article, ann } = await build();
    await article.create(sample(ann, { slug: { id: "halo", en: "halo" } }));

    // "halo" is taken in both languages
    const clash = await article
      .create(sample(ann, { slug: { id: "halo", en: "other" } }))
      .catch((e) => e);
    expect(clash).toBeInstanceOf(UniqueConstraintError);
    expect((clash as InstanceType<typeof UniqueConstraintError>).field).toBe(
      "slug",
    );

    // the same word may be the slug of different languages of different records
    await article.create(sample(ann, { slug: { id: "x", en: "halo-en" } }));
    const other = await article.create(
      sample(ann, { slug: { id: "y", en: "z" } }),
    );
    await expect(
      article.update(other.id, { slug: { en: "halo-en" } }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
    // a record may keep its own value
    await article.update(other.id, { slug: { en: "z" } });
  });
});

describe("hooks and validation", () => {
  it("run with the per-language shape of the data and the record", async () => {
    const { article, ann } = await build();
    const seen: unknown[] = [];
    beforeCreate(article, (data) => {
      seen.push(["before", (data as Record<string, unknown>).title]);
    });
    afterCreate(article, (record) => {
      seen.push(["after", (record as Record<string, unknown>).title]);
    });

    await article.create(sample(ann));

    expect(seen).toEqual([
      ["before", { id: "Tentang kami", en: "About us" }],
      ["after", { id: "Tentang kami", en: "About us" }],
    ]);
  });

  it("validates localized fields as maps of the configured locales", async () => {
    const { article } = await build();

    const ok = article.validation.safeParse({
      slug: { id: "a" },
      title: { id: "A" },
    });
    expect(ok.success).toBe(true);

    const unknown = article.validation.safeParse({
      slug: { fr: "a" },
      title: { id: "A" },
    });
    expect(unknown.success).toBe(false);

    const missing = article.validation.safeParse({ slug: { id: "a" } });
    expect(missing.success).toBe(false);

    expect(
      article.validation.partial().safeParse({ title: { en: "x" } }).success,
    ).toBe(true);
  });

  it("describes localized fields to the admin panel as maps, flagged localized", async () => {
    const { article } = await build();

    const schema = toAdminSchema(article.validation) as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(schema.properties.title).toMatchObject({
      type: "object",
      localized: true,
      additionalProperties: { type: "string" },
    });
    expect(schema.properties.views?.localized).toBeUndefined();
  });
});

describe("draftable i18n model", () => {
  const buildDrafts = async () => {
    const author = makeModel(unique("author"), {
      name: "Author",
      searchFields: [],
      schema: z.object({ name: text({ label: "Name" }) }),
    });
    const article = makeModel(unique("article"), {
      name: "Article",
      i18n: true,
      draftable: true,
      searchFields: ["title"],
      schema: z.object({
        slug: text({ label: "Slug", unique: true, localized: true }),
        title: text({ label: "Title", localized: true }),
        summary: text({ label: "Summary", localized: true }).optional(),
        views: numeric({ label: "Views" }).optional(),
        author: relation({ label: "Author" }, author, (r) => r.optional()),
        labels: array({ label: "Labels" }, z.string()).optional(),
        tags: array({ label: "Tags", localized: true }, z.string()).optional(),
      }),
    });
    await db.sync([
      author.def,
      article.def,
      article.i18nDef,
      article.publishedDef,
    ]);
    const ann = await author.create({ name: "Ann" });
    const created = await article.create({
      slug: { id: "tentang", en: "about" },
      title: { id: "Tentang kami", en: "About us" },
      summary: { id: "Ringkasan" },
      views: 5,
      author: ann.id,
      labels: ["x", "y"],
      tags: { id: ["a"], en: ["b"] },
    });
    return { author, article, ann, created };
  };

  const live =
    (article: Awaited<ReturnType<typeof buildDrafts>>["article"]) =>
    async (locale: string) =>
      (await article.published.read({ locale })).data;

  it("starts every language as a draft that is not live", async () => {
    const { article, created } = await buildDrafts();

    expect(created.status).toEqual({ id: "draft", en: "draft" });
    expect(created.publishedAt).toEqual({ id: null, en: null });
    expect(await live(article)("en")).toHaveLength(0);
    expect(await article.published.show(created.id, { locale: "en" })).toBe(
      undefined,
    );
  });

  it("publishes one language and leaves the other as it was", async () => {
    const { article, created } = await buildDrafts();

    const record = await article.publish(created.id, { locale: "en" });

    expect(record.status).toEqual({ id: "draft", en: "published" });
    const en = await live(article)("en");
    expect(en).toHaveLength(1);
    expect(en[0]).toMatchObject({
      id: created.id,
      locale: "en",
      slug: "about",
      title: "About us",
      views: 5,
      labels: ["x", "y"],
      tags: ["b"],
      status: "published",
    });
    expect(await live(article)("id")).toHaveLength(0);

    // the live row is a copy: its arrays have their own child rows
    const row = await db.adapter.find(article.publishedDef, `${created.id}.en`);
    expect(row).toMatchObject({ labels: ["x", "y"], tags: ["b"] });
  });

  it("editing a published language keeps what is live until it is published again", async () => {
    const { article, created } = await buildDrafts();
    await article.publish(created.id, { locale: "en" });

    const edited = await article.update(created.id, {
      title: { en: "About" },
      tags: { en: ["z"] },
    });

    expect(edited?.status).toEqual({ id: "draft", en: "changed" });
    expect((await article.show(created.id, { locale: "en" }))?.title).toBe(
      "About",
    );
    const shown = await article.published.show(created.id, { locale: "en" });
    expect(shown).toMatchObject({ title: "About us", tags: ["b"] });

    await article.publish(created.id, { locale: "en" });
    expect(
      await article.published.show(created.id, { locale: "en" }),
    ).toMatchObject({ title: "About", tags: ["z"] });
    expect((await article.show(created.id))?.status).toEqual({
      id: "draft",
      en: "published",
    });
  });

  it("a shared edit marks the published languages as changed, and is live only once published", async () => {
    const { article, created } = await buildDrafts();
    await article.publish(created.id, { locale: "en" });

    await article.update(created.id, { views: 9, labels: ["q"] });

    expect((await article.show(created.id))?.status).toEqual({
      id: "draft",
      en: "changed",
    });
    expect(
      await article.published.show(created.id, { locale: "en" }),
    ).toMatchObject({ views: 5, labels: ["x", "y"] });

    await article.publish(created.id, { locale: "en" });
    expect(
      await article.published.show(created.id, { locale: "en" }),
    ).toMatchObject({ views: 9, labels: ["q"] });
  });

  it("publishing another language brings the live shared fields level", async () => {
    const { article, created } = await buildDrafts();
    await article.publish(created.id, { locale: "en" });
    await article.update(created.id, { views: 9 });
    expect((await article.show(created.id))?.status).toMatchObject({
      en: "changed",
    });

    await article.publish(created.id, { locale: "id" });

    // "en" only differed in the shared field, which is now the same on both sides
    expect(
      await article.published.show(created.id, { locale: "en" }),
    ).toMatchObject({ views: 9 });
    expect((await article.show(created.id))?.status).toEqual({
      id: "published",
      en: "published",
    });
  });

  it("publishes every language the record has when none is named", async () => {
    const { article, created } = await buildDrafts();

    const record = await article.publish(created.id);

    expect(record.status).toEqual({ id: "published", en: "published" });
    expect(await live(article)("id")).toHaveLength(1);
    expect(await live(article)("en")).toHaveLength(1);
  });

  it("unpublishes one language, keeping its working copy as a draft", async () => {
    const { article, created } = await buildDrafts();
    await article.publish(created.id);

    const record = await article.unpublish(created.id, { locale: "en" });

    expect(record.status).toEqual({ id: "published", en: "draft" });
    expect(await live(article)("en")).toHaveLength(0);
    expect(await live(article)("id")).toHaveLength(1);
    expect((await article.show(created.id, { locale: "en" }))?.title).toBe(
      "About us",
    );
  });

  it("discards the unpublished edits of a language", async () => {
    const { article, created } = await buildDrafts();
    await article.publish(created.id, { locale: "en" });
    await article.update(created.id, {
      title: { en: "Work in progress" },
      tags: { en: ["w"] },
    });

    const record = await article.discard(created.id, { locale: "en" });

    expect(record.status).toMatchObject({ en: "published" });
    expect(await article.show(created.id, { locale: "en" })).toMatchObject({
      title: "About us",
      tags: ["b"],
    });
  });

  it("a language with a pending shared edit stays changed after a discard", async () => {
    const { article, created } = await buildDrafts();
    await article.publish(created.id, { locale: "en" });
    await article.update(created.id, { views: 9, title: { en: "WIP" } });

    const record = await article.discard(created.id, { locale: "en" });

    expect(record.status).toMatchObject({ en: "changed" });
    expect((await article.show(created.id, { locale: "en" }))?.title).toBe(
      "About us",
    );
  });

  it("refuses a discard where nothing is published, a missing language and an unknown one", async () => {
    const { article, created } = await buildDrafts();
    const status = (error: unknown) =>
      (error as InstanceType<typeof HttpError>).statusCode;

    expect(
      status(
        await article.discard(created.id, { locale: "en" }).catch((e) => e),
      ),
    ).toBe(409);
    expect(status(await article.discard(created.id).catch((e) => e))).toBe(409);

    await article.removeLocale(created.id, "en");
    expect(
      status(
        await article.publish(created.id, { locale: "en" }).catch((e) => e),
      ),
    ).toBe(404);
    expect(
      status(
        await article.publish(created.id, { locale: "fr" }).catch((e) => e),
      ),
    ).toBe(400);
    expect(status(await article.publish("missing").catch((e) => e))).toBe(404);
  });

  it("filters by the status of a language", async () => {
    const { article, created } = await buildDrafts();
    await article.publish(created.id, { locale: "en" });
    await article.update(created.id, { title: { en: "About" } });

    const changed = await article.read({
      locale: "en",
      filters: { status: "changed" },
    });
    expect(changed.data.map((r) => r.id)).toEqual([created.id]);

    const drafts = await article.read({
      locale: "id",
      filters: { status: "draft" },
    });
    expect(drafts.data).toHaveLength(1);

    // across languages: a condition on a status is answered per language row
    const anyChanged = await article.read({ filters: { status: "changed" } });
    expect(anyChanged.data.map((r) => r.id)).toEqual([created.id]);
  });

  it("falls back to the default language's live copy, and only to that", async () => {
    const { article, created } = await buildDrafts();
    await article.publish(created.id, { locale: "en" });

    // "id" is not live, so its summary is not borrowed
    const withoutDefault = await article.published.show(created.id, {
      locale: "en",
    });
    expect(withoutDefault?.summary ?? null).toBeNull();

    await article.publish(created.id, { locale: "id" });
    const withDefault = await article.published.show(created.id, {
      locale: "en",
    });
    expect(withDefault?.summary).toBe("Ringkasan");
    const strict = await article.published.show(created.id, {
      locale: "en",
      fallback: false,
    });
    expect(strict?.summary ?? null).toBeNull();
  });

  it("reads what is live one language at a time", async () => {
    const { article } = await buildDrafts();

    expect(() => article.published.read({} as never)).toThrow("needs a locale");
  });

  it("removing a language or the record takes what is live with it", async () => {
    const { article, created } = await buildDrafts();
    await article.publish(created.id);

    await article.removeLocale(created.id, "en");
    expect(await live(article)("en")).toHaveLength(0);
    expect(await live(article)("id")).toHaveLength(1);

    await article.destroy(created.id);
    expect(await live(article)("id")).toHaveLength(0);
    expect(await db.adapter.count(article.publishedDef)).toBe(0);
  });

  it("is atomic: a publish that fails halfway publishes nothing", async () => {
    const { article, created } = await buildDrafts();

    db.failNext("update");
    await expect(article.publish(created.id)).rejects.toThrow("db down");

    expect(await db.adapter.count(article.publishedDef)).toBe(0);
    expect((await article.show(created.id))?.status).toEqual({
      id: "draft",
      en: "draft",
    });
  });

  it("fires afterPublish once with the record", async () => {
    const { article, created } = await buildDrafts();
    const seen: unknown[] = [];
    afterPublish(article, (record) => {
      seen.push((record as Record<string, unknown>).status);
    });

    await article.publish(created.id);

    expect(seen).toEqual([{ id: "published", en: "published" }]);
  });

  it("publishes the languages that predate drafts, once", async () => {
    const { article } = await buildDrafts();
    // rows written before the model was draftable carry no status
    const old = await db.adapter.insert(article.def, {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await db.adapter.insert(
      article.i18nDef,
      {
        article_id: old.id,
        locale: "id",
        slug: "lama",
        title: "Lama",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { id: `${old.id}.id` },
    );

    // the record from buildDrafts() is a draft, so the live table is empty and the scan runs
    expect(await article.backfillPublished()).toBe(1);
    expect(await article.backfillPublished()).toBe(0);

    const lama = await article.published.show(old.id, { locale: "id" });
    expect(lama).toMatchObject({ title: "Lama", status: "published" });
  });
});

describe("links in an i18n model", () => {
  // The fields a file() / multiFile() tag their schema with, without needing the file module.
  const fileLike = (label: string, model: string, many = false) =>
    (many ? z.array(z.string()) : z.string()).optional().meta({
      label,
      renderAs: many ? "multi_file" : "file",
      model,
      localized: true,
    });

  const buildLinks = async () => {
    // a target with languages, and one without
    const category = makeModel(unique("category"), {
      name: "Category",
      i18n: true,
      searchFields: ["name"],
      schema: z.object({
        slug: text({ label: "Slug", unique: true, localized: true }),
        name: text({ label: "Name", localized: true }),
        color: text({ label: "Color" }).optional(),
      }),
    });
    const author = makeModel(unique("author"), {
      name: "Author",
      searchFields: [],
      schema: z.object({ name: text({ label: "Name" }) }),
    });
    const media = makeModel(unique("media"), {
      name: "Media",
      searchFields: [],
      schema: z.object({ url: text({ label: "Url" }) }),
    });
    const article = makeModel(unique("article"), {
      name: "Article",
      i18n: true,
      draftable: true,
      searchFields: ["title"],
      schema: z.object({
        title: text({ label: "Title", localized: true }),
        author: relation({ label: "Author" }, author, (r) => r.optional()),
        category: relation({ label: "Category" }, category, (r) =>
          r.optional(),
        ),
        categories: relationMany({ label: "Categories" }, category, (r) =>
          r.optional(),
        ),
        cover: fileLike("Cover", media.prefix),
        gallery: fileLike("Gallery", media.prefix, true),
      }),
    });
    // a model without languages that points at the one with
    const post = makeModel(unique("post"), {
      name: "Post",
      searchFields: [],
      schema: z.object({
        title: text({ label: "Title" }),
        category: relation({ label: "Category" }, category, (r) =>
          r.optional(),
        ),
      }),
    });
    await db.sync([
      author.def,
      media.def,
      category.def,
      category.i18nDef,
      article.def,
      article.i18nDef,
      article.publishedDef,
      post.def,
    ]);

    const coffee = await category.create({
      slug: { id: "kopi", en: "coffee" },
      name: { id: "Kopi", en: "Coffee" },
      color: "brown",
    });
    // only written in Indonesian
    const tea = await category.create({
      slug: { id: "teh" },
      name: { id: "Teh" },
    });
    const ann = await author.create({ name: "Ann" });
    const [m1, m2, m3] = [
      await media.create({ url: "id.png" }),
      await media.create({ url: "en.png" }),
      await media.create({ url: "en2.png" }),
    ];
    const created = await article.create({
      title: { id: "Satu", en: "One" },
      author: ann.id,
      category: coffee.id,
      categories: [coffee.id, tea.id],
      cover: { id: m1.id, en: m2.id },
      gallery: { id: [m1.id], en: [m2.id, m3.id] },
    });
    return {
      category,
      author,
      article,
      post,
      coffee,
      tea,
      ann,
      m1,
      m2,
      m3,
      created,
    };
  };

  it("a relation to a model without languages is the same in every language", async () => {
    const { article, created } = await buildLinks();

    const id = await article.show(created.id, { locale: "id" });
    const en = await article.show(created.id, { locale: "en" });

    expect(id?.author).toMatchObject({ name: "Ann" });
    expect(en?.author).toMatchObject({ name: "Ann" });
  });

  it("a relation to a model with languages is read in the language being read", async () => {
    const { article, created, coffee, tea } = await buildLinks();

    const en = await article.show(created.id, { locale: "en" });
    expect(en?.category).toMatchObject({
      id: coffee.id,
      locale: "en",
      slug: "coffee",
      name: "Coffee",
      color: "brown", // what the target shares comes along
    });
    // the list too; "Teh" has no English, so the default language's row stands in
    expect(list(en?.categories).map((c) => [c.id, c.locale, c.name])).toEqual([
      [coffee.id, "en", "Coffee"],
      [tea.id, "id", "Teh"],
    ]);

    const id = await article.show(created.id, { locale: "id" });
    expect(id?.category).toMatchObject({ locale: "id", name: "Kopi" });

    const listed = await article.read({ locale: "en" });
    expect(listed.data[0]?.category).toMatchObject({ name: "Coffee" });
  });

  it("with no language asked for, the related record is in the default language", async () => {
    const { article, created } = await buildLinks();

    const all = await article.show(created.id);
    expect(all?.category).toMatchObject({ locale: "id", name: "Kopi" });
    expect(list(all?.categories).map((c) => c.name)).toEqual(["Kopi", "Teh"]);

    const listed = await article.read();
    expect(listed.data[0]?.category).toMatchObject({ name: "Kopi" });
  });

  it("keeps the shared row for a related record the target has no language for when fallback is off", async () => {
    const { article, created, tea } = await buildLinks();

    const strict = await article.show(created.id, {
      locale: "en",
      fallback: false,
    });

    const second = list(strict?.categories)[1]!;
    expect(second.id).toBe(tea.id);
    expect(second).not.toHaveProperty("name"); // only the shared row is there
  });

  it("leaves a link as an id when it is not expanded", async () => {
    const { article, coffee } = await buildLinks();

    const { data } = await article.read({ locale: "en", populate: "none" });

    expect(data[0]?.category).toBe(coffee.id);
    expect(data[0]?.categories).toEqual([coffee.id, expect.any(String)]);
  });

  it("a model without languages reads its relation to a model with languages the same way", async () => {
    const { post, coffee } = await buildLinks();
    const made = await post.create({ title: "P", category: coffee.id });

    const en = await post.show(made.id, { locale: "en" });
    const none = await post.show(made.id);
    const listed = await post.read({ locale: "en" });

    expect(en?.category).toMatchObject({ name: "Coffee", locale: "en" });
    expect(none?.category).toMatchObject({ name: "Kopi", locale: "id" });
    expect(listed.data[0]?.category).toMatchObject({ name: "Coffee" });
  });

  it("filters on a shared link in a language", async () => {
    const { article, coffee, tea, created } = await buildLinks();

    const byOne = await article.read({
      locale: "en",
      filters: { category: coffee.id },
    });
    const byMany = await article.read({
      locale: "en",
      filters: { categories: { $in: tea.id } },
    });
    const none = await article.read({
      locale: "en",
      filters: { category: tea.id },
    });

    expect(byOne.data.map((r) => r.id)).toEqual([created.id]);
    expect(byMany.data.map((r) => r.id)).toEqual([created.id]);
    expect(none.data).toHaveLength(0);
  });

  it("a shared list of links is copied onto every language and replaced in all of them", async () => {
    const { article, created, coffee, tea } = await buildLinks();

    await article.update(created.id, { categories: [tea.id] });

    for (const locale of ["id", "en"]) {
      const row = await db.adapter.find(
        article.i18nDef,
        `${created.id}.${locale}`,
      );
      expect(row?.categories).toEqual([tea.id]);
    }
    expect(
      (await article.show(created.id, { locale: "id" }))?.categories,
    ).toHaveLength(1);
    const main = await db.adapter.find(article.def, created.id);
    expect(main?.categories).toEqual([tea.id]);
    expect(main?.categories).not.toContain(coffee.id);
  });

  it("a file is one per language, and a list of files too", async () => {
    const { article, created, m1, m2, m3 } = await buildLinks();

    const all = await article.show(created.id);
    expect(all?.cover).toMatchObject({
      id: { id: m1.id, url: "id.png" },
      en: { id: m2.id, url: "en.png" },
    });
    expect(
      (obj(all?.gallery) as Record<string, Rec[]>).en!.map((f) => f.id),
    ).toEqual([m2.id, m3.id]);

    const en = await article.show(created.id, { locale: "en" });
    expect(en?.cover).toMatchObject({ id: m2.id, url: "en.png" });
    expect(list(en?.gallery).map((f) => f.url)).toEqual(["en.png", "en2.png"]);
  });

  it("a language without its own file takes the default language's, expanded the same way", async () => {
    const { article, m1 } = await buildLinks();
    const made = await article.create({
      title: { id: "Dua", en: "Two" },
      cover: { id: m1.id },
      gallery: { id: [m1.id] },
    });

    const en = await article.show(made.id, { locale: "en" });

    expect(en?.cover).toMatchObject({ id: m1.id, url: "id.png" });
    expect(list(en?.gallery).map((f) => f.url)).toEqual(["id.png"]);

    const bare = await article.show(made.id, {
      locale: "en",
      fallback: false,
    });
    expect(bare?.cover ?? null).toBeNull();
  });

  it("changes the file of one language and clears it with null", async () => {
    const { article, created, m1, m3 } = await buildLinks();

    const changed = await article.update(created.id, {
      cover: { en: m3.id },
      gallery: { en: [m1.id] },
    });
    expect(obj(changed?.cover).en).toMatchObject({ url: "en2.png" });
    expect(obj(changed?.cover).id).toMatchObject({ url: "id.png" });
    expect(obj(changed?.gallery).en).toHaveLength(1);

    const cleared = await article.update(created.id, { cover: { en: null } });
    expect(obj(cleared?.cover).en ?? null).toBeNull();
  });

  it("a relation cannot be localized: it follows the model it points at", async () => {
    const { category } = await buildLinks();

    expect(() =>
      makeModel(unique("m"), {
        name: "M",
        searchFields: [],
        i18n: true,
        schema: z.object({
          a: text({ label: "A", localized: true }),
          r: relation({ label: "R", localized: true }, category as never),
        }),
      } as never),
    ).toThrow("takes on the language of the model it points at");
  });

  it("publishes a language together with its links and its file", async () => {
    const { article, created, coffee, m2 } = await buildLinks();

    await article.publish(created.id, { locale: "en" });

    const live = await article.published.show(created.id, { locale: "en" });
    expect(live).toMatchObject({
      status: "published",
      category: { name: "Coffee", locale: "en" },
      cover: { id: m2.id, url: "en.png" },
    });
    expect(list(live?.categories).map((c) => c.name)).toEqual([
      "Coffee",
      "Teh",
    ]);

    await article.update(created.id, { cover: { en: null } });
    expect((await article.show(created.id))?.status).toMatchObject({
      en: "changed",
    });
    expect(
      (await article.published.show(created.id, { locale: "en" }))?.cover,
    ).toMatchObject({ url: "en.png" });
    expect(coffee.id).toBeTruthy();
  });
});

describe("defining an i18n model", () => {
  const model = (
    schema: ReturnType<typeof z.object>,
    options: Record<string, unknown> = {},
  ) =>
    makeModel(unique("m"), {
      name: "M",
      searchFields: [],
      schema: schema as never,
      i18n: true,
      ...options,
    } as never);

  it("needs a localized field", () => {
    expect(() => model(z.object({ a: text({ label: "A" }) }))).toThrow(
      "at least one field",
    );
  });

  it("can be searched, and selected from, through a relation in another model", async () => {
    const { article, author } = await build();
    const comment = makeModel(unique("comment"), {
      name: "Comment",
      searchFields: ["body", "article.title"],
      schema: z.object({
        body: text({ label: "Body" }),
        article: relation({ label: "Article" }, article, (r) => r.optional()),
      }),
    });
    // the whole set at once: a SQL adapter plans exactly the tables it is given
    await db.sync([author.def, article.def, article.i18nDef, comment.def]);
    const first = await article.create({
      slug: { id: "satu", en: "one" },
      title: { id: "Kopi pagi", en: "Morning coffee" },
      views: 7,
    });
    const second = await article.create({
      slug: { id: "dua", en: "two" },
      title: { id: "Teh sore", en: "Evening tea" },
      views: 9,
    });
    await comment.create({ body: "alpha", article: first.id });
    await comment.create({ body: "beta", article: second.id });

    const bodies = async (search: string, locale?: string) =>
      (await comment.read({ search, locale })).data.map((c) => c.body);

    // the text of any language when none is being read...
    expect(await bodies("coffee")).toEqual(["alpha"]);
    expect(await bodies("kopi")).toEqual(["alpha"]);
    // ...and that language's only, when one is
    expect(await bodies("coffee", "en")).toEqual(["alpha"]);
    expect(await bodies("coffee", "id")).toEqual([]);
    expect(await bodies("kopi", "id")).toEqual(["alpha"]);

    // a field of the related record, in the language being read
    const en = await comment.read({
      locale: "en",
      select: ["body", "article.title", "article.views"],
      sort: "body",
    });
    expect(en.data.map((c) => c.article)).toEqual([
      { id: first.id, title: "Morning coffee", views: 7 },
      { id: second.id, title: "Evening tea", views: 9 },
    ]);
    const none = await comment.read({
      select: ["article.title"],
      sort: "body",
    });
    expect(none.data[0]?.article).toEqual({ id: first.id, title: "Kopi pagi" });
    expect(none.data[0]).not.toHaveProperty("body");

    const shown = await comment.show(
      (await comment.read({ sort: "body" })).data[0]!.id,
      { locale: "en" },
    );
    expect(shown?.article).toMatchObject({ title: "Morning coffee" });
  });

  it("reserves the names of its own columns", () => {
    expect(() =>
      model(
        z.object({
          a: text({ label: "A", localized: true }),
          locale: text({ label: "L" }),
        }),
      ),
    ).toThrow("reserved");
  });

  it("explains a missing i18n config when it is used", async () => {
    const { article } = await build();
    const before = settings;
    settings = undefined;
    try {
      const error = await article.read({ locale: "en" }).catch((e) => e);
      expect((error as Error).message).toContain("i18n: { locales");
    } finally {
      settings = before;
    }
  });
});
