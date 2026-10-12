import { afterAll, describe, expect, it, mock } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realConfig from "../../src/core/config";
import * as realAnalyticsModule from "../../src/modules/analytics";
import * as realElysiaModule from "../../src/modules/elysia";
import * as realLoggerModule from "../../src/modules/logger";
import { makeFakeElysia } from "../helpers/fake_elysia";

// NODE_ENV is read once at view.ts load time — set before the dynamic import.
process.env.NODE_ENV = "production";

const dir = mkdtempSync(join(tmpdir(), "njin-view-static-"));
const outDir = mkdtempSync(join(tmpdir(), "njin-view-static-out-"));
const views = join(dir, "src", "views");
mkdirSync(join(views, "pages", "blog"), { recursive: true });
mkdirSync(join(views, "errors"), { recursive: true });
writeFileSync(
  join(views, "pages", "index.edge"),
  "<h1>home {{ request.path }} {{ request.url }}</h1>{{ vite.asset('src/client/main.ts') }}",
);
writeFileSync(join(views, "pages", "about.edge"), "<h1>about live</h1>");
writeFileSync(join(views, "pages", "gone.edge"), "{{ abort(404, 'nope') }}");
writeFileSync(join(views, "pages", "blog", "[slug].edge"), "<h1>post</h1>");
writeFileSync(join(views, "errors", "404.edge"), "<h1>Custom 404</h1>");

// A manifest that only exists under the *out* dir, like a real build.
mkdirSync(join(outDir, "public"), { recursive: true });
writeFileSync(
  join(outDir, "public", "manifest.json"),
  JSON.stringify({
    "src/client/main.ts": { file: "assets/main-abc123.js", isEntry: true },
  }),
);

const fakeModel = { prefix: "post", read: async () => "from-db" };
const fakeVars = { prefix: "general", name: "live site" };
const shout = { name: "shout", fn: (s: string) => s.toUpperCase() };
writeFileSync(join(views, "pages", "model.edge"), "{{ await post.read() }}");
writeFileSync(join(views, "pages", "vars.edge"), "{{ general.name }}");
writeFileSync(join(views, "pages", "helper.edge"), "{{ shout('hi') }}");

let staticRoutes = ["/", "/about"];
const tracked: string[] = [];

mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({
    models: [() => Promise.resolve({ default: fakeModel })],
    vars: [() => Promise.resolve({ default: fakeVars })],
    helpers: [() => Promise.resolve({ default: shout })],
    rootDir: dir,
    port: 4321,
    publicUrl: "https://example.com/",
    static: staticRoutes,
  }),
}));
mock.module("../../src/modules/analytics", () => ({
  ...realAnalyticsModule,
  default: () => ({
    track: async ({ path }: { path: string }) => tracked.push(path),
  }),
  resolveClientIp: () => null,
}));
mock.module("../../src/modules/logger", () => ({
  ...realLoggerModule,
  default: () => ({ error: () => {} }),
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const { default: view, renderStaticSite } = await import(
  "../../src/modules/view"
);
await view.init();
const app = fakeElysia.buildApp();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

describe("renderStaticSite", () => {
  it("writes index.html per route using out/public's manifest and the public url", async () => {
    const written = await renderStaticSite(outDir);

    expect(written).toEqual([
      join(outDir, "static", "index.html"),
      join(outDir, "static", "about", "index.html"),
    ]);
    const home = readFileSync(written[0] as string, "utf8");
    expect(home).toContain("home /");
    expect(home).toContain("https://example.com/");
    expect(home).toContain("/assets/main-abc123.js");
    expect(readFileSync(written[1] as string, "utf8")).toBe(
      "<h1>about live</h1>",
    );
  });

  it("fails when a route has no page, or the page aborts", async () => {
    staticRoutes = ["/missing"];
    await expect(renderStaticSite(outDir)).rejects.toThrow(/no matching page/);

    staticRoutes = ["/blog/:slug"];
    await expect(renderStaticSite(outDir)).rejects.toThrow(/no matching page/);

    staticRoutes = ["/gone"];
    await expect(renderStaticSite(outDir)).rejects.toThrow(
      /Failed to render static route "\/gone": abort\(404\)/,
    );
    staticRoutes = ["/", "/about"];
  });

  it("runs helpers, but rejects models and vars since there is no database", async () => {
    staticRoutes = ["/helper"];
    const [file] = await renderStaticSite(outDir);
    expect(readFileSync(file as string, "utf8")).toBe("HI");

    staticRoutes = ["/model"];
    await expect(renderStaticSite(outDir)).rejects.toThrow(
      /model "post" can't be used in a static page/,
    );

    staticRoutes = ["/vars"];
    await expect(renderStaticSite(outDir)).rejects.toThrow(
      /vars "general" can't be used in a static page/,
    );
    staticRoutes = ["/", "/about"];
  });
});

describe("serving static pages in production", () => {
  it("serves the pre-rendered file, with page headers, and still tracks the visit", async () => {
    mkdirSync(join(dir, "static", "about"), { recursive: true });
    writeFileSync(
      join(dir, "static", "about", "index.html"),
      "<h1>about frozen</h1>",
    );

    const res = await app.handle(new Request("http://localhost/about"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>about frozen</h1>");
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    await Bun.sleep(10);
    expect(tracked).toContain("/about");
  });

  it("falls back to live rendering when the static file is missing", async () => {
    const res = await app.handle(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("home /");
  });

  it("renders live for pages not marked static", async () => {
    const res = await app.handle(new Request("http://localhost/gone"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Custom 404</h1>");
  });
});
