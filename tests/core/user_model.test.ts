import { describe, expect, it, mock } from "bun:test";
import * as realSurrealModule from "../../src/modules/surreal";

const queries: { sql: string; vars: Record<string, unknown> }[] = [];
let rows: unknown[] = [];

mock.module("../../src/modules/surreal", () => ({
  ...realSurrealModule,
  default: () => ({
    query: async (sql: string, vars: Record<string, unknown>) => {
      queries.push({ sql, vars });
      return [rows];
    },
  }),
}));

const {
  default: user,
  DUMMY_HASH,
  findUserByEmail,
} = await import("../../src/models/user");

describe("findUserByEmail", () => {
  it("compares lowercased on both sides and trims the input", async () => {
    rows = [{ email: "Admin@Example.com" }];

    const found = await findUserByEmail("  ADMIN@example.COM ");

    expect(found).toEqual({ email: "Admin@Example.com" });
    expect(queries.at(-1)?.sql).toContain("string::lowercase(email) = $email");
    expect(queries.at(-1)?.vars).toEqual({ email: "admin@example.com" });
  });

  it("returns undefined when nothing matches", async () => {
    rows = [];
    expect(await findUserByEmail("nobody@example.com")).toBeUndefined();
  });

  it("binds the email as a parameter, never into the query text", async () => {
    rows = [];
    await findUserByEmail("x' OR true --");
    expect(queries.at(-1)?.sql).not.toContain("OR true");
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
