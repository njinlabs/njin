import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import z from "zod";
import * as realConfig from "../../src/core/config";

const loggerErrorCalls: unknown[] = [];
mock.module("../../src/modules/logger", () => ({
  default: () => ({ error: (...args: unknown[]) => loggerErrorCalls.push(args) }),
}));

const serveWorkerCalls: unknown[] = [];
mock.module("../../src/core/worker", () => ({
  serveWorker: (app: unknown) => serveWorkerCalls.push(app),
}));

// Spread the real module's other exports (loadConfig, defineConfig, ...) — without
// --isolate, mock.module() replaces the module in a registry shared across the whole
// test run, so a partial mock here would otherwise break other files that import
// loadConfig from this same specifier.
mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ port: 5555 }),
}));

const { UniqueConstraintError } = await import("../../src/core/model");
const { default: elysia } = await import("../../src/modules/elysia");

elysia.init();
const app = elysia()
  .get("/boom-validation", () => "unreachable", { query: z.object({ n: z.coerce.number() }) })
  .get("/boom-unique", () => {
    throw new UniqueConstraintError("email", "a@a.com");
  })
  .get("/boom-generic", () => {
    throw new Error("boom");
  });

afterEach(() => {
  loggerErrorCalls.length = 0;
  serveWorkerCalls.length = 0;
  delete process.env.NJIN_WORKER;
});

describe("elysia() error handling", () => {
  it("maps a validation error to 422 with stripped error details", async () => {
    const res = await app.handle(new Request("http://localhost/boom-validation"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { message: string; errors: unknown[] };
    expect(body.message).toBe("Validation error");
    expect(Array.isArray(body.errors)).toBe(true);
  });

  it("maps a UniqueConstraintError to 409 with the offending field", async () => {
    const res = await app.handle(new Request("http://localhost/boom-unique"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { field: string };
    expect(body.field).toBe("email");
  });

  it("maps any other error to 500 and logs it", async () => {
    const res = await app.handle(new Request("http://localhost/boom-generic"));
    expect(res.status).toBe(500);
    expect(loggerErrorCalls).toHaveLength(1);
  });
});

describe("elysia().spin", () => {
  it("listens on the configured port without binding a real socket", async () => {
    const result = await elysia.init();
    const listenSpy = spyOn(elysia(), "listen").mockImplementation(() => elysia());
    try {
      result.spin!();
      expect(listenSpy).toHaveBeenCalledWith(5555);
    } finally {
      listenSpy.mockRestore();
    }
  });

  it("routes to serveWorker() instead of listen() when NJIN_WORKER=1", async () => {
    process.env.NJIN_WORKER = "1";
    const result = await elysia.init();
    const listenSpy = spyOn(elysia(), "listen").mockImplementation(() => elysia());
    try {
      result.spin!();
      expect(listenSpy).not.toHaveBeenCalled();
      expect(serveWorkerCalls).toEqual([elysia()]);
    } finally {
      listenSpy.mockRestore();
    }
  });
});
