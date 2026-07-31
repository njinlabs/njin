import { describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realAnalyticsModule from "../../src/modules/analytics";
import * as realConfig from "../../src/core/config";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeElysia } from "../helpers/fake_elysia";

// Own file (separate module registry under --isolate) — view.ts's fn.init() reads
// process.cwd() at call time for src/views(/pages), so a chdir here doesn't collide
// with tests/modules/view.test.ts or view_prod.test.ts, which each fix their own cwd
// at different points.
//
// Each mock below spreads the real module's other exports — without --isolate,
// mock.module() replaces the module in a registry shared across the whole test run, so
// a partial mock would otherwise break other files importing the un-mocked exports
// (loadConfig, injectBracketQuery, isSameOrigin, ...).
mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ models: [], vars: [] }),
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
mock.module("../../src/modules/elysia", () => ({ ...realElysiaModule, default: fakeElysia.fn }));

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
      writeFileSync(join(viewsDir, "errors", "404.edge"), "<h1>Custom not found</h1>");

      const isolatedElysia = makeFakeElysia();
      mock.module("../../src/modules/elysia", () => ({ ...realElysiaModule, default: isolatedElysia.fn }));
      mock.module("../../src/core/config", () => ({ ...realConfig, getConfig: () => ({ models: [], vars: [] }) }));
      // The page route fire-and-forgets `analytics().track(...)` on every request (see
      // view.ts) — mocked here so it doesn't reach the real (unconfigured) surreal()/
      // logger() singletons and produce an unhandled rejection after this test returns.
      // Spreads the real module's other exports (isSameOrigin, ...) for the same reason
      // as the mocks above.
      mock.module("../../src/modules/analytics", () => ({
        ...realAnalyticsModule,
        default: () => ({ track: async () => {} }),
        resolveClientIp: () => null,
      }));

      process.chdir(dir);
      // @ts-expect-error — query string forces a fresh module instance under Bun; not a resolvable TS module path
      const { default: viewWithPages } = await import("../../src/modules/view?withpages");
      await viewWithPages.init();
      process.chdir(cwd);

      const app = isolatedElysia.buildApp();

      const aboutRes = await app.handle(new Request("http://localhost/about"));
      expect(aboutRes.status).toBe(200);
      expect(await aboutRes.text()).toBe("<h1>About</h1>");

      const notFoundRes = await app.handle(new Request("http://localhost/nowhere"));
      expect(notFoundRes.status).toBe(404);
      expect(await notFoundRes.text()).toBe("<h1>Custom not found</h1>");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
