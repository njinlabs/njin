import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp } from "../../src/core/testing";

const app = await createTestApp({
  models: [
    () => import("../fixtures/perm_category"),
    () => import("../fixtures/perm_article"),
  ],
  vars: [() => import("../fixtures/perm_site")],
});

afterAll(() => app.close());

type Group = { id: string; name: string; grants: string[] };
type Failure = { message: string; errors?: string[] };

const read = async <T>(res: Response) => (await res.json()) as T;

const admin = await app.createUser({ name: "Admin" });

const createGroup = (body: object, as: { id: string } = admin) =>
  app.post("/api/access_group", { as, body });

describe("/api/access_group", () => {
  it("creates, shows, lists, renames and deletes a group", async () => {
    const created = await createGroup({
      name: "Writers",
      grants: ["article:*:own", "category:read:all"],
    });
    expect(created.status).toBe(200);
    const group = (await read<{ data: Group }>(created)).data;
    expect(group.grants).toEqual(["article:*:own", "category:read:all"]);

    const shown = await app.get(`/api/access_group/${group.id}`, { as: admin });
    expect((await read<{ data: Group }>(shown)).data.name).toBe("Writers");

    const listed = await read<{ data: Group[] }>(
      await app.get("/api/access_group", { as: admin }),
    );
    expect(listed.data.map((g) => g.id)).toContain(group.id);

    const renamed = await app.put(`/api/access_group/${group.id}`, {
      as: admin,
      body: { name: "Authors" },
    });
    expect((await read<{ data: Group }>(renamed)).data.name).toBe("Authors");

    expect(
      (await app.delete(`/api/access_group/${group.id}`, { as: admin })).status,
    ).toBe(200);
    expect(
      (await app.get(`/api/access_group/${group.id}`, { as: admin })).status,
    ).toBe(200);
  });

  it("refuses grants that do not name anything real, and says why", async () => {
    const res = await createGroup({
      name: "Broken",
      grants: [
        "article:read",
        "ghost:read",
        "category:publish",
        "vars.site:update",
        "vars.site:read:own",
        "nonsense",
      ],
    });

    expect(res.status).toBe(422);
    const { errors } = await read<Failure>(res);
    expect(errors).toHaveLength(5);
    expect(errors?.join("\n")).toContain('unknown resource "ghost"');
    expect(errors?.join("\n")).toContain("no owner");
  });

  it("accepts publish on a draftable model and wildcards", async () => {
    const res = await createGroup({
      name: "Publishers",
      grants: ["article:publish", "*:read:all", "vars.site:write"],
    });

    expect(res.status).toBe(200);
  });

  it("validates grants when a group is edited too", async () => {
    const group = (
      await read<{ data: Group }>(
        await createGroup({ name: "Editable", grants: ["article:read"] }),
      )
    ).data;

    const res = await app.put(`/api/access_group/${group.id}`, {
      as: admin,
      body: { grants: ["ghost:read"] },
    });
    expect(res.status).toBe(422);

    const unchanged = await read<{ data: Group }>(
      await app.get(`/api/access_group/${group.id}`, { as: admin }),
    );
    expect(unchanged.data.grants).toEqual(["article:read"]);
  });

  it("keeps names unique", async () => {
    await createGroup({ name: "Same name", grants: [] });

    expect((await createGroup({ name: "Same name", grants: [] })).status).toBe(
      409,
    );
  });

  it("is for whoever has the right, and a session", async () => {
    const outsider = await app.createUser({ groups: [] });
    const reader = await app.createUser({
      groups: [
        (
          await app.createGroup({
            name: "Group readers",
            grants: ["access_group:read:all"],
          })
        ).id,
      ],
    });

    expect((await app.get("/api/access_group")).status).toBe(401);
    expect((await app.get("/api/access_group", { as: outsider })).status).toBe(
      403,
    );
    expect((await app.get("/api/access_group", { as: reader })).status).toBe(
      200,
    );
    expect(
      (await createGroup({ name: "Nope", grants: [] }, reader)).status,
    ).toBe(403);

    const token = (
      await read<{ data: { token: string } }>(
        await app.post("/api/token", {
          as: admin,
          body: { name: "Script", scopes: ["*:*"] },
        }),
      )
    ).data.token;
    expect((await app.get("/api/access_group", { as: token })).status).toBe(
      401,
    );
  });
});

describe("GET /api/access/catalog", () => {
  type Entry = { resource: string; actions: string[]; scoped: boolean };

  it("lists what a grant can name in this project", async () => {
    const { data } = await read<{ data: Entry[] }>(
      await app.get("/api/access/catalog", { as: admin }),
    );
    const by = Object.fromEntries(data.map((entry) => [entry.resource, entry]));

    expect(by.article?.actions).toContain("publish");
    expect(by.category?.actions).not.toContain("publish");
    expect(by["vars.site"]?.actions).toEqual(["read", "write"]);
    for (const builtIn of ["file", "user", "access_group", "analytics"]) {
      expect(by[builtIn]).toBeDefined();
    }
  });

  it("is for those who can read groups", async () => {
    const outsider = await app.createUser({ groups: [] });

    expect((await app.get("/api/access/catalog")).status).toBe(401);
    expect(
      (await app.get("/api/access/catalog", { as: outsider })).status,
    ).toBe(403);
  });
});

