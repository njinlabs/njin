import { afterAll, describe, expect, it } from "bun:test";
import { definePlugin } from "../../src/core/api/plugin";
import { createTestApp } from "../../src/core/api/testing";

// A plugin's `permissions` join the access catalog: groups can be granted them, and a user who
// has them sees them in what they may do.
const app = await createTestApp({
  plugins: [
    definePlugin({
      permissions: [{ resource: "report", actions: ["read", "export"] }],
      admin: [import.meta.resolve("./fixtures/perm_site.ts")],
    }),
  ],
});

afterAll(() => app.close());

type Entry = {
  resource: string;
  actions: string[] | Record<string, string>;
  scoped: boolean;
};

const admin = await app.createUser({ name: "Admin" });

// Group names are unique.
let made = 0;

const group = (grants: string[]) =>
  app.post("/api/access_group", {
    as: admin,
    body: { name: `Group ${++made}`, grants },
  });

describe("a plugin's permissions", () => {
  it("are in the catalog next to the built-in resources", async () => {
    const res = await app.get("/api/access/catalog", { as: admin });
    const { data } = (await res.json()) as { data: Entry[] };

    expect(data.find((e) => e.resource === "report")).toEqual({
      resource: "report",
      actions: ["read", "export"],
      scoped: false,
    });
    expect(data.some((e) => e.resource === "user")).toBe(true);
  });

  it("can be granted, and only with the actions the plugin defined", async () => {
    expect((await group(["report:export"])).status).toBe(200);
    expect((await group(["report:delete"])).status).toBe(422);
    // The plugin's resource has no owner to scope by.
    expect((await group(["report:read:own"])).status).toBe(422);
  });

  it("are all open to someone in the Full access group", async () => {
    const res = await app.get("/api/auth/permissions", { as: admin });
    const { data } = (await res.json()) as { data: Entry[] };

    expect(data.find((e) => e.resource === "report")).toEqual({
      resource: "report",
      scoped: false,
      actions: { read: "all", export: "all" },
    });
  });

  it("show up in /api/auth/permissions for someone who has them", async () => {
    const { data: granted } = (await (await group(["report:read"])).json()) as {
      data: { id: string };
    };
    const user = await app.createUser({ name: "Reader", groups: [granted.id] });

    const res = await app.get("/api/auth/permissions", { as: user });
    const { data } = (await res.json()) as { data: Entry[] };

    expect(data).toEqual([
      { resource: "report", scoped: false, actions: { read: "all" } },
    ]);
  });
});
