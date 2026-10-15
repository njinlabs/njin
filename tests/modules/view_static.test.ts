import { afterAll, describe, expect, it, mock } from "bun:test";
import {
  existsSync,
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
const views = join(dir, "src", "views");
mkdirSync(join(views, "pages", "blog"), { recursive: true });
mkdirSync(join(views, "errors"), { recursive: true });
writeFileSync(
  join(views, "pages", "index.edge"),
  "<h1>home {{ request.path }} {{ request.url }}</h1>{{ vite.asset('src/client/main.ts') }}",
);
writeFileSync(join(views, "pages", "about.edge"), "<h1>about live</h1>");
writeFileSync(join(views, "pages", "gone.edge"), "{{ abort(404, 'nope') }}");
writeFileSync(
  join(views, "pages", "blog", "[slug].edge"),
  "@if(params.slug === 'missing')\n{{ abort(404) }}\n@end\n<h1>post {{ params.slug }} #{{ tick() }}</h1>",
);
writeFileSync(
  join(views, "pages", "ticker.edge"),
  "<h1>ticker #{{ tick() }}</h1>",
);
writeFileSync(join(views, "errors", "404.edge"), "<h1>Custom 404</h1>");

mkdirSync(join(dir, "public"), { recursive: true });
writeFileSync(
  join(dir, "public", "manifest.json"),
  JSON.stringify({
    "src/client/main.ts": { file: "assets/main-abc123.js", isEntry: true },
  }),
);

let renders = 0;
const tick = { name: "tick", fn: () => ++renders };

const staticRoutes = [
  { route: "/" },
  { route: "/about" },
  { route: "/blog/:slug" },
  { route: "/ticker", revalidate: 0.3 },
  { route: "/gone" },
];
const tracked: string[] = [];

mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({
    models: [],
    vars: [],
    helpers: [() => Promise.resolve({ default: tick })],
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

const { default: view } = await import("../../src/modules/view");
const { purgeStatic, warmStatic, getOrRenderStatic, readStatic } = await import(
  "../../src/core/static_cache"
);
const viewModule = await view.init();
viewModule.spin?.();
const app = fakeElysia.buildApp();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const cacheFile = (...segs: string[]) =>
  join(dir, ".cache", "static", ...segs, "index.html");
const get = (path: string, headers?: Record<string, string>) =>
  app.handle(new Request(`http://localhost${path}`, { headers }));
const cacheState = async (path: string) =>
  (await get(path)).headers.get("x-njin-cache");
// Purge warms plain routes in the background — wait for it before asserting on the cache.
const settle = () => Bun.sleep(30);

describe("on-demand static pages in production", () => {
  it("warms plain static routes at boot", async () => {
    await settle();
    expect(readFileSync(cacheFile(), "utf8")).toContain("home /");
    expect(readFileSync(cacheFile("about"), "utf8")).toBe(
      "<h1>about live</h1>",
    );
    // dynamic routes can't be warmed — no params yet
    expect(existsSync(cacheFile("blog"))).toBe(false);
  });

  it("serves the cache with page headers and an X-Njin-Cache header", async () => {
    const res = await get("/about");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>about live</h1>");
    expect(res.headers.get("x-njin-cache")).toBe("HIT");
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    writeFileSync(join(views, "pages", "about.edge"), "<h1>about v2</h1>");
    expect(await (await get("/about")).text()).toBe("<h1>about live</h1>");
  });

  it("answers conditional requests from the cache and still tracks visits", async () => {
    const etag = (await get("/about")).headers.get("etag") as string;
    const res = await get("/about", { "if-none-match": etag });
    expect(res.status).toBe(304);
    await Bun.sleep(10);
    expect(tracked).toContain("/about");
  });

  it("renders request path/url from publicUrl and ignores the query", async () => {
    const html = await (await get("/?x=1")).text();
    expect(html).toContain("home /");
    expect(html).toContain("https://example.com/");
    expect(html).not.toContain("x=1");
    expect(html).toContain("/assets/main-abc123.js");
  });

  it("caches dynamic routes per URL: first hit MISS, then HIT", async () => {
    const first = await get("/blog/hello");
    expect(first.headers.get("x-njin-cache")).toBe("MISS");
    const html = await first.text();
    expect(html).toMatch(/post hello #\d+/);

    const second = await get("/blog/hello");
    expect(second.headers.get("x-njin-cache")).toBe("HIT");
    expect(await second.text()).toBe(html);

    // trailing slash is the same URL; another slug is its own entry
    expect(await cacheState("/blog/hello/")).toBe("HIT");
    const other = await get("/blog/other");
    expect(other.headers.get("x-njin-cache")).toBe("MISS");
    expect(await other.text()).not.toBe(html);
  });

  it("keeps odd slugs inside the cache dir and case-distinct", async () => {
    const a = await (await get("/blog/Case")).text();
    const b = await (await get("/blog/case")).text();
    expect(a).toContain("post Case");
    expect(b).toContain("post case");

    const encoded = await get("/blog/hello%20world");
    expect(await encoded.text()).toContain("post hello world");
    expect(existsSync(cacheFile("blog", "hello%20world"))).toBe(true);

    // encoded slashes / malformed encodings are rendered live, never cached (the URL parser
    // already resolves %2e%2e itself)
    for (const bad of ["/blog/a%2Fb", "/blog/%E0%A4%A"]) {
      expect(await cacheState(bad)).toBe("BYPASS");
    }
    expect(existsSync(join(dir, ".cache", "index.html"))).toBe(false);
  });

  it("purgeStatic(path) drops one URL and re-warms plain routes", async () => {
    const before = await (await get("/blog/hello")).text();
    await purgeStatic("/blog/hello");
    const res = await get("/blog/hello");
    expect(res.headers.get("x-njin-cache")).toBe("MISS");
    expect(await res.text()).not.toBe(before);
    expect(await cacheState("/blog/other")).toBe("HIT");

    await purgeStatic("/about");
    await settle();
    expect(readFileSync(cacheFile("about"), "utf8")).toBe("<h1>about v2</h1>");
  });

  it("purgeStatic('/blog/*') drops a subtree, purgeStatic() everything", async () => {
    await purgeStatic("/blog/*");
    expect(await cacheState("/blog/other")).toBe("MISS");
    expect(await cacheState("/blog/hello")).toBe("MISS");
    expect(await cacheState("/about")).toBe("HIT");

    writeFileSync(join(views, "pages", "about.edge"), "<h1>about v3</h1>");
    await purgeStatic("/about", { warm: false });
    await settle();
    expect(existsSync(cacheFile("about"))).toBe(false);

    await purgeStatic(undefined, { warm: false });
    expect(existsSync(join(dir, ".cache", "static"))).toBe(false);
    await warmStatic();
    expect(readFileSync(cacheFile("about"), "utf8")).toBe("<h1>about v3</h1>");
  });

  it("keeps the warm-up of one route when another is purged right after", async () => {
    await purgeStatic("/about");
    await purgeStatic("/");
    await settle();
    expect(existsSync(cacheFile("about"))).toBe(true);
    expect(existsSync(cacheFile())).toBe(true);
  });

  it("rejects an invalid purge path", async () => {
    await expect(purgeStatic("/a/../b")).rejects.toThrow(/Invalid purge path/);
    await expect(purgeStatic("nope")).rejects.toThrow(/Invalid purge path/);
  });

  it("never caches errors", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await get("/gone");
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("<h1>Custom 404</h1>");
      expect(res.headers.get("x-njin-cache")).toBeNull();
    }
    const missing = await get("/blog/missing");
    expect(missing.status).toBe(404);
    expect(existsSync(cacheFile("blog", "missing"))).toBe(false);
  });

  it("revalidates in the background: stale first, fresh afterwards", async () => {
    // The boot warm-up may already be older than 0.3s by now — start from a fresh page.
    await purgeStatic("/ticker", { warm: false });
    const first = await (await get("/ticker")).text();
    expect(await cacheState("/ticker")).toBe("HIT");

    await Bun.sleep(400);
    const stale = await get("/ticker");
    expect(stale.headers.get("x-njin-cache")).toBe("STALE");
    expect(await stale.text()).toBe(first);

    await settle();
    expect(await (await get("/ticker")).text()).not.toBe(first);
  });

  it("shares one render between concurrent first hits", async () => {
    await purgeStatic("/blog/*");
    const before = renders;
    const [a, b] = await Promise.all([get("/blog/same"), get("/blog/same")]);
    expect(await a.text()).toBe(await b.text());
    expect(renders - before).toBe(1);
  });
});

describe("getOrRenderStatic", () => {
  it("does not cache a render that was purged while in flight", async () => {
    let started!: () => void;
    const renderStarted = new Promise<void>((r) => (started = r));
    const pending = getOrRenderStatic("/d", async () => {
      started();
      await Bun.sleep(20);
      return "stale";
    });
    await renderStarted;
    await purgeStatic("/d");
    expect((await pending).html).toBe("stale");
    expect(await readStatic("/d")).toBeNull();
  });

  it("keeps the stale page when a background revalidation fails", async () => {
    await getOrRenderStatic("/keep", async () => "old", 0.01);
    await Bun.sleep(30);
    const res = await getOrRenderStatic(
      "/keep",
      async () => {
        throw new Error("db down");
      },
      0.01,
    );
    expect(res).toEqual({ html: "old", state: "STALE" });
    await Bun.sleep(10);
    expect((await getOrRenderStatic("/keep", async () => "x")).html).toBe(
      "old",
    );
  });
});
