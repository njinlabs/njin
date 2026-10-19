import { describe, expect, it, mock } from "bun:test";
import z from "zod";
import * as realConfig from "../../src/core/config";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeAuthPlugin } from "../helpers/fake_auth";
import { makeFakeElysia } from "../helpers/fake_elysia";

let seoData = { title: "Default title" };

const fakeSeoGroup = {
  name: "SEO",
  prefix: "seo",
  validation: z.object({ title: z.string() }),
  get: async () => seoData,
  update: async (patch: Partial<typeof seoData>) => {
    seoData = { ...seoData, ...patch };
    return seoData;
  },
};

// A group with languages and drafts: every call reports the options it was given.
const calls: [string, unknown][] = [];
const fakePageGroup = {
  name: "Page",
  prefix: "page",
  i18n: true,
  draftable: true,
  validation: z.object({ title: z.record(z.string(), z.string()) }),
  get: async (options?: unknown) => {
    calls.push(["get", options]);
    return { title: "x" };
  },
  update: async (patch: unknown) => patch,
  published: {
    get: async (options?: unknown) => {
      calls.push(["published.get", options]);
      return { title: "live" };
    },
  },
  publish: async (options?: unknown) => {
    calls.push(["publish", options]);
    return { status: "published" };
  },
  unpublish: async (options?: unknown) => {
    calls.push(["unpublish", options]);
    return { status: "draft" };
  },
  discard: async (options?: unknown) => {
    calls.push(["discard", options]);
    return { status: "published" };
  },
  backfillPublished: async () => 0,
};

// Spreading real exports below — without --isolate, mock.module() replaces the module
// in a registry shared across the whole test run, so a partial mock would otherwise
// break other files that import loadConfig/injectBracketQuery from these specifiers.
mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({
    vars: [
      async () => ({ default: fakeSeoGroup }),
      async () => ({ default: fakePageGroup }),
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

const { default: vars } = await import("../../src/modules/vars");

await vars.init();
const app = fakeElysia.buildApp();

describe("GET /api/vars/:prefix", () => {
  it("returns the group's current data", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/vars/seo", {
        headers: { Authorization: "Bearer x" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { title: "Default title" } });
  });
});

describe("a group with languages and drafts", () => {
  const request = (path: string, method = "GET") =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { Authorization: "Bearer x" },
      }),
    );

  it("passes locale and fallback to get(), and reads what is live apart", async () => {
    calls.length = 0;

    await request("/api/vars/page?locale=en&fallback=false");
    const live = await request("/api/vars/page/published?locale=id");

    expect(calls).toEqual([
      ["get", { locale: "en", fallback: false }],
      ["published.get", { locale: "id", fallback: true }],
    ]);
    expect(await live.json()).toEqual({ data: { title: "live" } });
  });

  it("publishes, unpublishes and discards, for the languages in ?locale", async () => {
    calls.length = 0;

    await request("/api/vars/page/publish", "POST");
    await request("/api/vars/page/unpublish?locale=en", "POST");
    await request("/api/vars/page/discard?locale=en,%20id,", "POST");

    expect(calls).toEqual([
      ["publish", undefined],
      ["unpublish", { locale: ["en"] }],
      ["discard", { locale: ["en", "id"] }],
    ]);
  });

  it("does not mount the draft routes for a group that is not draftable", async () => {
    expect((await request("/api/vars/seo/publish", "POST")).status).toBe(404);
    expect((await request("/api/vars/seo/published")).status).toBe(404);
  });
});

describe("PUT /api/vars/:prefix", () => {
  it("updates the group and returns the new data", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/vars/seo", {
        method: "PUT",
        headers: {
          Authorization: "Bearer x",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "New title" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { title: "New title" } });
  });
});
