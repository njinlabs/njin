import { describe, expect, it, mock } from "bun:test";
import * as realElysiaModule from "../../src/modules/elysia";
import * as realSurrealModule from "../../src/modules/surreal";
import { makeFakeAuthPlugin } from "../helpers/fake_auth";
import { makeFakeElysia } from "../helpers/fake_elysia";

const queryCalls: { sql: string; params: Record<string, unknown> }[] = [];
const createCalls: Record<string, unknown>[] = [];
let queryResult: unknown[] = [[]];
let createShouldThrow = false;

const fakeDb = {
  query: async (sql: string, params: Record<string, unknown> = {}) => {
    queryCalls.push({ sql, params });
    return queryResult;
  },
  create: (_table: unknown) => ({
    content: async (data: Record<string, unknown>) => {
      if (createShouldThrow) throw new Error("db unavailable");
      createCalls.push(data);
      return [data];
    },
  }),
};

// Spreading real exports below — without --isolate, mock.module() replaces the module
// in a registry shared across the whole test run, so a partial mock would otherwise
// break other files that import isRemotePath/injectBracketQuery from these specifiers.
mock.module("../../src/modules/surreal", () => ({ ...realSurrealModule, default: () => fakeDb }));

const loggerErrorCalls: unknown[] = [];
mock.module("../../src/modules/logger", () => ({
  default: () => ({ error: (...args: unknown[]) => loggerErrorCalls.push(args) }),
}));

mock.module("geoip-lite", () => ({
  default: { lookup: (ip: string) => (ip === "1.2.3.4" ? { country: "US" } : null) },
}));

const fakeAuthPlugin = makeFakeAuthPlugin();
mock.module("../../src/modules/auth", () => ({ default: async () => ({ plugin: fakeAuthPlugin }) }));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({ ...realElysiaModule, default: fakeElysia.fn }));

const { resolveClientIp, default: analytics } = await import("../../src/modules/analytics");

const initResult = await analytics.init();
const app = fakeElysia.buildApp();

describe("resolveClientIp", () => {
  it("prefers x-forwarded-for, taking the first entry", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 1.1.1.1" } });
    expect(resolveClientIp(req, null)).toBe("9.9.9.9");
  });

  it("falls back to x-real-ip", () => {
    const req = new Request("http://x", { headers: { "x-real-ip": "8.8.8.8" } });
    expect(resolveClientIp(req, null)).toBe("8.8.8.8");
  });

  it("falls back to server.requestIP", () => {
    const req = new Request("http://x");
    const server = { requestIP: () => ({ address: "7.7.7.7" }) };
    expect(resolveClientIp(req, server)).toBe("7.7.7.7");
  });

  it("returns null when nothing is available", () => {
    const req = new Request("http://x");
    expect(resolveClientIp(req, null)).toBeNull();
    expect(resolveClientIp(req, { requestIP: () => null })).toBeNull();
  });
});

describe("analytics().track", () => {
  it("records a pageview with country lookup and a visitor hash", async () => {
    createCalls.length = 0;
    createShouldThrow = false;
    await analytics().track({
      path: "/blog",
      referrer: "https://google.com",
      userAgent: "test-agent",
      ip: "1.2.3.4",
      requestUrl: "https://mysite.com/blog",
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.country).toBe("US");
    expect(createCalls[0]!.path).toBe("/blog");
    expect(createCalls[0]!.referrer).toBe("https://google.com");
    expect(typeof createCalls[0]!.visitorHash).toBe("string");
  });

  it("nulls out a same-origin referrer", async () => {
    createCalls.length = 0;
    await analytics().track({
      path: "/blog",
      referrer: "https://mysite.com/home",
      userAgent: "test-agent",
      ip: "1.2.3.4",
      requestUrl: "https://mysite.com/blog",
    });
    expect(createCalls[0]!.referrer).toBeNull();
  });

  it("swallows errors and logs them instead of throwing", async () => {
    createShouldThrow = true;
    loggerErrorCalls.length = 0;
    await analytics().track({ path: "/x", referrer: null, userAgent: null, ip: null, requestUrl: "https://mysite.com/x" });
    expect(loggerErrorCalls).toHaveLength(1);
    createShouldThrow = false;
  });
});

describe("analytics routes", () => {
  it("GET /api/analytics/summary aggregates total and unique visitors", async () => {
    queryResult = [[{ visitorHash: "a" }, { visitorHash: "a" }, { visitorHash: null }]];
    queryCalls.length = 0;
    const res = await app.handle(
      new Request("http://localhost/api/analytics/summary?from=2024-01-01T00:00:00Z&to=2024-02-01T00:00:00Z&path=/x", {
        headers: { Authorization: "Bearer x" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { totalPageviews: 3, uniqueVisitors: 1 } });
    expect(queryCalls[0]!.sql).toContain("createdAt >= $from");
    expect(queryCalls[0]!.sql).toContain("createdAt <= $to");
    expect(queryCalls[0]!.sql).toContain("path = $path");
  });

  it("GET /api/analytics/summary with no filters omits the WHERE clause", async () => {
    queryResult = [[]];
    queryCalls.length = 0;
    const res = await app.handle(new Request("http://localhost/api/analytics/summary", { headers: { Authorization: "Bearer x" } }));
    expect(res.status).toBe(200);
    expect(queryCalls[0]!.sql).not.toContain("WHERE");
  });

  it("GET /api/analytics/by-country returns grouped rows", async () => {
    queryResult = [[{ country: "US", count: 5 }]];
    const res = await app.handle(new Request("http://localhost/api/analytics/by-country", { headers: { Authorization: "Bearer x" } }));
    expect(await res.json()).toEqual({ data: [{ country: "US", count: 5 }] });
  });

  it("GET /api/analytics/by-referrer returns grouped rows", async () => {
    queryResult = [[{ referrer: "https://google.com", count: 2 }]];
    const res = await app.handle(new Request("http://localhost/api/analytics/by-referrer", { headers: { Authorization: "Bearer x" } }));
    expect(await res.json()).toEqual({ data: [{ referrer: "https://google.com", count: 2 }] });
  });

  it("GET /api/analytics/by-page returns grouped rows", async () => {
    queryResult = [[{ path: "/blog", count: 9 }]];
    const res = await app.handle(new Request("http://localhost/api/analytics/by-page", { headers: { Authorization: "Bearer x" } }));
    expect(await res.json()).toEqual({ data: [{ path: "/blog", count: 9 }] });
  });

  it("GET /api/analytics/timeseries buckets by day by default and by hour when requested", async () => {
    queryResult = [[{ date: "2024-01-01", count: 3 }]];
    queryCalls.length = 0;

    const dayRes = await app.handle(new Request("http://localhost/api/analytics/timeseries", { headers: { Authorization: "Bearer x" } }));
    expect(await dayRes.json()).toEqual({ data: [{ date: "2024-01-01", count: 3 }] });
    expect(queryCalls[0]!.sql).toContain("string::slice(createdAt, 0, 10)");

    queryCalls.length = 0;
    await app.handle(new Request("http://localhost/api/analytics/timeseries?interval=hour", { headers: { Authorization: "Bearer x" } }));
    expect(queryCalls[0]!.sql).toContain("string::slice(createdAt, 0, 13)");
  });
});

describe("analytics().spin", () => {
  it("defines the pageview table", async () => {
    queryCalls.length = 0;
    await initResult.spin!();
    expect(queryCalls[0]!.sql).toContain("DEFINE TABLE IF NOT EXISTS pageview");
  });
});
