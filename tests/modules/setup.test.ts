import { describe, expect, it, mock } from "bun:test";
import { RecordId, Table } from "surrealdb";
import realUserModel from "../../src/models/user";
import * as realElysiaModule from "../../src/modules/elysia";
import * as realSurrealModule from "../../src/modules/surreal";
import { makeFakeElysia } from "../helpers/fake_elysia";

// setup.ts's create-first-admin route needs the real user model's `.create`/`.prefix` —
// re-asserted explicitly (rather than relying on nothing else having mocked this
// specifier yet) since, without --isolate, mock.module() replaces the module in a
// registry shared across the whole test run, and other files (surreal.test.ts,
// users.test.ts) mock this same specifier.
mock.module("../../src/models/user", () => ({ default: realUserModel }));

let userCount = 0;
const relateCalls: unknown[][] = [];
const createdTokens: Record<string, unknown>[] = [];

const fakeDb = {
  query: async (_sql: string, _params?: Record<string, unknown>) => {
    return [[{ count: userCount }]];
  },
  create: (table: Table) => ({
    content: (data: Record<string, unknown>) => {
      const id = new RecordId(table.name, `tok${createdTokens.length + 1}`);
      const record = { ...data, id };
      createdTokens.push(record);
      return {
        // token creation (setup.ts) awaits .content(...) directly; user.create()
        // (via core/model/index.ts) chains .output("after").then(...) on top of it.
        then: (resolve: (value: [Record<string, unknown>]) => unknown) => resolve([record]),
        output: (_mode: string) => Promise.resolve([record]),
      };
    },
  }),
  relate: async (...args: unknown[]) => {
    relateCalls.push(args);
  },
};

// Spreading real exports below — without --isolate, mock.module() replaces the module
// in a registry shared across the whole test run, so a partial mock would otherwise
// break other files that import isRemotePath/injectBracketQuery from these specifiers.
mock.module("../../src/modules/surreal", () => ({ ...realSurrealModule, default: () => fakeDb }));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({ ...realElysiaModule, default: fakeElysia.fn }));

const { default: setup } = await import("../../src/modules/setup");

await setup.init();
const app = fakeElysia.buildApp();

describe("GET /api/setup/status", () => {
  it("reports needsSetup: true when there are no users", async () => {
    userCount = 0;
    const res = await app.handle(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needsSetup: true });
  });

  it("reports needsSetup: false when a user already exists", async () => {
    userCount = 1;
    const res = await app.handle(new Request("http://localhost/api/setup/status"));
    expect(await res.json()).toEqual({ needsSetup: false });
  });
});

describe("POST /api/setup", () => {
  it("refuses to create an admin once setup is already completed", async () => {
    userCount = 1;
    const res = await app.handle(
      new Request("http://localhost/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "password123" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("creates the first admin user, hashing the password and issuing a token", async () => {
    userCount = 0;
    relateCalls.length = 0;
    createdTokens.length = 0;

    const res = await app.handle(
      new Request("http://localhost/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Admin", email: "admin@example.com", password: "password123" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { token: string; user: Record<string, unknown> } };
    expect(body.data.token).toMatch(/^token:tok\d+:.+$/);
    expect(body.data.user.password).toBeUndefined();
    expect(body.data.user.email).toBe("admin@example.com");
    expect(relateCalls).toHaveLength(1);
  });
});
