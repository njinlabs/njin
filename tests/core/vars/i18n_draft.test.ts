import { describe, expect, it, mock } from "bun:test";
import * as realConfig from "../../../src/core/config";
import { varsPublishedTable, varsTable } from "../../../src/core/db/internal";
import { useTestDb } from "../../helpers/test_db";

// A project with two languages; the settings groups here are the ones that use them.
mock.module("../../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ i18n: { locales: ["id", "en"], defaultLocale: "id" } }),
}));

const db = await useTestDb();

const { makeVars, isDraftableVars } = await import("../../../src/core/vars");
const { afterVarsPublish, afterVarsUnpublish } = await import(
  "../../../src/core/model/hooks"
);
const { HttpError } = await import("../../../src/core/http_error");
const { text } = await import("../../../src/core/model/data_type/text");
const { array } = await import("../../../src/core/model/data_type/array");
const { relation } = await import("../../../src/core/model/data_type/relation");
const { makeModel } = await import("../../../src/core/model/index");
const { toAdminSchema } = await import("../../../src/core/admin_schema");
const z = (await import("zod")).default;

const prefix = () => `vars_${crypto.randomUUID().replace(/-/g, "")}`;

const fields = () => ({
  tagline: text({ label: "Tagline", localized: true }, (z) =>
    z.default("Selamat datang"),
  ),
  links: array({ label: "Links", localized: true }, z.string(), (a) =>
    a.default([]),
  ),
  phone: text({ label: "Phone" }, (z) => z.default("")),
});

const status = (error: unknown) =>
  (error as InstanceType<typeof HttpError>).statusCode;

describe("a localized settings group", () => {
  const site = () =>
    makeVars(prefix(), {
      name: "Site",
      i18n: true,
      schema: z.object(fields()),
    });

  it("returns every language, with the defaults filled in, until it is saved", async () => {
    const result = await site().get();

    expect(result).toEqual({
      tagline: { id: "Selamat datang", en: "Selamat datang" },
      links: { id: [], en: [] },
      phone: "",
      updatedAt: null,
    });
  });

  it("changes only the languages it is given, and keeps the other ones", async () => {
    const group = site();
    await group.update({
      tagline: { id: "Halo", en: "Hello" },
      links: { en: ["a", "b"] },
      phone: "123",
    });

    const result = await group.update({ tagline: { en: "Hi" } });

    expect(result.tagline).toEqual({ id: "Halo", en: "Hi" });
    expect(result.links).toEqual({ id: [], en: ["a", "b"] });
    expect(result.phone).toBe("123");
    expect(result.updatedAt).not.toBeNull();
  });

  it("reads one language flat, falling back to the default language", async () => {
    const group = site();
    await group.update({ tagline: { id: "Halo" }, links: { id: ["x"] } });

    const en = await group.get({ locale: "en" });
    expect(en.tagline).toBe("Halo");
    expect(en.links).toEqual(["x"]);

    const strict = await group.get({ locale: "en", fallback: false });
    expect(strict.tagline).toBe("Selamat datang");
    expect(strict.links).toEqual([]);

    await group.update({ tagline: { en: "Hello" } });
    expect((await group.get({ locale: "en" })).tagline).toBe("Hello");
    expect((await group.get({ locale: "id" })).tagline).toBe("Halo");
  });

  it("clears one language with null, which then falls back", async () => {
    const group = site();
    await group.update({ tagline: { id: "Halo", en: "Hello" } });

    await group.update({ tagline: { en: null } });

    expect((await group.get()).tagline).toEqual({
      id: "Halo",
      en: "Selamat datang",
    });
    expect((await group.get({ locale: "en" })).tagline).toBe("Halo");
  });

  it("refuses a locale that is not configured, and a plain value for a localized field", async () => {
    const group = site();

    const unknown = await group.get({ locale: "fr" }).catch((e) => e);
    expect(status(unknown)).toBe(400);
    const badKey = await group
      .update({ tagline: { fr: "Salut" } })
      .catch((e) => e);
    expect(status(badKey)).toBe(400);
    const plain = await group.update({ tagline: "Halo" }).catch((e) => e);
    expect(status(plain)).toBe(422);
  });

  it("validates localized fields as maps and describes them to the admin panel", () => {
    const group = site();

    expect(group.validation.safeParse({ tagline: { id: "a" } }).success).toBe(
      true,
    );
    expect(group.validation.safeParse({ tagline: { fr: "a" } }).success).toBe(
      false,
    );

    const schema = toAdminSchema(group.validation) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.tagline).toMatchObject({
      type: "object",
      localized: true,
    });
    expect(schema.properties.phone?.localized).toBeUndefined();
  });

  it("is not draftable unless it says so", () => {
    expect(isDraftableVars(site())).toBe(false);
  });
});

