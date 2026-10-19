import { describe, expect, it, mock } from "bun:test";
import Elysia from "elysia";
import z from "zod";
import * as realConfig from "../../src/core/config";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeAuthPlugin } from "../helpers/fake_auth";
import { makeFakeElysia } from "../helpers/fake_elysia";

const hookCalls: string[] = [];
const eventCalls: string[] = [];

const records = new Map<string, Record<string, unknown>>();
records.set("p1", { id: "p1", title: "Hello" });

const fakeModel = {
  name: "Post",
  prefix: "post",
  validation: z.object({
    title: z.string(),
    owner: z.string().meta({ renderAs: "relation" }).optional(),
    tags: z.array(z.string()).meta({ renderAs: "multi_relation" }).optional(),
    cover: z.string().meta({ renderAs: "file" }).optional(),
    internalFlag: z
      .boolean()
      .meta({ renderAs: "boolean", hideForm: true })
      .optional(),
  }),
  read: async (opts: Record<string, unknown>) => ({
    data: Array.from(records.values()),
    opts,
  }),
  show: async (id: string) => records.get(id) ?? null,
  create: async (body: Record<string, unknown>) => {
    const record = { id: "p2", ...body };
    records.set("p2", record);
    return record;
  },
  update: async (id: string, body: Record<string, unknown>) => {
    const record = { ...(records.get(id) ?? {}), ...body, id };
    records.set(id, record);
    return record;
  },
  destroy: async (id: string) => {
    const record = records.get(id) ?? { id };
    records.delete(id);
    return record;
  },
};

// A draftable model: the plain CRUD of fakeModel plus the publish actions makeModel adds.
const draftCalls: string[] = [];
const draftOptions: unknown[] = [];
const fakeDraftModel = {
  ...fakeModel,
  name: "Article",
  prefix: "article",
  publishedDef: { name: "_published_article", fields: [], search: [] },
  publish: async (id: string, options?: unknown) => {
    draftCalls.push(`publish:${id}`);
    draftOptions.push(options);
    return { id, status: "published" };
  },
  unpublish: async (id: string) => {
    draftCalls.push(`unpublish:${id}`);
    return { id, status: "draft" };
  },
  discard: async (id: string) => {
    draftCalls.push(`discard:${id}`);
    return { id, status: "published" };
  },
  backfillPublished: async () => 0,
};

// An i18n model: the plain CRUD of fakeModel, a show() that reports its options, and the
// extras makeModel adds.
const fakeI18nModel = {
  ...fakeModel,
  name: "Page",
  prefix: "page",
  i18nDef: { name: "page__i18n", fields: [], search: [] },
  show: async (id: string, opts?: Record<string, unknown>) => ({ id, opts }),
  removeLocale: async (id: string, locale: string) => ({ id, removed: locale }),
};

const fakeVarsGroup = {
  name: "SEO",
  prefix: "seo",
  validation: z.object({ title: z.string() }),
};

let customRouteMounted = false;

// Spreading each real module's other exports below — without --isolate, mock.module()
// replaces the module in a registry shared across every test file in the run, so a
// partial mock would otherwise break other files that import the un-mocked exports
// from these same specifiers (e.g. loadConfig from core/config, injectBracketQuery
// from modules/elysia).
mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({
    models: [
      async () => ({ default: fakeModel }),
      async () => ({ default: fakeDraftModel }),
      async () => ({ default: fakeI18nModel }),
    ],
    i18n: { locales: ["id", "en"], defaultLocale: "id" },
    vars: [async () => ({ default: fakeVarsGroup })],
    hooks: [
      async () => {
        hookCalls.push("hook1");
      },
    ],
    events: [
      async () => {
        eventCalls.push("event1");
      },
    ],
    routes: [
      async () => {
        customRouteMounted = true;
        return { default: new Elysia().get("/custom", () => "custom-ok") };
      },
    ],
  }),
}));

