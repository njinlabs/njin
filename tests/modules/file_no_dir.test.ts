import { describe, expect, it, mock } from "bun:test";
import * as realConfig from "../../src/core/config";
import * as realElysiaModule from "../../src/modules/elysia";
import * as realSurrealModule from "../../src/modules/surreal";
import { makeFakeAuthPlugin } from "../helpers/fake_auth";
import { makeFakeElysia } from "../helpers/fake_elysia";

// Separate file (not just a separate describe block) so --isolate gives it its own
// fresh module registry — src/modules/file.ts is a singleton whose behavior depends on
// getConfig() at the time of init(), so this variant needs a completely independent
// import from tests/modules/file.test.ts's "adapters.file.dir set" scenario.
//
// Each mock below spreads the real module's other exports — without --isolate,
// mock.module() replaces the module in a registry shared across the whole test run, so
// a partial mock would otherwise break other files importing the un-mocked exports.
mock.module("../../src/modules/surreal", () => ({
  ...realSurrealModule,
  default: () => ({ read: async () => ({ data: [], meta: {} }) }),
}));

mock.module("../../src/models/file", () => ({
  default: { read: async () => ({ data: [], meta: {} }), table: "file" },
}));

mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({
    adapters: {
      file: {
        // No `dir` — the S3-style adapter case, where /uploads/* should never be mounted.
        write: async (f: File) => ({ name: f.name, size: f.size, type: f.type, meta: null, url: "/x" }),
        unlink: async () => {},
      },
    },
  }),
}));

const fakeAuthPlugin = makeFakeAuthPlugin();
mock.module("../../src/modules/auth", () => ({ default: async () => ({ plugin: fakeAuthPlugin }) }));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({ ...realElysiaModule, default: fakeElysia.fn }));

const { default: file } = await import("../../src/modules/file");

describe("file module without adapters.file.dir configured", () => {
  it("does not mount the /uploads/* static route", async () => {
    await file.init();
    expect(fakeElysia.controllers).toHaveLength(1);
  });
});
