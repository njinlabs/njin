import { afterAll, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs with default test-env NODE_ENV (not "production"), so view.ts's top-level
// `isDev` constant is true for every test in this file — the production-only branches
// (buildViteGlobal's manifest handling) live in tests/modules/view_prod.test.ts instead,
// in a separate file so --isolate gives it its own fresh module evaluation with
// NODE_ENV="production" set before view.ts is first imported.
mock.module("vite", () => ({
  createServer: async () => ({
    listen: async () => {},
    printUrls: () => {},
    resolvedUrls: { local: ["http://localhost:5173/"] },
    close: async () => {},
  }),
}));

const { fileToRoute, renderErrorPage, renderHttpError, buildViteGlobal } = await import("../../src/modules/view");

describe("fileToRoute", () => {
  it("converts a plain file to a route", () => {
    expect(fileToRoute("about.edge")).toBe("/about");
  });

  it("maps index.edge to the root route", () => {
    expect(fileToRoute("index.edge")).toBe("/");
  });

  it("strips a trailing /index from a nested path", () => {
    expect(fileToRoute("blog/index.edge")).toBe("/blog");
  });

  it("converts a bracket param segment to an Elysia :param", () => {
    expect(fileToRoute("blog/[slug].edge")).toBe("/blog/:slug");
  });

  it("normalizes Windows-style backslashes", () => {
    expect(fileToRoute("blog\\[slug].edge")).toBe("/blog/:slug");
  });
});

describe("renderErrorPage", () => {
  it("includes the template and path, and HTML-escapes the error message/stack", () => {
    const error = new Error("<script>alert(1)</script>");
    const html = renderErrorPage(error, "pages/blog/[slug]", "/blog/hello");

    expect(html).toContain("pages/blog/[slug]");
    expect(html).toContain("/blog/hello");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("renderHttpError", () => {
  const dir = mkdtempSync(join(tmpdir(), "njin-view-"));
  const errorsDir = join(dir, "errors");
  mkdirSync(errorsDir);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders the matching errors/<code>.edge template when it exists", async () => {
    writeFileSync(join(errorsDir, "404.edge"), "not used directly — edge.render is mocked below");
    const fakeEdge = { render: async () => "<h1>404 rendered</h1>" };

    const html = await renderHttpError(fakeEdge as never, dir, new (await import("../../src/core/http_error")).HttpError(404));

    expect(html).toBe("<h1>404 rendered</h1>");
  });

  it("falls back to the generic error page when edge.render throws", async () => {
    writeFileSync(join(errorsDir, "500.edge"), "template exists but rendering fails");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const fakeEdge = {
      render: async () => {
        throw new Error("template syntax error");
      },
    };

    try {
      const { HttpError } = await import("../../src/core/http_error");
      const html = await renderHttpError(fakeEdge as never, dir, new HttpError(500));

      expect(html).toContain("500");
      expect(html).toContain("Internal Server Error");
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("falls back to the generic error page when no template file exists at all", async () => {
    const fakeEdge = { render: async () => "should never be called" };
    const { HttpError } = await import("../../src/core/http_error");

    const html = await renderHttpError(fakeEdge as never, dir, new HttpError(403, "No access"));

    expect(html).toContain("403");
    expect(html).toContain("No access");
  });
});

describe("buildViteGlobal — dev mode", () => {
  it("returns a Vite client script tag for a non-css asset, and a stylesheet tag for a css entry", async () => {
    const vite = await buildViteGlobal();

    const script = vite.asset("src/main.ts");
    expect(script).toContain('src="http://localhost:5173/@vite/client"');
    expect(script).toContain('src="http://localhost:5173/src/main.ts"');

    const style = vite.asset("src/main.css");
    expect(style).toBe('<link rel="stylesheet" href="http://localhost:5173/src/main.css">');
  });

  it("resolves a static asset path against the dev server URL", async () => {
    const vite = await buildViteGlobal();
    expect(vite.static("/logo.png")).toBe("http://localhost:5173/logo.png");
  });
});
