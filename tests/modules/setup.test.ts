import { describe, expect, it, mock } from "bun:test";
import { tokenTable } from "../../src/core/db/internal";
import * as realConfig from "../../src/core/runtime/config";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeElysia } from "../helpers/fake_elysia";
import { useTestDb } from "../helpers/test_db";

const db = await useTestDb();

// publicBase() reads config to know whether the session cookie is Secure.
mock.module("../../src/core/runtime/config", () => ({
  ...realConfig,
  getConfig: () => ({ publicUrl: "https://site.example" }),
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const { default: userModel } = await import("../../src/models/user");
const {
  default: accessGroup,
  FULL_ACCESS_GRANTS,
  FULL_ACCESS_NAME,
} = await import("../../src/models/access_group");
const { default: setup } = await import("../../src/modules/setup");

await db.sync([userModel.def, accessGroup.def]);
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
    expect(body.data.token).toMatch(/^njt:[^:]+:[^:]+$/);
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
    expect(token?.kind).toBe("session");

    // and the browser is signed in as well, out of reach of scripts
    expect(res.headers.get("set-cookie")).toStartWith(
      `njin_session=${body.data.token};`,
    );
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("puts the first admin in a group that can do everything", async () => {
    const [stored] = (
      await db.adapter.list(userModel.def, {
        page: 1,
        limit: 10,
        populate: ["groups"],
      })
    ).rows;

    const groups = stored?.groups as { name: string; grants: string[] }[];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe(FULL_ACCESS_NAME);
    expect(groups[0]?.grants).toEqual(FULL_ACCESS_GRANTS);
  });

  it("does not make a second group when it is needed again", async () => {
    const { ensureFullAccessGroup } = await import(
      "../../src/models/access_group"
    );

    const first = await ensureFullAccessGroup();
    const second = await ensureFullAccessGroup();

    expect(second).toBe(first);
    expect(await db.adapter.count(accessGroup.def)).toBe(1);
  });

  it("reports needsSetup: false once a user exists", async () => {
    expect(await status()).toEqual({ needsSetup: false });
  });

  it("refuses to create another admin once setup is already completed", async () => {
    const res = await createAdmin();
    expect(res.status).toBe(403);
  });
});
