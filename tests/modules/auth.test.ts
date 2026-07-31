import { describe, expect, it, mock } from "bun:test";
import { RecordId, Table } from "surrealdb";
import realUserModel from "../../src/models/user";
import * as realElysiaModule from "../../src/modules/elysia";
import * as realSurrealModule from "../../src/modules/surreal";
import { makeFakeElysia } from "../helpers/fake_elysia";

// auth.ts's login route needs the real user model's `.table` — re-asserted explicitly
// (rather than relying on nothing else having mocked this specifier yet) since, without
// --isolate, mock.module() replaces the module in a registry shared across the whole
// test run, and other files (surreal.test.ts, users.test.ts) mock this same specifier.
mock.module("../../src/models/user", () => ({ default: realUserModel }));

const tokens = new Map<string, Record<string, unknown>>();
const users = new Map<string, Record<string, unknown>>();
const deleteCalls: unknown[] = [];
const relateCalls: unknown[][] = [];
// Login's `.select(user.table).where(eq("email", ...))` is stubbed to return whatever this
// holds — real Expr objects (from surrealdb's `eq()`) aren't easily inspected in a fake, so
// each test sets the "query result" it wants directly instead of simulating filtering.
let userQueryResult: Record<string, unknown>[] = [];

const fakeDb = {
  select: (target: RecordId | Table) => {
    if (target instanceof RecordId) {
      return {
        fetch: async (_field: string) => tokens.get(String(target)) ?? null,
      };
    }
    return {
      where: async (_cond: unknown) => userQueryResult,
    };
  },
  create: (table: Table) => ({
    content: async (data: Record<string, unknown>) => {
      const id = new RecordId(table.name, `tok${tokens.size + 1}`);
      const record = { ...data, id };
      tokens.set(String(id), record);
      return [record];
    },
  }),
  delete: async (id: unknown) => {
    deleteCalls.push(id);
    return {};
  },
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

const { default: auth } = await import("../../src/modules/auth");

const plainPassword = "correct-password";
const userRecordId = new RecordId("user", "u1");
users.set(String(userRecordId), {
  id: userRecordId,
  name: "Alice",
  email: "alice@example.com",
  password: Bun.password.hashSync(plainPassword),
});

const setValidToken = () => {
  const plainToken = "plain-token-value";
  const hash = new Bun.CryptoHasher("sha256").update(plainToken).digest("utf8");
  const tokenId = new RecordId("token", "tok-valid");
  tokens.set(String(tokenId), {
    id: tokenId,
    hash,
    createdAt: "",
    updatedAt: "",
    user: { ...(users.get(String(userRecordId)) as Record<string, unknown>) },
  });
  return `token:tok-valid:${plainToken}`;
};

await auth.init();
const controller = fakeElysia.buildApp();

describe("auth macro (via /check-token)", () => {
  it("returns 401 when no bearer token is supplied", async () => {
    const res = await controller.handle(new Request("http://localhost/api/auth/check-token"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token id does not exist", async () => {
    const res = await controller.handle(
      new Request("http://localhost/api/auth/check-token", { headers: { Authorization: "Bearer token:nope:whatever" } }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token hash does not match", async () => {
    setValidToken();
    const res = await controller.handle(
      new Request("http://localhost/api/auth/check-token", { headers: { Authorization: "Bearer token:tok-valid:wrong-plain" } }),
    );
    expect(res.status).toBe(401);
  });

  it("passes through and strips the password/tokenId for a valid bearer", async () => {
    const bearer = setValidToken();
    const res = await controller.handle(
      new Request("http://localhost/api/auth/check-token", { headers: { Authorization: `Bearer ${bearer}` } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.email).toBe("alice@example.com");
    expect(body.data.tokenId).toBeUndefined();
  });
});

describe("DELETE /logout", () => {
  it("deletes the token and returns the user", async () => {
    const bearer = setValidToken();
    const res = await controller.handle(
      new Request("http://localhost/api/auth/logout", { method: "DELETE", headers: { Authorization: `Bearer ${bearer}` } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.email).toBe("alice@example.com");
    expect(deleteCalls).toHaveLength(1);
  });
});

describe("POST /login", () => {
  it("returns 401 when the user does not exist", async () => {
    userQueryResult = [];
    const res = await controller.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com", password: "whatever" }),
      }),
    );

    expect(res.status).toBe(401);
  });

  it("returns 401 when the password is wrong", async () => {
    userQueryResult = [users.get(String(userRecordId)) as Record<string, unknown>];
    const res = await controller.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com", password: "wrong-password" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("logs in successfully and returns a token string without the password", async () => {
    userQueryResult = [users.get(String(userRecordId)) as Record<string, unknown>];
    relateCalls.length = 0;
    const res = await controller.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com", password: plainPassword }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.password).toBeUndefined();
    expect(body.data.token).toMatch(/^token:tok\d+:.+$/);
    expect(relateCalls).toHaveLength(1);
  });
});
