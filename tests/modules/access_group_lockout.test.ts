import { describe, expect, it } from "bun:test";
import { HttpError } from "../../src/core/http_error";
import { useTestDb } from "../helpers/test_db";

const db = await useTestDb();

const { default: userModel } = await import("../../src/models/user");
const { default: accessGroup } = await import("../../src/models/access_group");
const { assertFullAccessRemains } = await import(
  "../../src/modules/access_group"
);

await db.sync([userModel.def, accessGroup.def]);

let counter = 0;
const makeUser = async (...groups: string[]) => {
  counter += 1;
  return userModel.create({
    name: `User ${counter}`,
    email: `user${counter}@example.com`,
    password: "x",
    groups,
  });
};
const makeGroup = (grants: string[]) => {
  counter += 1;
  return accessGroup.create({ name: `Group ${counter}`, grants });
};

const refusal = async (fn: () => Promise<void>) => {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof HttpError) return error.statusCode;
    throw error;
  }
};

describe("assertFullAccessRemains", () => {
  it("has nothing to protect on a site where nobody has full access", async () => {
    const limited = await makeGroup(["article:read"]);
    const user = await makeUser(limited.id);

    expect(
      await refusal(() =>
        assertFullAccessRemains({ group: { id: limited.id, grants: null } }),
      ),
    ).toBeNull();
    expect(
      await refusal(() =>
        assertFullAccessRemains({ user: { id: user.id, groups: null } }),
      ),
    ).toBeNull();
  });

  describe("with exactly one person who has full access", () => {
    it("refuses to demote or delete the group they get it from", async () => {
      const full = await makeGroup(["*:*:all"]);
      await makeUser(full.id);

      expect(
        await refusal(() =>
          assertFullAccessRemains({
            group: { id: full.id, grants: ["article:read"] },
          }),
        ),
      ).toBe(409);
      expect(
        await refusal(() =>
          assertFullAccessRemains({ group: { id: full.id, grants: null } }),
        ),
      ).toBe(409);

      await db.adapter.removeWhere(userModel.def, []);
      await db.adapter.removeWhere(accessGroup.def, []);
    });

    it("refuses to move them out of it or to delete them", async () => {
      const full = await makeGroup(["*:*:all"]);
      const holder = await makeUser(full.id);

      expect(
        await refusal(() =>
          assertFullAccessRemains({ user: { id: holder.id, groups: [] } }),
        ),
      ).toBe(409);
      expect(
        await refusal(() =>
          assertFullAccessRemains({ user: { id: holder.id, groups: null } }),
        ),
      ).toBe(409);

      await db.adapter.removeWhere(userModel.def, []);
      await db.adapter.removeWhere(accessGroup.def, []);
    });

    it("allows a change that keeps them there", async () => {
      const full = await makeGroup(["*:*:all"]);
      const holder = await makeUser(full.id);
      const extra = await makeGroup(["article:read"]);

      expect(
        await refusal(() =>
          assertFullAccessRemains({
            user: { id: holder.id, groups: [full.id, extra.id] },
          }),
        ),
      ).toBeNull();
      expect(
        await refusal(() =>
          assertFullAccessRemains({
            group: { id: full.id, grants: ["*:*", "article:read"] },
          }),
        ),
      ).toBeNull();

      await db.adapter.removeWhere(userModel.def, []);
      await db.adapter.removeWhere(accessGroup.def, []);
    });
  });

  describe("with several people who have it", () => {
    it("lets any one of them go, as long as one is left", async () => {
      const full = await makeGroup(["*:*:all"]);
      const other = await makeGroup(["*:*"]);
      const first = await makeUser(full.id);
      await makeUser(other.id);

      expect(
        await refusal(() =>
          assertFullAccessRemains({ user: { id: first.id, groups: null } }),
        ),
      ).toBeNull();
      expect(
        await refusal(() =>
          assertFullAccessRemains({ group: { id: full.id, grants: null } }),
        ),
      ).toBeNull();
    });

    it("does not count a group that only looks like full access", async () => {
      await db.adapter.removeWhere(userModel.def, []);
      await db.adapter.removeWhere(accessGroup.def, []);

      const full = await makeGroup(["*:*:all"]);
      const lookalike = await makeGroup(["*:*:own", "*:read:all"]);
      const holder = await makeUser(full.id);
      await makeUser(lookalike.id);

      expect(
        await refusal(() =>
          assertFullAccessRemains({ user: { id: holder.id, groups: null } }),
        ),
      ).toBe(409);
    });
  });
});
