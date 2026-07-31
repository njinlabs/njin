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

// Spreading real exports below — without --isolate, mock.module() replaces the module
// in a registry shared across the whole test run, so a partial mock would otherwise
// break other files that import loadConfig/injectBracketQuery from these specifiers.
mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ vars: [async () => ({ default: fakeSeoGroup })] }),
}));

const fakeAuthPlugin = makeFakeAuthPlugin();
mock.module("../../src/modules/auth", () => ({ default: async () => ({ plugin: fakeAuthPlugin }) }));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({ ...realElysiaModule, default: fakeElysia.fn }));

const { default: vars } = await import("../../src/modules/vars");

await vars.init();
const app = fakeElysia.buildApp();

describe("GET /api/vars/:prefix", () => {
  it("returns the group's current data", async () => {
    const res = await app.handle(new Request("http://localhost/api/vars/seo", { headers: { Authorization: "Bearer x" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { title: "Default title" } });
  });
});

describe("PUT /api/vars/:prefix", () => {
  it("updates the group and returns the new data", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/vars/seo", {
        method: "PUT",
        headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New title" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { title: "New title" } });
  });
});
