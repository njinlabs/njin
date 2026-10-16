import { describe, expect, it, mock } from "bun:test";
import { tokenTable } from "../../src/core/db/internal";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeElysia } from "../helpers/fake_elysia";
import { useTestDb } from "../helpers/test_db";

const db = await useTestDb();

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const { default: userModel } = await import("../../src/models/user");
const { default: setup } = await import("../../src/modules/setup");

await db.sync([userModel.def]);
await setup.init();
const app = fakeElysia.buildApp();

const createAdmin = () =>
  app.handle(
    new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Admin",
        email: "admin@example.com",
        password: "password123",
      }),
    }),
  );

const status = async () =>
  (await (
    await app.handle(new Request("http://localhost/api/setup/status"))
  ).json()) as { needsSetup: boolean };

// The two states are order-dependent (no users, then one), so they live in one describe block
// and run top to bottom.
describe("setup", () => {
  it("reports needsSetup: true when there are no users", async () => {
    expect(await status()).toEqual({ needsSetup: true });
  });

  it("creates the first admin user, hashing the password and issuing a token", async () => {
    const res = await createAdmin();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { token: string; user: Record<string, unknown> };
    };
    expect(body.data.token).toMatch(/^token:[^:]+:.+$/);
    expect(body.data.user.password).toBeUndefined();
    expect(body.data.user.email).toBe("admin@example.com");

    // The password is stored hashed, and the token points at the new user by plain id.
    const [stored] = (
      await db.adapter.list(userModel.def, {
        page: 1,
        limit: 10,
        populate: [],
      })
    ).rows;
    expect(stored?.password).not.toBe("password123");
    expect(
      Bun.password.verifySync("password123", stored?.password as string),
    ).toBe(true);

    const tokenId = body.data.token.split(":")[1] as string;
    const token = await db.adapter.find(tokenTable, tokenId);
    expect(token?.user).toBe(stored?.id as string);
  });

  it("reports needsSetup: false once a user exists", async () => {
    expect(await status()).toEqual({ needsSetup: false });
  });

  it("refuses to create another admin once setup is already completed", async () => {
    const res = await createAdmin();
    expect(res.status).toBe(403);
  });
});
