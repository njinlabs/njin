import { describe, expect, it, mock } from "bun:test";
import Elysia from "elysia";
import * as realConfig from "../../../src/core/runtime/config";
import { useTestDb } from "../../helpers/test_db";

const db = await useTestDb();

mock.module("../../../src/core/runtime/config", () => ({
  ...realConfig,
  getConfig: () => ({ publicUrl: "https://site.example" }),
}));

const { default: userModel } = await import("../../../src/models/user");
const { default: accessGroup, ensureFullAccessGroup } = await import(
  "../../../src/models/access_group"
);
const { issueToken } = await import("../../../src/modules/token");
const { authPlugin } = await import("../../../src/core/api/auth");

await db.sync([userModel.def, accessGroup.def]);

const user = await userModel.create({
  name: "Alice",
  email: "alice@example.com",
  password: Bun.password.hashSync("correct-password"),
  groups: [await ensureFullAccessGroup()],
});

// What a project's src/routes/*.ts file looks like: its own instance that uses the plugin.
const routes = new Elysia()
  .use(authPlugin)
  .get("/report", ({ principal }) => ({ kind: principal.kind }), {
    auth: { mcp: true },
  });

const get = (bearer?: string) =>
  routes.handle(
    new Request("http://localhost/report", {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    }),
  );

describe("authPlugin on a project route", () => {
  it("lets a personal token in", async () => {
    const { bearer } = await issueToken({
      user: user.id,
      kind: "pat",
      name: "Script",
      scopes: ["*"],
    });
    const res = await get(bearer);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "pat" });
  });

  it("rejects a request without a token", async () => {
    expect((await get()).status).toBe(401);
  });

  it("rejects a session on an mcp route", async () => {
    const { bearer } = await issueToken({ user: user.id, kind: "session" });

    expect((await get(bearer)).status).toBe(401);
  });
});