describe("defining a settings group", () => {
  it("needs i18n: true for a localized field, and a localized field for i18n: true", () => {
    expect(() =>
      makeVars(prefix(), { name: "A", schema: z.object(fields()) }),
    ).toThrow("needs `i18n: true`");
    expect(() =>
      makeVars(prefix(), {
        name: "B",
        i18n: true,
        schema: z.object({ phone: text({ label: "P" }, (z) => z.default("")) }),
      }),
    ).toThrow("at least one field");
  });

  it("does not localize a relation, but a file can differ per language", async () => {
    const media = makeModel(prefix(), {
      name: "Media",
      searchFields: [],
      schema: z.object({ url: text({ label: "Url" }) }),
    });
    await db.sync([media.def]);
    const first = await media.create({ url: "a.png" });
    const second = await media.create({ url: "b.png" });

    // what file() / multiFile() tag their fields with
    const group = makeVars(prefix(), {
      name: "Branding",
      i18n: true,
      schema: z.object({
        tagline: text({ label: "T", localized: true }, (z) => z.default("")),
        logo: z.string().optional().meta({
          label: "Logo",
          renderAs: "file",
          model: media.prefix,
          localized: true,
        }),
        photos: z.array(z.string()).default([]).meta({
          label: "Photos",
          renderAs: "multi_file",
          model: media.prefix,
          localized: true,
        }),
      }),
    });

    await group.update({
      logo: { id: first.id, en: second.id },
      photos: { en: [first.id, second.id] },
    });

    expect((await group.get()).logo).toEqual({ id: first.id, en: second.id });
    expect((await group.get({ locale: "en" })).photos).toEqual([
      first.id,
      second.id,
    ]);
    // no file in English of its own -> the default language's
    await group.update({ logo: { en: null } });
    expect((await group.get({ locale: "en" })).logo).toBe(first.id);
  });

  it("does not localize a relation, and reserves status and publishedAt when draftable", () => {
    const target = makeModel(prefix(), {
      name: "T",
      searchFields: [],
      schema: z.object({ n: text({ label: "N" }) }),
    });

    expect(() =>
      makeVars(prefix(), {
        name: "C",
        i18n: true,
        schema: z.object({
          ...fields(),
          pick: relation({ label: "Pick", localized: true }, target, (r) =>
            r.optional(),
          ),
        }),
      }),
    ).toThrow("takes on the language of the model it points at");

    expect(() =>
      makeVars(prefix(), {
        name: "D",
        draftable: true,
        schema: z.object({
          status: text({ label: "S" }, (z) => z.default("")),
        }),
      }),
    ).toThrow("reserved");
  });
});

