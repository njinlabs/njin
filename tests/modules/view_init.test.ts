import { describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realConfig from "../../src/core/config";
import * as realAnalyticsModule from "../../src/modules/analytics";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeElysia } from "../helpers/fake_elysia";

// Own file (separate module registry under --isolate) — view.ts's fn.init() reads
// getConfig().rootDir at call time for src/views(/pages), and the mocked getConfig()
// below calls process.cwd() lazily too, so a chdir here doesn't collide with
// tests/modules/view.test.ts or view_prod.test.ts, which each fix their own cwd at
// different points.
//
// Each mock below spreads the real module's other exports — without --isolate,
// mock.module() replaces the module in a registry shared across the whole test run, so
// a partial mock would otherwise break other files importing the un-mocked exports
// (loadConfig, injectBracketQuery, isSameOrigin, ...).
const config: {
  models: unknown[];
  vars: unknown[];
  helpers: unknown[];
} = { models: [], vars: [], helpers: [] };

mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ ...config, rootDir: process.cwd() }),
}));

mock.module("vite", () => ({
  createServer: async () => ({
    listen: async () => {},
    printUrls: () => {},
    resolvedUrls: { local: ["http://localhost:5173/"] },
    close: async () => {},
  }),
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

// The page route fire-and-forgets `analytics().track(...)` on every request (see view.ts) —
// mocked so it doesn't reach the real (unconfigured) surreal()/logger() singletons and produce
// an unhandled rejection after a test returns. Spreads the real module's other exports for the
// same reason as the mocks above.
mock.module("../../src/modules/analytics", () => ({
  ...realAnalyticsModule,
  default: () => ({ track: async () => {} }),
  resolveClientIp: () => null,
}));

const { default: view } = await import("../../src/modules/view");

describe("view.init() — no src/views/pages directory", () => {
  it("mounts a controller with no page routes and no catch-all (Bun.Glob.scan() throws on a missing pagesDir)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "njin-view-init-"));
    const cwd = process.cwd();
    try {
      // src/views itself doesn't exist either — edge.mount() on a missing dir doesn't
      // throw (EdgeJS just won't find any templates), and Bun.Glob.scan() over a
      // missing pagesDir is what actually raises, hitting init()'s catch branch — which
      // returns early, before the catch-all "/*" route is ever registered.
      mkdirSync(join(dir, "src", "views"), { recursive: true });

      process.chdir(dir);
      await view.init();
      process.chdir(cwd);

      expect(fakeElysia.controllers).toHaveLength(1);
      const app = fakeElysia.buildApp();

      const res = await app.handle(new Request("http://localhost/nonexistent"));
      expect(res.status).toBe(404);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("view.init() — with a page and an errors/404.edge template", () => {
  it("mounts a route for the page file and renders the custom 404 template on catch-all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "njin-view-init-2-"));
    const cwd = process.cwd();
    try {
      const viewsDir = join(dir, "src", "views");
      mkdirSync(join(viewsDir, "pages"), { recursive: true });
      mkdirSync(join(viewsDir, "errors"), { recursive: true });
      writeFileSync(join(viewsDir, "pages", "about.edge"), "<h1>About</h1>");
      writeFileSync(
        join(viewsDir, "errors", "404.edge"),
        "<h1>Custom not found</h1>",
      );

      fakeElysia.controllers.length = 0;

      process.chdir(dir);
      await view.init();
      process.chdir(cwd);

      const app = fakeElysia.buildApp();

      const aboutRes = await app.handle(new Request("http://localhost/about"));
      expect(aboutRes.status).toBe(200);
      expect(await aboutRes.text()).toBe("<h1>About</h1>");

      const notFoundRes = await app.handle(
        new Request("http://localhost/nowhere"),
      );
      expect(notFoundRes.status).toBe(404);
      expect(await notFoundRes.text()).toBe("<h1>Custom not found</h1>");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("view.init() — template globals", () => {
  it("exposes models, vars groups and helpers to templates by name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "njin-view-globals-"));
    const cwd = process.cwd();
    try {
      const pages = join(dir, "src", "views", "pages");
      mkdirSync(pages, { recursive: true });
      writeFileSync(
        join(pages, "globals.edge"),
        "{{ post.label }}|{{ seo.label }}|{{ shout('hi') }}",
      );

      config.models = [
        async () => ({ default: { prefix: "post", label: "M" } }),
      ];
      config.vars = [async () => ({ default: { prefix: "seo", label: "V" } })];
      config.helpers = [
        async () => ({
          default: {
            name: "shout",
            fn: (value: string) => value.toUpperCase(),
          },
        }),
      ];

      fakeElysia.controllers.length = 0;
      process.chdir(dir);
      await view.init();
      process.chdir(cwd);

      const res = await fakeElysia
        .buildApp()
        .handle(new Request("http://localhost/globals"));
      expect(await res.text()).toBe("M|V|HI");
    } finally {
      config.models = [];
      config.vars = [];
      config.helpers = [];
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("view.init() — fallback abort global", () => {
  it("throws an HttpError when abort() is called outside a page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "njin-view-abort-"));
    const cwd = process.cwd();
    try {
      mkdirSync(join(dir, "src", "views", "pages"), { recursive: true });
      process.chdir(dir);
      await view.init();
      process.chdir(cwd);

      const { HttpError } = await import("../../src/core/http_error");
      const abort = (view() as any).globals.abort as (
        code: number,
        message?: string,
      ) => never;

      expect(() => abort(403, "no")).toThrow(HttpError);
      expect(() => abort(403, "no")).toThrow("no");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
