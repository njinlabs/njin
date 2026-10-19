import { describe, expect, it, mock } from "bun:test";
import * as realConfig from "../../src/core/config";
import type { DbAdapter, TableDef } from "../../src/core/db/contract";
import { internalTables } from "../../src/core/db/internal";
import realUserModel from "../../src/models/user";

// The db module only wires an adapter into the app: connect it during init(), sync every
// table during spin(), close it on shutdown. The adapter itself is covered by its own tests.
const calls: string[] = [];
let synced: readonly TableDef[] = [];
let closed = false;

const fakeAdapter = {
  name: "fake",
  capabilities: { search: "none" },
  connect: async () => {
    calls.push("connect");
  },
  sync: async (tables: readonly TableDef[]) => {
    calls.push("sync");
    synced = tables;
  },
  close: async () => {
    closed = true;
  },
} as unknown as DbAdapter;

// A stand-in for models/user: the real one pulls in the full model layer, and only its
// `def` matters to the db module.
mock.module("../../src/models/user", () => ({
  default: { ...realUserModel, def: { ...realUserModel.def, name: "user" } },
}));
mock.module("../../src/models/file", () => ({
  default: { def: { name: "file", fields: [], search: [] } },
}));

let extraVars: (() => Promise<{ default: object }>)[] = [];
let extraModels: (() => Promise<{
  default: {
    def: TableDef;
    publishedDef?: TableDef;
    i18nDef?: TableDef;
    backfillPublished?: () => Promise<number>;
  };
}>)[] = [];

// Spreads the real module's other exports (loadConfig, defineConfig, ...) — without
// --isolate, mock.module() replaces the module in a registry shared across the whole
// test run, so a partial mock would otherwise break other files that import loadConfig
// from this same specifier.
mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({
    adapters: { db: fakeAdapter },
    models: extraModels,
    vars: extraVars,
  }),
}));

const { default: db } = await import("../../src/modules/db");

describe("db module", () => {
  it("connects the configured adapter during init() and exposes it", async () => {
    calls.length = 0;

    const result = await db.init();

    expect(calls).toEqual(["connect"]);
    expect(db()).toBe(fakeAdapter);
    expect(typeof result.spin).toBe("function");
  });

  it("syncs njin's own tables, the built-in models and the project's models on spin()", async () => {
    extraModels = [
      async () => ({
        default: { def: { name: "post", fields: [], search: [] } },
      }),
    ];
    const result = await db.init();
    calls.length = 0;

    await result.spin!();

    expect(calls).toEqual(["sync"]);
    const names = synced.map((t) => t.name);
    for (const table of internalTables) expect(names).toContain(table.name);
    for (const name of ["user", "file", "post"]) expect(names).toContain(name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("syncs a draftable model's published table and backfills it after the sync", async () => {
    const order: string[] = [];
    extraModels = [
      async () => ({
        default: {
          def: { name: "article", fields: [], search: [] },
          publishedDef: { name: "_published_article", fields: [], search: [] },
          backfillPublished: async () => {
            order.push(`backfill:${calls.join(",")}`);
            return 0;
          },
        },
      }),
    ];
    const result = await db.init();
    calls.length = 0;

    await result.spin!();

    const names = synced.map((t) => t.name);
    expect(names).toContain("article");
    expect(names).toContain("_published_article");
    // Backfill needs the tables to exist, so it runs only once sync() has finished.
    expect(order).toEqual(["backfill:sync"]);
  });

  it("syncs an i18n model's translation table", async () => {
    extraModels = [
      async () => ({
        default: {
          def: { name: "page", fields: [], search: [] },
          i18nDef: { name: "page__i18n", fields: [], search: [] },
        },
      }),
    ];
    const result = await db.init();

    await result.spin!();

    const names = synced.map((t) => t.name);
    expect(names).toContain("page");
    expect(names).toContain("page__i18n");
  });

  it("backfills a draftable settings group after the sync, and leaves the others alone", async () => {
    const seen: string[] = [];
    extraVars = [
      async () => ({
        default: {
          prefix: "site",
          publish: async () => {},
          published: {},
          discard: async () => {},
          backfillPublished: async () => {
            seen.push(`backfill:${calls.join(",")}`);
            return 0;
          },
        },
      }),
      async () => ({ default: { prefix: "plain" } }),
    ];
    const result = await db.init();
    calls.length = 0;

    await result.spin!();

    // the tables must exist first
    expect(seen).toEqual(["backfill:sync"]);
    extraVars = [];
  });

  it("lets a model override an internal table of the same name instead of defining it twice", async () => {
    extraModels = [
      async () => ({
        default: {
          def: { name: "token", fields: [], search: [], document: true },
        },
      }),
    ];
    const result = await db.init();

    await result.spin!();

    const tokens = synced.filter((t) => t.name === "token");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.document).toBe(true);
  });

  it("closes the adapter and exits the process on SIGINT/SIGTERM without touching the real listeners", async () => {
    extraModels = [];
    closed = false;

    const capturedHandlers: (() => Promise<void>)[] = [];
    const onceSpy = mock((_event: string, handler: () => Promise<void>) => {
      capturedHandlers.push(handler);
      return process;
    });
    const originalOnce = process.once;
    process.once = onceSpy;
    const exitSpy = mock(() => undefined as never);
    const originalExit = process.exit;
    process.exit = exitSpy;

    try {
      const result = await db.init();
      await result.spin!();

      expect(capturedHandlers).toHaveLength(2); // SIGINT + SIGTERM

      await capturedHandlers[0]!();

      expect(closed).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      process.once = originalOnce;
      process.exit = originalExit;
    }
  });
});