describe("a draftable settings group", () => {
  const general = () =>
    makeVars(prefix(), {
      name: "General",
      draftable: true,
      schema: z.object({
        siteName: text({ label: "Name" }, (z) => z.default("My Site")),
        phone: text({ label: "Phone" }, (z) => z.default("")),
      }),
    });

  it("is a draft until it is published, and what is live is the defaults", async () => {
    const group = general();
    await group.update({ siteName: "Playground" });

    const working = await group.get();
    expect(working).toMatchObject({
      siteName: "Playground",
      status: "draft",
      publishedAt: null,
    });
    expect(await group.published.get()).toEqual({
      siteName: "My Site",
      phone: "",
      publishedAt: null,
    });
  });

  it("publishes, keeps what is live while it is edited, and discards the edits", async () => {
    const group = general();
    await group.update({ siteName: "One", phone: "1" });

    const published = await group.publish();
    expect(published.status).toBe("published");
    expect(typeof published.publishedAt).toBe("string");
    expect(await group.published.get()).toMatchObject({
      siteName: "One",
      phone: "1",
    });

    const edited = await group.update({ siteName: "Two" });
    expect(edited.status).toBe("changed");
    expect((await group.published.get()).siteName).toBe("One");
    expect((await group.get()).siteName).toBe("Two");

    const back = await group.discard();
    expect(back.status).toBe("published");
    expect(back.siteName).toBe("One");

    await group.update({ siteName: "Three" });
    await group.publish();
    expect((await group.published.get()).siteName).toBe("Three");
  });

  it("unpublishes, keeping the working copy as a draft", async () => {
    const group = general();
    await group.update({ siteName: "One" });
    await group.publish();

    const result = await group.unpublish();

    expect(result).toMatchObject({ siteName: "One", status: "draft" });
    expect((await group.published.get()).siteName).toBe("My Site");
    expect(await db.adapter.find(varsPublishedTable, group.prefix)).toBeNull();
  });

  it("refuses to discard what was never published", async () => {
    const group = general();
    await group.update({ siteName: "One" });

    const error = await group.discard().catch((e) => e);

    expect(status(error)).toBe(409);
  });

  it("publishes the values that predate drafts, once and without hooks", async () => {
    const group = general();
    let fired = 0;
    afterVarsPublish(group, () => {
      fired += 1;
    });
    // saved before the group was draftable: no live document
    await db.adapter.upsert(varsTable, group.prefix, {
      siteName: "Old",
      updatedAt: new Date().toISOString(),
    });

    expect(await group.backfillPublished()).toBe(1);
    expect(await group.backfillPublished()).toBe(0);

    expect((await group.published.get()).siteName).toBe("Old");
    expect((await group.get()).status).toBe("published");
    expect(fired).toBe(0);
  });

  it("does not publish a group that was never saved", async () => {
    expect(await general().backfillPublished()).toBe(0);
  });

  it("fires the hooks after publish and unpublish", async () => {
    const group = general();
    const seen: string[] = [];
    afterVarsPublish(group, (record) => {
      seen.push(`publish:${(record as { status: string }).status}`);
    });
    afterVarsUnpublish(group, (record) => {
      seen.push(`unpublish:${(record as { status: string }).status}`);
    });
    await group.update({ siteName: "One" });

    await group.publish();
    await group.unpublish();

    expect(seen).toEqual(["publish:published", "unpublish:draft"]);
  });

  it("is recognised as draftable", () => {
    expect(isDraftableVars(general())).toBe(true);
  });
});

