import { describe, expect, it } from "bun:test";
import { oauthConsentTable, rateLimitTable } from "../../src/core/db/internal";
import { useTestDb } from "../helpers/test_db";

const db = await useTestDb();

const {
  default: accessGroup,
  FULL_ACCESS_GRANTS,
  FULL_ACCESS_NAME,
} = await import("../../src/models/access_group");
const { default: user } = await import("../../src/models/user");

await db.sync([accessGroup.def, user.def]);

const account = (suffix: string, groups?: string[]) => ({
  name: `User ${suffix}`,
  email: `${suffix}@example.com`,
  password: "secret-pass",
  ...(groups ? { groups } : {}),
});

describe("access group model", () => {
  it("keeps a name, an optional description and a list of grants", async () => {
    const created = await accessGroup.create({
      name: "Editors",
      grants: ["blog:*:own", "category:read"],
    });

    const found = await accessGroup.show(created.id);
    expect(found.name).toBe("Editors");
    expect(found.grants).toEqual(["blog:*:own", "category:read"]);
    expect(found.description ?? null).toBeNull();
  });

  it("allows a group with no grants", async () => {
    const created = await accessGroup.create({ name: "Nothing", grants: [] });
    expect((await accessGroup.show(created.id)).grants).toEqual([]);
  });

  it("keeps names unique", async () => {
    await accessGroup.create({ name: "Unique", grants: [] });

    await expect(
      accessGroup.create({ name: "Unique", grants: [] }),
    ).rejects.toThrow();
  });

  it("requires a name", () => {
    expect(accessGroup.validation.safeParse({ grants: [] }).success).toBe(
      false,
    );
  });

  it("records who created it", async () => {
    // a real user: adapters that enforce foreign keys refuse an owner that does not exist
    const owner = await user.create(account("owner"));

    const created = await accessGroup.create(
      { name: "Owned", grants: [] },
      { createdBy: owner.id },
    );
    expect((await accessGroup.show(created.id)).createdBy).toBe(owner.id);
  });

  it("describes the built-in full access group", () => {
    expect(FULL_ACCESS_NAME).toBe("Full access");
    expect(FULL_ACCESS_GRANTS).toEqual(["*:*:all"]);
  });
});

describe("user groups", () => {
  it("links a user to any number of groups", async () => {
    const a = await accessGroup.create({ name: "Group A", grants: ["a:read"] });
    const b = await accessGroup.create({ name: "Group B", grants: ["b:read"] });

    const created = await user.create(account("many", [a.id, b.id]));

    const found = await user.show(created.id);
    const groups = (found.groups ?? []) as { id: string; grants: string[] }[];
    expect(groups.map((g) => g.id).sort()).toEqual([a.id, b.id].sort());
    expect(groups.flatMap((g) => g.grants).sort()).toEqual([
      "a:read",
      "b:read",
    ]);
  });

  it("gives a user without groups an empty list", async () => {
    const created = await user.create(account("none"));
    expect((await user.show(created.id)).groups ?? []).toEqual([]);
  });

  it("no longer expands a group that was deleted", async () => {
    const group = await accessGroup.create({ name: "Gone", grants: [] });
    const created = await user.create(account("gone", [group.id]));

    await accessGroup.destroy(group.id);

    // An adapter that enforces links drops the entry; one that does not (SurrealDB) leaves a
    // bare id behind. Either way there is no group record left to read grants from.
    const left = ((await user.show(created.id)).groups ?? []) as unknown[];
    expect(left.filter((entry) => typeof entry === "object")).toEqual([]);
  });
});

describe("internal tables for consent and rate limiting", () => {
  it("stores what a user agreed to hand an OAuth client", async () => {
    await db.sync([user.def]);
    const owner = await user.create(account("consent"));

    const row = await db.adapter.insert(oauthConsentTable, {
      user: owner.id,
      clientId: "client-1",
      clientName: "Claude",
      scopes: ["blog:read", "category:read"],
      grantedAt: "2026-11-01T00:00:00.000Z",
      lastUsedAt: "2026-11-01T00:00:00.000Z",
    });

    const found = await db.adapter.find(oauthConsentTable, row.id, {
      populate: [],
    });
    expect(found?.clientName).toBe("Claude");
    expect(found?.scopes).toEqual(["blog:read", "category:read"]);
  });

  it("keeps a counter under a chosen id", async () => {
    await db.adapter.insert(
      rateLimitTable,
      { count: 3, resetAt: "2026-11-01T00:15:00.000Z" },
      { id: "login:alice@example.com" },
    );

    const found = await db.adapter.find(
      rateLimitTable,
      "login:alice@example.com",
      { populate: [] },
    );
    expect(found?.count).toBe(3);
  });
});
