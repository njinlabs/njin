import { describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realConfig from "../../src/core/config";
import * as realAnalyticsModule from "../../src/modules/analytics";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeElysia } from "../helpers/fake_elysia";

// Dev-mode (NODE_ENV !== "production") behaviour of SSR responses: security headers,
// caching, escaping of abort() messages and the dev error page. Own file for its own module
// registry — view.ts reads rootDir from getConfig() at init time.
mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({
    models: [],
    vars: [],
    helpers: [],
    rootDir: process.cwd(),
  }),
}));

mock.module("vite", () => ({
  createServer: async () => ({
    listen: async () => {},
    printUrls: () => {},
    resolvedUrls: { local: ["http://localhost:5173/"] },
    close: async () => {},
  }),
}));

mock.module("../../src/modules/analytics", () => ({
  ...realAnalyticsModule,
  default: () => ({ track: async () => {} }),
  resolveClientIp: () => null,
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const {
  default: view,
  htmlResponse,
  renderErrorPage,
  renderHttpError,
} = await import("../../src/modules/view");
const { HttpError } = await import("../../src/core/http_error");

describe("htmlResponse()", () => {
  const req = (headers: Record<string, string> = {}, url = "http://x/") =>
    new Request(url, { headers });

  it("sets security headers and revalidating cache headers on a 200", async () => {
    const res = htmlResponse(req(), "<p>hi</p>");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self'",
    );
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("etag")).toMatch(/^W\/".+"$/);
    expect(await res.text()).toBe("<p>hi</p>");
  });

  it("gives the same body the same ETag and different bodies different ones", () => {
    const a = htmlResponse(req(), "a").headers.get("etag");
    expect(htmlResponse(req(), "a").headers.get("etag")).toBe(a);
    expect(htmlResponse(req(), "b").headers.get("etag")).not.toBe(a);
  });

  it("answers 304 with no body when If-None-Match matches", async () => {
    const etag = htmlResponse(req(), "a").headers.get("etag") as string;

    for (const header of [etag, `"other", ${etag}`, "*"]) {
      const res = htmlResponse(req({ "if-none-match": header }), "a");
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("etag")).toBe(etag);
    }
  });

  it("returns the full page when If-None-Match is stale", () => {
    const res = htmlResponse(req({ "if-none-match": 'W/"stale"' }), "a");
    expect(res.status).toBe(200);
  });

  it("never caches or ETags error pages", () => {
    const res = htmlResponse(req(), "<p>nope</p>", 404);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
  });

  it("does not send HSTS in dev, even over https", () => {
    const res = htmlResponse(
      req({ "x-forwarded-proto": "https" }, "https://x/"),
      "a",
    );
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("renderHttpError() escaping", () => {
  it("escapes the message and title in the built-in page", async () => {
    const html = await renderHttpError(
      { render: async () => "" } as never,
      mkdtempSync(join(tmpdir(), "njin-no-errors-")),
      new HttpError(404, '<img src=x onerror="alert(1)">'),
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});

describe("renderErrorPage() escaping", () => {
  it("escapes message, stack, template and path", () => {
    const err = new Error("<b>boom</b>");
    err.stack = "<i>stack</i>";
    const html = renderErrorPage(err, "pages/<t>", "/<p>");

    expect(html).not.toContain("<b>boom");
    expect(html).not.toContain("<i>stack");
    expect(html).not.toContain("pages/<t>");
    expect(html).not.toContain("/<p>");
    expect(html).toContain("&lt;b&gt;boom&lt;/b&gt;");
  });
});

describe("page routes (dev)", () => {
  it("serves pages with headers, escapes abort() messages, and returns the dev page on a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "njin-view-resp-"));
    const cwd = process.cwd();
    try {
      const pages = join(dir, "src", "views", "pages");
      mkdirSync(pages, { recursive: true });
      writeFileSync(join(pages, "ok.edge"), "<h1>ok</h1>");
      writeFileSync(join(pages, "gone.edge"), "{{ abort(404, query.q) }}");
      writeFileSync(join(pages, "boom.edge"), "{{ missing.deep.value }}");

      process.chdir(dir);
      await view.init();
      process.chdir(cwd);

      const app = fakeElysia.buildApp();

      const ok = await app.handle(new Request("http://localhost/ok"));
      expect(ok.status).toBe(200);
      expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
      expect(ok.headers.get("etag")).not.toBeNull();

      const cached = await app.handle(
        new Request("http://localhost/ok", {
          headers: { "if-none-match": ok.headers.get("etag") as string },
        }),
      );
      expect(cached.status).toBe(304);

      const gone = await app.handle(
        new Request(
          `http://localhost/gone?q=${encodeURIComponent("<script>alert(1)</script>")}`,
        ),
      );
      expect(gone.status).toBe(404);
      expect(gone.headers.get("cache-control")).toBe("no-store");
      const goneHtml = await gone.text();
      expect(goneHtml).not.toContain("<script>alert(1)");
      expect(goneHtml).toContain("&lt;script&gt;");

      const boom = await app.handle(new Request("http://localhost/boom"));
      expect(boom.status).toBe(500);
      expect(boom.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await boom.text()).toContain("DEV MODE");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
