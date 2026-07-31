import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as realConfig from "../../src/core/config";
import * as realElysiaModule from "../../src/modules/elysia";
import * as realViewModule from "../../src/modules/view";

// A minimal valid 1x1 transparent PNG — Bun.Image is a native decoder, not something
// that can be mocked, so route tests that reach pipeline.resize()/webp() need real bytes.
const ONE_PX_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);

// Each mock below spreads the real module's other exports — without --isolate,
// mock.module() replaces the module in a registry shared across the whole test run, so
// a partial mock would otherwise break other files importing the un-mocked exports
// (e.g. tests/modules/view.test.ts imports fileToRoute/renderHttpError/... by name).
const fakeViewGlobals: Record<string, unknown> = {};
mock.module("../../src/modules/view", () => ({
  ...realViewModule,
  default: () => ({
    global: (name: string, value: unknown) => {
      fakeViewGlobals[name] = value;
    },
  }),
}));

mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ port: 4000, img: { hosts: ["cdn.example.com"] } }),
}));

const { makeFakeElysia } = await import("../helpers/fake_elysia");
const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({ ...realElysiaModule, default: fakeElysia.fn }));

const { default: img } = await import("../../src/modules/img");

await img.init();
const app = fakeElysia.buildApp();

afterEach(() => {
  // @ts-expect-error — restoring the global between tests
  if (globalThis.fetch?.mockRestore) (globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();
});

describe("GET /img", () => {
  it("registers the imgOptimize view global", () => {
    expect(typeof fakeViewGlobals.imgOptimize).toBe("function");
    const helper = fakeViewGlobals.imgOptimize as (url: string, opts?: { w?: number; h?: number; q?: number }) => string;
    expect(helper("/a.png", { w: 100, h: 50, q: 70 })).toBe("/img?url=%2Fa.png&w=100&h=50&q=70");
  });

  it("returns 400 when url is missing", async () => {
    const res = await app.handle(new Request("http://localhost/img"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid q parameter", async () => {
    const res = await app.handle(new Request("http://localhost/img?url=/a.png&q=abc"));
    expect(res.status).toBe(400);
  });

  it("returns 403 for a disallowed host", async () => {
    const res = await app.handle(new Request("http://localhost/img?url=https://evil.com/a.png"));
    expect(res.status).toBe(403);
  });

  it("returns 304 when If-None-Match matches the computed ETag", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(ONE_PX_PNG, { status: 200 }));
    const first = await app.handle(new Request("http://localhost/img?url=/a.png"));
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();

    // The ETag is derived purely from the query params, so the 304 branch short-circuits
    // before any fetch happens — no need to keep the fetch mock in place for this request.
    const res = await app.handle(new Request("http://localhost/img?url=/a.png", { headers: { "If-None-Match": etag } }));
    expect(res.status).toBe(304);
  });

  it("fetches a local path from the app's own port and resizes width-only", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(ONE_PX_PNG, { status: 200 }));

    const res = await app.handle(new Request("http://localhost/img?url=/a.png&w=10"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:4000/a.png");
  });

  it("resizes height-only, deriving width from the source aspect ratio", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(ONE_PX_PNG, { status: 200 }));
    const res = await app.handle(new Request("http://localhost/img?url=/a.png&h=10"));
    expect(res.status).toBe(200);
  });

  it("returns 404 when a local path fetch is not ok", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    const res = await app.handle(new Request("http://localhost/img?url=/missing.png"));
    expect(res.status).toBe(404);
  });

  it("fetches an allowed external host", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(ONE_PX_PNG, { status: 200 }));
    const res = await app.handle(new Request("http://localhost/img?url=https://cdn.example.com/a.png"));
    expect(res.status).toBe(200);
  });

  it("returns 502 when the external fetch throws (e.g. blocked redirect)", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("redirect blocked"));
    const res = await app.handle(new Request("http://localhost/img?url=https://cdn.example.com/a.png"));
    expect(res.status).toBe(502);
  });

  it("returns 502 when the external fetch is not ok", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    const res = await app.handle(new Request("http://localhost/img?url=https://cdn.example.com/a.png"));
    expect(res.status).toBe(502);
  });
});
