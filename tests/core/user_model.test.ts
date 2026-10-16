import { describe, expect, it } from "bun:test";
import { useTestDb } from "../helpers/test_db";

const db = await useTestDb();

const {
  default: user,
  DUMMY_HASH,
  findUserByEmail,
} = await import("../../src/models/user");

await db.sync([user.def]);

describe("findUserByEmail", () => {
  it("matches case-insensitively and trims the input", async () => {
    const created = await user.create({
      name: "Admin",
      email: "Admin@Example.com",
      password: "x",
    });

    const found = await findUserByEmail<{ id: string; email: string }>(
      "  ADMIN@example.COM ",
    );

    expect(found?.id).toBe(created.id);
    expect(found?.email).toBe("Admin@Example.com");
  });

  it("asks the adapter for a case-insensitive equality, not a LIKE or a raw query", async () => {
    await findUserByEmail("someone@example.com");

    const [, query] = db.callsTo("list").at(-1) as [
      unknown,
      { where: unknown },
    ];
    expect(query.where).toEqual([
      { field: "email", op: "$ieq", value: "someone@example.com" },
    ]);
  });

  it("returns undefined when nothing matches", async () => {
    expect(await findUserByEmail("nobody@example.com")).toBeUndefined();
  });

  it("treats query syntax in the email as plain text", async () => {
    expect(await findUserByEmail("x' OR true --")).toBeUndefined();
  });
});

describe("user model", () => {
  it("hashes the password when validating", () => {
    const parsed = user.validation.parse({
      name: "A",
      email: "a@example.com",
      password: "secret-pass",
    });

    expect(parsed.password).not.toBe("secret-pass");
    expect(Bun.password.verifySync("secret-pass", parsed.password)).toBe(true);
  });

  it("exports a dummy hash that verifies nothing real", () => {
    expect(Bun.password.verifySync("anything", DUMMY_HASH)).toBe(false);
  });
});
