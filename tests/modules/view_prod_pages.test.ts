import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realConfig from "../../src/core/config";
import * as realAnalyticsModule from "../../src/modules/analytics";
import * as realElysiaModule from "../../src/modules/elysia";
import * as realLoggerModule from "../../src/modules/logger";
import { makeFakeElysia } from "../helpers/fake_elysia";

// Production-mode page routes. NODE_ENV is read once at view.ts load time, so it is set
// before the dynamic import (and this file needs its own module registry).
process.env.NODE_ENV = "production";

const dir = mkdtempSync(join(tmpdir(), "njin-view-prodpages-"));
const views = join(dir, "src", "views");
mkdirSync(join(views, "pages"), { recursive: true });
mkdirSync(join(views, "errors"), { recursive: true });
mkdirSync(join(dir, "public", "assets"), { recursive: true });
writeFileSync(join(views, "pages", "ok.edge"), "<h1>ok</h1>");
writeFileSync(join(views, "pages", "boom.edge"), "{{ missing.deep.value }}");
writeFileSync(join(views, "errors", "500.edge"), "<h1>Custom 500</h1>");
writeFileSync(join(dir, "public", "robots.txt"), "User-agent: *");
writeFileSync(join(dir, "public", "assets", "app.js"), "console.log(1)");

const errorLog: unknown[] = [];

mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ models: [], vars: [], helpers: [], rootDir: dir }),
}));
mock.module("../../src/modules/analytics", () => ({
  ...realAnalyticsModule,
  default: () => ({ track: async () => {} }),
  resolveClientIp: () => null,
}));
mock.module("../../src/modules/logger", () => ({
  ...realLoggerModule,
  default: () => ({ error: (e: unknown) => errorLog.push(e) }),
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const { default: view } = await import("../../src/modules/view");
await view.init();
const app = fakeElysia.buildApp();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("production page routes", () => {
  it("renders errors/500.edge (not JSON) when a page crashes, hides details, and logs the error", async () => {
    const res = await app.handle(new Request("http://localhost/boom"));

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("<h1>Custom 500</h1>");
    expect(errorLog).toHaveLength(1);
  });

  it("sends HSTS only over https", async () => {
    const plain = await app.handle(new Request("http://localhost/ok"));
    expect(plain.headers.get("strict-transport-security")).toBeNull();

    const viaProxy = await app.handle(
      new Request("http://localhost/ok", {
        headers: { "x-forwarded-proto": "https" },
      }),
    );
    expect(viaProxy.headers.get("strict-transport-security")).toContain(
      "max-age=",
    );
  });

  it("serves built assets and public files, and 404s the rest with headers", async () => {
    const asset = await app.handle(
      new Request("http://localhost/assets/app.js"),
    );
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("console.log(1)");

    const missingAsset = await app.handle(
      new Request("http://localhost/assets/none.js"),
    );
    expect(missingAsset.status).toBe(404);

    const robots = await app.handle(new Request("http://localhost/robots.txt"));
    expect(await robots.text()).toBe("User-agent: *");

    const nope = await app.handle(new Request("http://localhost/nope"));
    expect(nope.status).toBe(404);
    expect(nope.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
