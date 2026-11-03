import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "../../src/core/api/plugin";
import { setAdminDevUrl } from "../../src/core/http/admin_dev";
import { loadConfig } from "../../src/core/runtime/config";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeElysia } from "../helpers/fake_elysia";

// Spreads the real module's other exports (injectBracketQuery) — without --isolate,
// mock.module() replaces the module in a registry shared across the whole test run, so
// a partial mock would otherwise break other files that import it by name.
const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const dir = mkdtempSync(join(tmpdir(), "njin-admin-"));
mkdirSync(join(dir, "_admin"));
writeFileSync(join(dir, "_admin", "index.html"), "<html>admin shell</html>");
mkdirSync(join(dir, "_admin", "assets"));
writeFileSync(join(dir, "_admin", "assets", "app.js"), "console.log(1)");

// admin.ts resolves its adminDir from getConfig().rootDir, read lazily inside fn.init() —
// load a config pointing at the temp dir before init() runs.
await loadConfig({ rootDir: dir });
const { default: admin } = await import("../../src/modules/admin");
await admin.init();

const app = fakeElysia.buildApp();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("admin", () => {
  it("serves the admin shell at /_admin", async () => {
    const res = await app.handle(new Request("http://localhost/_admin"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>admin shell</html>");
  });

  it("serves an existing static asset under /_admin/*", async () => {
    const res = await app.handle(
      new Request("http://localhost/_admin/assets/app.js"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
  });

  it("falls back to the admin shell (SPA) for an unknown path", async () => {
    const res = await app.handle(
      new Request("http://localhost/_admin/some/client/route"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>admin shell</html>");
  });

  it("falls back to the admin shell for a path-traversal attempt", async () => {
    const res = await app.handle(
      new Request("http://localhost/_admin/..%2f..%2fetc%2fpasswd"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>admin shell</html>");
  });

  it("falls back to the admin shell when the wildcard segment fails to decode", async () => {
    const res = await app.handle(
      new Request("http://localhost/_admin/%E0%A4%A"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>admin shell</html>");
  });

  it("lists no plugins at /api/admin/manifest when none is served", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/admin/manifest"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plugins: [] });
  });

  it("lists the plugins' admin sides on the dev server", async () => {
    await loadConfig({
      rootDir: dir,
      plugins: [definePlugin({ admin: ["/p/reports/admin/index.tsx"] })],
    });
    setAdminDevUrl("http://localhost:5173");

    const res = await app.handle(
      new Request("http://localhost/api/admin/manifest"),
    );
    expect(await res.json()).toEqual({
      plugins: [
        { entry: "http://localhost:5173/@fs//p/reports/admin/index.tsx" },
      ],
    });

    setAdminDevUrl(undefined);
    await loadConfig({ rootDir: dir });
  });
});