describe("GET /api/auth/permissions", () => {
  type Permissions = {
    data: {
      resource: string;
      scoped: boolean;
      actions: Record<string, string>;
    }[];
  };

  const permissionsOf = async (as: { id: string } | string) =>
    Object.fromEntries(
      (
        await read<Permissions>(await app.get("/api/auth/permissions", { as }))
      ).data.map((entry) => [entry.resource, entry.actions]),
    );

  it("tells a user what they may do, scope included", async () => {
    const group = await app.createGroup({
      name: "Perm editors",
      grants: ["article:*:own", "vars.site:read"],
    });
    const user = await app.createUser({ groups: [group.id] });

    const permissions = await permissionsOf(user);

    expect(permissions.article).toEqual({
      read: "own",
      create: "own",
      update: "own",
      delete: "own",
      publish: "own",
    });
    // a reference to what an article links to
    expect(permissions.category).toEqual({ read: "ref" });
    expect(permissions["vars.site"]).toEqual({ read: "all" });
    expect(permissions.user).toBeUndefined();
  });

  it("is empty for a user who can do nothing", async () => {
    const user = await app.createUser({ groups: [] });

    expect(await permissionsOf(user)).toEqual({});
  });

  it("is everything for full access", async () => {
    const permissions = await permissionsOf(admin);

    expect(permissions.article?.publish).toBe("all");
    expect(permissions.access_group?.delete).toBe("all");
    expect(permissions["vars.site"]).toEqual({ read: "all", write: "all" });
  });

  it("answers for a token as the token, narrowed to its scopes", async () => {
    const token = (
      await read<{ data: { token: string } }>(
        await app.post("/api/token", {
          as: admin,
          body: { name: "Reader", scopes: ["article:read"] },
        }),
      )
    ).data.token;

    expect(await permissionsOf(token)).toEqual({
      article: { read: "all" },
      category: { read: "ref" },
    });
  });

  it("needs a credential", async () => {
    expect((await app.get("/api/auth/permissions")).status).toBe(401);
  });
});

describe("keeping someone with full access", () => {
  // A site of its own: the first admin and what depends on them.
  const siteAdmin = async () => {
    const group = await app.createGroup({
      name: `Everything ${Bun.randomUUIDv7()}`,
      grants: ["*:*:all"],
    });
    return {
      group,
      user: await app.createUser({ groups: [group.id] }),
    };
  };

  it("lets a group lose full access while another user still has it", async () => {
    // `admin` is in the built-in Full access group, so this group is not the only way.
    const { group } = await siteAdmin();

    const res = await app.put(`/api/access_group/${group.id}`, {
      as: admin,
      body: { grants: ["article:read"] },
    });
    expect(res.status).toBe(200);
  });

  it("refuses to take full access from the last group that gives it", async () => {
    const full = (
      await read<{ data: { id: string }[] }>(
        await app.get("/api/access_group", {
          as: admin,
          query: { search: "Full access" },
        }),
      )
    ).data.find((g) => (g as unknown as Group).name === "Full access");
    if (!full) throw new Error("no Full access group");

    // Everyone else who has it goes first, so only `admin` is left holding it.
    const others = await read<{ data: { id: string; groups: unknown[] }[] }>(
      await app.get("/api/user", { as: admin, query: { limit: 100 } }),
    );
    for (const member of others.data) {
      if (member.id === admin.id) continue;
      await app.put(`/api/user/${member.id}`, {
        as: admin,
        body: { groups: [] },
      });
    }
    for (const group of (
      await read<{ data: Group[] }>(
        await app.get("/api/access_group", {
          as: admin,
          query: { limit: 100 },
        }),
      )
    ).data) {
      if (group.id !== full.id && group.grants.includes("*:*:all")) {
        await app.delete(`/api/access_group/${group.id}`, { as: admin });
      }
    }

    const demote = await app.put(`/api/access_group/${full.id}`, {
      as: admin,
      body: { grants: ["article:read"] },
    });
    expect(demote.status).toBe(409);

    const remove = await app.delete(`/api/access_group/${full.id}`, {
      as: admin,
    });
    expect(remove.status).toBe(409);

    // The last person with it cannot step down or be removed either.
    const stepDown = await app.put(`/api/user/${admin.id}`, {
      as: admin,
      body: { groups: [] },
    });
    expect(stepDown.status).toBe(409);

    // Nor can anyone else with the right to delete users remove them.
    const manager = await app.createUser({
      groups: [
        (
          await app.createGroup({
            name: "User managers",
            grants: ["user:*:all"],
          })
        ).id,
      ],
    });
    const removeLast = await app.delete(`/api/user/${admin.id}`, {
      as: manager,
    });
    expect(removeLast.status).toBe(409);

    const stillAdmin = await app.get("/api/access_group", { as: admin });
    expect(stillAdmin.status).toBe(200);
  });

  it("lets a user with full access be deleted while another still has it", async () => {
    const { user } = await siteAdmin();
    const second = await siteAdmin();

    // `user` is not the last: `second` holds full access too.
    const res = await app.delete(`/api/user/${user.id}`, { as: second.user });
    expect(res.status).toBe(200);
  });
});
