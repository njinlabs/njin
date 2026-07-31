import { describe, expect, it, mock } from "bun:test";
import * as realSurrealdb from "surrealdb";
import * as realConfig from "../../src/core/config";
import realUserModel from "../../src/models/user";

let createRemoteEnginesCalls = 0;
let createNodeEnginesCalls = 0;
const instances: FakeSurreal[] = [];

class FakeSurreal {
  connectArgs: unknown[] = [];
  useArgs: unknown[] = [];
  queries: string[] = [];
  closed = false;
  constructor(public opts: { engines: unknown }) {
    instances.push(this);
  }
  async connect(...args: unknown[]) {
    this.connectArgs = args;
  }
  async use(...args: unknown[]) {
    this.useArgs = args;
  }
  async query(sql: string) {
    this.queries.push(sql);
    return [];
  }
  async close() {
    this.closed = true;
  }
}

mock.module("surrealdb", () => ({
  ...realSurrealdb,
  Surreal: FakeSurreal,
  createRemoteEngines: () => {
    createRemoteEnginesCalls++;
    return { remote: true };
  },
}));

mock.module("@surrealdb/node", () => ({
  createNodeEngines: () => {
    createNodeEnginesCalls++;
    return { embedded: true };
  },
}));

// Spreads the real user model (table/name/validation/...) — without --isolate,
// mock.module() replaces the module in a registry shared across the whole test run, so
// a from-scratch replacement here would otherwise break other files (auth.test.ts,
// setup.test.ts, users.test.ts) that need the real model's `.table`.
//
// The file model isn't spread the same way: src/models/file.ts reads getConfig() at
// module-load time, so importing the *real* module here (before getConfig is mocked)
// would throw "Config not loaded yet". No other test file relies on an un-mocked
// "../../src/models/file" import, so a minimal stand-in is safe.
mock.module("../../src/models/user", () => ({ default: { ...realUserModel, prefix: "user" } }));
mock.module("../../src/models/file", () => ({ default: { prefix: "file" } }));

let dbConfig = { path: "ws://localhost:8000", namespace: "ns", database: "db", auth: undefined as unknown };
let extraModels: (() => Promise<{ default: { prefix: string } }>)[] = [];

// Spreads the real module's other exports (loadConfig, defineConfig, ...) — without
// --isolate, mock.module() replaces the module in a registry shared across the whole
// test run, so a partial mock would otherwise break other files that import loadConfig
// from this same specifier.
mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ db: dbConfig, models: extraModels }),
}));

const { isRemotePath } = await import("../../src/modules/surreal");
const { default: surreal } = await import("../../src/modules/surreal");

describe("isRemotePath", () => {
  it("recognizes remote schemes", () => {
    expect(isRemotePath("ws://localhost:8000")).toBe(true);
    expect(isRemotePath("wss://example.com")).toBe(true);
    expect(isRemotePath("http://example.com")).toBe(true);
    expect(isRemotePath("https://example.com")).toBe(true);
  });

  it("rejects embedded schemes", () => {
    expect(isRemotePath("rocksdb://data")).toBe(false);
    expect(isRemotePath("mem://")).toBe(false);
    expect(isRemotePath("surrealkv://data")).toBe(false);
  });
});

describe("surreal.init() — remote db.path", () => {
  it("connects with createRemoteEngines and defines tables for user/file/vars/models", async () => {
    dbConfig = { path: "ws://localhost:8000", namespace: "ns", database: "db", auth: { username: "root", password: "root" } };
    extraModels = [async () => ({ default: { prefix: "post" } })];

    const result = await surreal.init();

    expect(createRemoteEnginesCalls).toBe(1);
    const instance = instances[instances.length - 1]!;
    expect(instance.connectArgs).toEqual(["ws://localhost:8000", { authentication: dbConfig.auth }]);
    expect(instance.useArgs).toEqual([{ namespace: "ns", database: "db" }]);

    const definedTables = instance.queries.join("\n");
    expect(definedTables).toContain("DEFINE TABLE IF NOT EXISTS user SCHEMALESS;");
    expect(definedTables).toContain("DEFINE TABLE IF NOT EXISTS file SCHEMALESS;");
    expect(definedTables).toContain("DEFINE TABLE IF NOT EXISTS vars SCHEMALESS;");
    expect(definedTables).toContain("DEFINE TABLE IF NOT EXISTS post SCHEMALESS;");

    expect(surreal()).toBe(instance as unknown as ReturnType<typeof surreal>);
    expect(typeof result.spin).toBe("function");
  });
});

describe("surreal.init() — embedded db.path", () => {
  it("connects with createNodeEngines for a rocksdb:// path", async () => {
    dbConfig = { path: "rocksdb://data", namespace: "ns", database: "db", auth: undefined };
    extraModels = [];
    createNodeEnginesCalls = 0;

    await surreal.init();

    expect(createNodeEnginesCalls).toBe(1);
  });
});

describe("surreal.init() — unrecognized db.path scheme", () => {
  it("throws a descriptive error", async () => {
    dbConfig = { path: "postgres://data", namespace: "ns", database: "db", auth: undefined };

    await expect(surreal.init()).rejects.toThrow(/Unrecognized db\.path scheme/);
  });
});

describe("surreal.init() spin()", () => {
  it("closes the connection and exits the process on SIGINT/SIGTERM without touching the real listeners", async () => {
    dbConfig = { path: "ws://localhost:8000", namespace: "ns", database: "db", auth: undefined };
    extraModels = [];

    const capturedHandlers: (() => Promise<void>)[] = [];
    const onceSpy = mock((_event: string, handler: () => Promise<void>) => {
      capturedHandlers.push(handler);
      return process;
    });
    const originalOnce = process.once;
    // @ts-expect-error — intentionally stubbing for this test only
    process.once = onceSpy;
    const exitSpy = mock(() => undefined as never);
    const originalExit = process.exit;
    // @ts-expect-error — intentionally stubbing for this test only
    process.exit = exitSpy;

    try {
      const result = await surreal.init();
      result.spin!();

      expect(capturedHandlers).toHaveLength(2); // SIGINT + SIGTERM

      const instance = instances[instances.length - 1]!;
      await capturedHandlers[0]!();

      expect(instance.closed).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      process.once = originalOnce;
      process.exit = originalExit;
    }
  });
});
