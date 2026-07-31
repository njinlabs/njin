import { describe, expect, it, mock } from "bun:test";
import { RecordId } from "surrealdb";
import z from "zod";
import realUserModel from "../../src/models/user";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeAuthPlugin } from "../helpers/fake_auth";
import { makeFakeElysia } from "../helpers/fake_elysia";

const userValidation = z.object({ name: z.string(), email: z.email(), password: z.string() });

const records = new Map<string, Record<string, unknown>>();
const alice = { id: new RecordId("user", "u1"), name: "Alice", email: "alice@example.com", password: "hashed" };
records.set(String(alice.id), alice);

const fakeDb = {
  read: async () => ({ data: Array.from(records.values()), meta: { total: records.size, page: 1, limit: 20, pageCount: 1 } }),
  select: async (id: RecordId) => records.get(String(id)) ?? null,
  create: async (data: Record<string, unknown>) => {
    const id = new RecordId("user", `u${records.size + 1}`);
    const record = { ...data, id };
    records.set(String(id), record);
    return record;
  },
  update: async (id: RecordId, data: Record<string, unknown>) => {
    const existing = records.get(String(id)) ?? {};
    const record = { ...existing, ...data, id };
    records.set(String(id), record);
    return record;
  },
  destroy: async (id: RecordId) => {
    const record = records.get(String(id)) ?? { id };
    records.delete(String(id));
    return record;
  },
};

// Mock ../models/user's default export directly — users.ts's routes call `user.read/show/
// create/update/destroy` from the model, not surreal() itself, so faking the model surface
// is more direct than reimplementing makeModel()'s SurrealQL generation.
//
// Spreads the real model first (table/prefix/name) — without --isolate, mock.module()
// replaces the module in a registry shared across the whole test run, so a from-scratch
// replacement here would otherwise break other files (auth.test.ts, setup.test.ts) that
// import the real user model for its `.table`.
mock.module("../../src/models/user", () => ({
  default: {
    ...realUserModel,
    validation: userValidation,
    read: fakeDb.read,
    show: (id: string) => fakeDb.select(new RecordId("user", id)),
    create: fakeDb.create,
    update: (id: string, data: Record<string, unknown>) => fakeDb.update(new RecordId("user", id), data),
    destroy: (id: string) => fakeDb.destroy(new RecordId("user", id)),
  },
}));

const fakeAuthPlugin = makeFakeAuthPlugin();
mock.module("../../src/modules/auth", () => ({ default: async () => ({ plugin: fakeAuthPlugin }) }));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({ ...realElysiaModule, default: fakeElysia.fn }));

const { default: users } = await import("../../src/modules/users");

await users.init();
const app = fakeElysia.buildApp();

describe("GET /api/user", () => {
  it("lists users without exposing passwords", async () => {
    const res = await app.handle(new Request("http://localhost/api/user", { headers: { Authorization: "Bearer x" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.password).toBeUndefined();
  });
});

describe("GET /api/user/:id", () => {
  it("shows a single user without the password", async () => {
    const res = await app.handle(new Request("http://localhost/api/user/u1", { headers: { Authorization: "Bearer x" } }));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.email).toBe("alice@example.com");
    expect(body.data.password).toBeUndefined();
  });

  it("returns null data for a user that doesn't exist", async () => {
    const res = await app.handle(new Request("http://localhost/api/user/nope", { headers: { Authorization: "Bearer x" } }));
    const body = (await res.json()) as { data: unknown };
    expect(body.data).toBeNull();
  });
});

describe("POST /api/user", () => {
  it("creates a user and strips the password from the response", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/user", {
        method: "POST",
        headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bob", email: "bob@example.com", password: "secret" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.email).toBe("bob@example.com");
    expect(body.data.password).toBeUndefined();
  });
});

describe("PUT /api/user/:id", () => {
  it("updates a user and strips the password from the response", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/user/u1", {
        method: "PUT",
        headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Alice Updated" }),
      }),
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.name).toBe("Alice Updated");
    expect(body.data.password).toBeUndefined();
  });
});

describe("DELETE /api/user/:id", () => {
  it("refuses to let a user delete their own account", async () => {
    // The fake auth plugin resolves `user.id.id` to "fixeduser1" — see tests/helpers/fake_auth.ts.
    const res = await app.handle(
      new Request("http://localhost/api/user/fixeduser1", { method: "DELETE", headers: { Authorization: "Bearer x" } }),
    );
    expect(res.status).toBe(400);
  });

  it("deletes a different user's account", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/user/u2", { method: "DELETE", headers: { Authorization: "Bearer x" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.password).toBeUndefined();
  });
});
