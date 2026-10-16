import { describe, expect, it, mock } from "bun:test";
import { pageviewTable } from "../../src/core/db/internal";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeAuthPlugin } from "../helpers/fake_auth";
import { makeFakeElysia } from "../helpers/fake_elysia";
import { useTestDb } from "../helpers/test_db";

const db = await useTestDb();

const loggerErrorCalls: unknown[] = [];
mock.module("../../src/modules/logger", () => ({
  default: () => ({
    error: (...args: unknown[]) => loggerErrorCalls.push(args),
  }),
}));

mock.module("geoip-lite", () => ({
  default: {
    lookup: (ip: string) => (ip === "1.2.3.4" ? { country: "US" } : null),
  },
}));

const fakeAuthPlugin = makeFakeAuthPlugin();
mock.module("../../src/modules/auth", () => ({
  default: async () => ({ plugin: fakeAuthPlugin }),
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const {
  resolveClientIp,
  resolveRequestOrigin,
  default: analytics,
} = await import("../../src/modules/analytics");

await analytics.init();
const app = fakeElysia.buildApp();

describe("resolveClientIp", () => {
  it("prefers x-forwarded-for, taking the first entry", () => {
    const req = new Request("http://x", {
      headers: { "x-forwarded-for": "9.9.9.9, 1.1.1.1" },
    });
    expect(resolveClientIp(req, null)).toBe("9.9.9.9");
  });

  it("falls back to x-real-ip", () => {
    const req = new Request("http://x", {
      headers: { "x-real-ip": "8.8.8.8" },
    });
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

describe("resolveRequestOrigin", () => {
  it("uses x-forwarded-proto and x-forwarded-host when present", () => {
    const req = new Request("http://127.0.0.1:3000/blog", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "mysite.com",
      },
    });
    expect(resolveRequestOrigin(req)).toBe("https://mysite.com");
  });

  it("defaults to http when x-forwarded-proto is missing", () => {
    const req = new Request("http://127.0.0.1:3000/blog", {
      headers: { "x-forwarded-host": "mysite.com" },
    });
    expect(resolveRequestOrigin(req)).toBe("http://mysite.com");
  });

  it("falls back to request.url when there is no proxy", () => {
    const req = new Request("https://mysite.com/blog");
    expect(resolveRequestOrigin(req)).toBe("https://mysite.com");
  });
});

const allPageviews = async () =>
  (await db.adapter.list(pageviewTable, { page: 1, limit: 100, populate: [] }))
    .rows;

const clearPageviews = () =>
  db.adapter.removeWhere(pageviewTable, [
    { field: "path", op: "$startsWith", value: "" },
  ]);

describe("analytics().track", () => {
  it("records a pageview with country lookup and a visitor hash", async () => {
    await clearPageviews();
    await analytics().track({
      path: "/blog",
      referrer: "https://google.com",
      userAgent: "test-agent",
      ip: "1.2.3.4",
      requestUrl: "https://mysite.com/blog",
    });

    const rows = await allPageviews();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.country).toBe("US");
    expect(rows[0]!.path).toBe("/blog");
    expect(rows[0]!.referrer).toBe("https://google.com");
    expect(typeof rows[0]!.visitorHash).toBe("string");
    expect(typeof rows[0]!.createdAt).toBe("string");
  });

  it("nulls out a same-origin referrer", async () => {
    await clearPageviews();
    await analytics().track({
      path: "/blog",
      referrer: "https://mysite.com/home",
      userAgent: "test-agent",
      ip: "1.2.3.4",
      requestUrl: "https://mysite.com/blog",
    });
    expect((await allPageviews())[0]!.referrer).toBeNull();
  });

  it("swallows errors and logs them instead of throwing", async () => {
    db.failNext("insert");
    loggerErrorCalls.length = 0;
    await analytics().track({
      path: "/x",
      referrer: null,
      userAgent: null,
      ip: null,
      requestUrl: "https://mysite.com/x",
    });
    expect(loggerErrorCalls).toHaveLength(1);
  });
});

describe("analytics routes", () => {
  const get = async (path: string) => {
    const res = await app.handle(
      new Request(`http://localhost/api/analytics/${path}`, {
        headers: { Authorization: "Bearer x" },
      }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: unknown }).data;
  };

  const seed = async () => {
    await clearPageviews();
    const rows = [
      ["/blog", "US", "https://google.com", "a", "2024-01-01T10:00:00.000Z"],
      ["/blog", "US", "https://google.com", "a", "2024-01-01T11:00:00.000Z"],
      ["/blog", "ID", null, "b", "2024-01-02T10:00:00.000Z"],
      ["/about", "US", null, null, "2024-02-05T10:00:00.000Z"],
    ] as const;
    for (const [path, country, referrer, visitorHash, createdAt] of rows) {
      await db.adapter.insert(pageviewTable, {
        path,
        country,
        referrer,
        visitorHash,
        userAgent: "ua",
        createdAt,
      });
    }
  };

  it("summary aggregates total pageviews and unique visitors", async () => {
    await seed();
    expect(await get("summary")).toEqual({
      totalPageviews: 4,
      uniqueVisitors: 2,
    });
  });

  it("summary honours from, to and path", async () => {
    await seed();
    expect(
      await get(
        "summary?from=2024-01-01T00:00:00Z&to=2024-01-31T00:00:00Z&path=/blog",
      ),
    ).toEqual({ totalPageviews: 3, uniqueVisitors: 2 });
  });

  it("by-country returns grouped rows, most frequent first", async () => {
    await seed();
    expect(await get("by-country")).toEqual([
      { country: "US", count: 3 },
      { country: "ID", count: 1 },
    ]);
  });

  it("by-referrer returns grouped rows", async () => {
    await seed();
    const rows = (await get("by-referrer")) as {
      referrer: string | null;
      count: number;
    }[];
    // Two groups tie on count, so their relative order isn't defined.
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ referrer: null, count: 2 });
    expect(rows).toContainEqual({ referrer: "https://google.com", count: 2 });
  });

  it("by-page returns grouped rows", async () => {
    await seed();
    expect(await get("by-page")).toEqual([
      { path: "/blog", count: 3 },
      { path: "/about", count: 1 },
    ]);
  });

  it("timeseries buckets by day by default and by hour when requested", async () => {
    await seed();
    expect(await get("timeseries")).toEqual([
      { date: "2024-01-01", count: 2 },
      { date: "2024-01-02", count: 1 },
      { date: "2024-02-05", count: 1 },
    ]);
    expect(await get("timeseries?interval=hour")).toEqual([
      { date: "2024-01-01T10", count: 1 },
      { date: "2024-01-01T11", count: 1 },
      { date: "2024-01-02T10", count: 1 },
      { date: "2024-02-05T10", count: 1 },
    ]);
  });
});