describe("a draftable settings group with languages", () => {
  const site = () =>
    makeVars(prefix(), {
      name: "Site",
      i18n: true,
      draftable: true,
      schema: z.object(fields()),
    });

  it("starts every language as a draft", async () => {
    const group = site();
    await group.update({ tagline: { id: "Halo", en: "Hello" } });

    const result = await group.get();

    expect(result.status).toEqual({ id: "draft", en: "draft" });
    expect(result.publishedAt).toEqual({ id: null, en: null });
  });

  it("publishes one language and leaves the other as it was", async () => {
    const group = site();
    await group.update({
      tagline: { id: "Halo", en: "Hello" },
      links: { en: ["a"] },
      phone: "1",
    });

    const result = await group.publish({ locale: "en" });

    expect(result.status).toEqual({ id: "draft", en: "published" });
    const en = await group.published.get({ locale: "en" });
    expect(en).toMatchObject({ tagline: "Hello", links: ["a"], phone: "1" });
    // "id" is not live: it has its defaults, not the working copy's text
    const id = await group.published.get({ locale: "id" });
    expect(id.tagline).toBe("Selamat datang");
    expect(id.publishedAt).toEqual({ id: null, en: expect.any(String) });
  });

  it("keeps what is live when a language is edited", async () => {
    const group = site();
    await group.update({ tagline: { id: "Halo", en: "Hello" } });
    await group.publish();

    const edited = await group.update({ tagline: { en: "Hi" } });

    expect(edited.status).toEqual({ id: "published", en: "changed" });
    expect((await group.published.get({ locale: "en" })).tagline).toBe("Hello");
    expect((await group.get({ locale: "en" })).tagline).toBe("Hi");
  });

  it("a shared edit makes the live languages changed, and publishing one language settles the others", async () => {
    const group = site();
    await group.update({ tagline: { id: "Halo", en: "Hello" }, phone: "1" });
    await group.publish({ locale: "en" });

    const edited = await group.update({ phone: "2" });
    expect(edited.status).toEqual({ id: "draft", en: "changed" });
    expect((await group.published.get({ locale: "en" })).phone).toBe("1");

    // publishing "id" puts the shared value live for everyone, and "en" only differed in that
    const result = await group.publish({ locale: "id" });
    expect(result.status).toEqual({ id: "published", en: "published" });
    expect((await group.published.get({ locale: "en" })).phone).toBe("2");
  });

  it("unpublishes one language; when none is live the live document goes", async () => {
    const group = site();
    await group.update({ tagline: { id: "Halo", en: "Hello" } });
    await group.publish();

    const one = await group.unpublish({ locale: "en" });
    expect(one.status).toEqual({ id: "published", en: "draft" });
    expect((await group.published.get({ locale: "id" })).tagline).toBe("Halo");
    expect((await group.published.get({ locale: "en" })).tagline).toBe("Halo"); // falls back to the live default

    await group.unpublish({ locale: "id" });
    expect(await db.adapter.find(varsPublishedTable, group.prefix)).toBeNull();
    expect((await group.get()).tagline).toEqual({ id: "Halo", en: "Hello" });
  });

  it("discards the edits of one language, leaving the shared fields alone", async () => {
    const group = site();
    await group.update({ tagline: { id: "Halo", en: "Hello" }, phone: "1" });
    await group.publish();
    await group.update({ tagline: { en: "WIP" }, phone: "2" });

    const result = await group.discard({ locale: "en" });

    expect((await group.get()).tagline).toEqual({ id: "Halo", en: "Hello" });
    expect((await group.get()).phone).toBe("2"); // shared: not touched
    // a shared edit is still pending in both languages
    expect(result.status).toEqual({ id: "changed", en: "changed" });
  });

  it("refuses to discard a language that is not live, and a language that is not configured", async () => {
    const group = site();
    await group.update({ tagline: { id: "Halo" } });
    await group.publish({ locale: "id" });

    expect(status(await group.discard({ locale: "en" }).catch((e) => e))).toBe(
      409,
    );
    expect(status(await group.publish({ locale: "fr" }).catch((e) => e))).toBe(
      400,
    );
  });

  it("falls back to the live copy of the default language, and only to that", async () => {
    const group = site();
    await group.update({ tagline: { id: "Halo", en: "" } });

    // nothing live: nothing to borrow
    await group.publish({ locale: "en" });
    expect((await group.published.get({ locale: "en" })).tagline).toBe(
      "Selamat datang",
    );

    await group.publish({ locale: "id" });
    expect((await group.published.get({ locale: "en" })).tagline).toBe("Halo");
    expect(
      (await group.published.get({ locale: "en", fallback: false })).tagline,
    ).toBe("Selamat datang");
  });

  it("publishes the languages that predate drafts", async () => {
    const group = site();
    await db.adapter.upsert(varsTable, group.prefix, {
      tagline: { id: "Lama", en: "Old" },
      updatedAt: new Date().toISOString(),
    });

    expect(await group.backfillPublished()).toBe(1);

    expect((await group.get()).status).toEqual({
      id: "published",
      en: "published",
    });
    expect((await group.published.get({ locale: "en" })).tagline).toBe("Old");
  });
});