const fakeAuthPlugin = makeFakeAuthPlugin();
mock.module("../../src/modules/auth", () => ({
  default: async () => ({ plugin: fakeAuthPlugin }),
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const { default: api } = await import("../../src/modules/api");

await api.init();
const app = fakeElysia.buildApp();

describe("api.init() wiring", () => {
  it("drains every hook and event factory before mounting routes", () => {
    expect(hookCalls).toEqual(["hook1"]);
    expect(eventCalls).toEqual(["event1"]);
  });

  it("mounts custom route factories", async () => {
    expect(customRouteMounted).toBe(true);
    const res = await app.handle(new Request("http://localhost/custom"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("custom-ok");
  });
});

describe("GET /api/schema", () => {
  it("returns admin-friendly JSON schema for models and vars, remapping relation/file types", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/schema", {
        headers: { Authorization: "Bearer x" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        name: string;
        prefix: string;
        draftable: boolean;
        i18n: boolean;
        schema: Record<string, unknown>;
      }[];
      i18n: { locales: string[]; defaultLocale: string } | null;
      vars: { name: string; prefix: string; schema: Record<string, unknown> }[];
    };

    expect(body.data).toHaveLength(3);
    expect(body.data[0]!.prefix).toBe("post");
    expect(body.data.map((m) => [m.prefix, m.draftable, m.i18n])).toEqual([
      ["post", false, false],
      ["article", true, false],
      ["page", false, true],
    ]);
    expect(body.i18n).toEqual({
      locales: ["id", "en"],
      defaultLocale: "id",
    });
    const props = (
      body.data[0]!.schema as {
        properties: Record<string, { type?: string; properties?: unknown }>;
      }
    ).properties;
    expect(props.owner!.type).toBe("object");
    expect((props.owner as { required?: string[] }).required).toEqual(["id"]);
    expect(props.cover!.type).toBe("string");

    expect(props.internalFlag).toBeUndefined();
    expect(
      (body.data[0]!.schema as { required?: string[] }).required,
    ).not.toContain("internalFlag");

    expect(body.vars).toHaveLength(1);
    expect(body.vars[0]!.prefix).toBe("seo");
    expect(body.vars[0]).toMatchObject({ draftable: false, i18n: false });
  });
});

describe("i18n routes", () => {
  const get = (path: string) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        headers: { Authorization: "Bearer x" },
      }),
    );

  it("passes locale and fallback to read() and show() of an i18n model", async () => {
    const list = (await (
      await get("/api/page?locale=en&fallback=false")
    ).json()) as {
      opts: { locale?: string; fallback?: boolean };
    };
    expect(list.opts).toMatchObject({ locale: "en", fallback: false });

    const shown = (await (await get("/api/page/p1?locale=id")).json()) as {
      data: { opts: { locale?: string; fallback?: boolean } };
    };
    expect(shown.data.opts).toEqual({ locale: "id", fallback: true });
  });

  it("hands the locale to a model without i18n too: its related i18n records follow it", async () => {
    const list = (await (await get("/api/post?locale=en")).json()) as {
      opts: Record<string, unknown>;
    };

    expect(list.opts).toMatchObject({ locale: "en" });
  });

  it("DELETE /api/page/:id/locale/:locale removes one language", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/page/p1/locale/en", {
        method: "DELETE",
        headers: { Authorization: "Bearer x" },
      }),
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      id: "p1",
      removed: "en",
    });
  });

  it("is not mounted for a model without i18n", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post/p1/locale/en", {
        method: "DELETE",
        headers: { Authorization: "Bearer x" },
      }),
    );

    expect(res.status).toBe(404);
  });
});

describe("draft routes", () => {
  const post = (path: string, authorization = "Bearer x") =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { Authorization: authorization },
      }),
    );

  it("POST /api/article/:id/publish|unpublish|discard call the model", async () => {
    draftCalls.length = 0;

    for (const action of ["publish", "unpublish", "discard"]) {
      const res = await post(`/api/article/a1/${action}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { id: string } }).data.id).toBe(
        "a1",
      );
    }

    expect(draftCalls).toEqual(["publish:a1", "unpublish:a1", "discard:a1"]);
  });

  it("passes the languages of ?locale to publish, or nothing", async () => {
    draftOptions.length = 0;

    await post("/api/article/a1/publish");
    await post("/api/article/a1/publish?locale=en");
    await post("/api/article/a1/publish?locale=en,%20id,");

    expect(draftOptions).toEqual([
      undefined,
      { locale: ["en"] },
      { locale: ["en", "id"] },
    ]);
  });

  it("is not mounted for a model that is not draftable", async () => {
    const res = await post("/api/post/p1/publish");

    expect(res.status).toBe(404);
  });
});

describe("model CRUD routes", () => {
  it("GET /api/post lists records and parses populate=none", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post?populate=none", {
        headers: { Authorization: "Bearer x" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { opts: { populate: unknown } };
    expect(body.opts.populate).toBe("none");
  });

  it("GET /api/post parses a comma-separated populate list", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post?populate=owner,tags", {
        headers: { Authorization: "Bearer x" },
      }),
    );
    const body = (await res.json()) as { opts: { populate: unknown } };
    expect(body.opts.populate).toEqual(["owner", "tags"]);
  });

  it("GET /api/post parses a comma-separated select list", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post?select=title, slug,,", {
        headers: { Authorization: "Bearer x" },
      }),
    );
    const body = (await res.json()) as { opts: { select: unknown } };
    expect(body.opts.select).toEqual(["title", "slug"]);
  });

  it("GET /api/post keeps operator filters as objects instead of stringifying them", async () => {
    const res = await app.handle(
      new Request(
        `http://localhost/api/post?filters=${encodeURIComponent(JSON.stringify({ price: { $gt: "100" }, title: { $contains: "ab" }, active: "true" }))}`,
        { headers: { Authorization: "Bearer x" } },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { opts: { filters: unknown } };
    expect(body.opts.filters).toEqual({
      price: { $gt: "100" },
      title: { $contains: "ab" },
      active: "true",
    });
  });

  it("GET /api/post/:id shows a single record", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post/p1", {
        headers: { Authorization: "Bearer x" },
      }),
    );
    expect(await res.json()).toEqual({ data: { id: "p1", title: "Hello" } });
  });

  it("POST /api/post creates a record", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post", {
        method: "POST",
        headers: {
          Authorization: "Bearer x",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "New Post" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.title).toBe("New Post");
  });

  it("PUT /api/post/:id updates a record", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post/p1", {
        method: "PUT",
        headers: {
          Authorization: "Bearer x",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Updated" }),
      }),
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.title).toBe("Updated");
  });

  it("DELETE /api/post/:id destroys a record", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post/p1", {
        method: "DELETE",
        headers: { Authorization: "Bearer x" },
      }),
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.id).toBe("p1");
  });
});
