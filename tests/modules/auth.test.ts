import { describe, expect, it, mock, spyOn } from "bun:test";
import { tokenTable } from "../../src/core/db/internal";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeElysia } from "../helpers/fake_elysia";
import { useTestDb } from "../helpers/test_db";

// The db module is a real in-memory adapter, so these tests drive the actual user/token
// round trips instead of a hand-written fake.
const db = await useTestDb();

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const { default: userModel, DUMMY_HASH } = await import(
  "../../src/models/user"
);
const { default: auth } = await import("../../src/modules/auth");

await db.sync([userModel.def]);

const plainPassword = "correct-password";
const alice = await userModel.create({
  name: "Alice",
  email: "alice@example.com",
  password: Bun.password.hashSync(plainPassword),
});

// What versions before the hex change stored; still accepted.
const legacyHashOf = (plain: string) =>
  new Bun.CryptoHasher("sha256").update(plain).digest("utf8");
const hashOf = (plain: string) =>
  new Bun.CryptoHasher("sha256").update(plain).digest("hex");

// Stores a token for alice and returns the bearer string for it.
const setValidToken = async (id = "tok-valid") => {
  const plainToken = "plain-token-value";
  await db.adapter.insert(
    tokenTable,
    {
      hash: hashOf(plainToken),
      user: alice.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    { id },
  );
  return `token:${id}:${plainToken}`;
};

await auth.init();
const controller = fakeElysia.buildApp();

const post = (path: string, body: unknown) =>
  controller.handle(
    new Request(`http://localhost/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("auth macro (via /check-token)", () => {
  it("returns 401 when no bearer token is supplied", async () => {
    const res = await controller.handle(
      new Request("http://localhost/api/auth/check-token"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token id does not exist", async () => {
    const res = await controller.handle(
      new Request("http://localhost/api/auth/check-token", {
        headers: { Authorization: "Bearer token:nope:whatever" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token hash does not match", async () => {
    await setValidToken("tok-hash");
    const res = await controller.handle(
      new Request("http://localhost/api/auth/check-token", {
        headers: { Authorization: "Bearer token:tok-hash:wrong-plain" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("passes through and strips the password/tokenId for a valid bearer", async () => {
    const bearer = await setValidToken("tok-ok");
    const res = await controller.handle(
      new Request("http://localhost/api/auth/check-token", {
        headers: { Authorization: `Bearer ${bearer}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.email).toBe("alice@example.com");
    expect(body.data.id).toBe(alice.id);
    expect(body.data.password).toBeUndefined();
    expect(body.data.tokenId).toBeUndefined();
  });

  it("still accepts a token stored in the legacy utf8 form, so existing sessions survive an upgrade", async () => {
    await db.adapter.insert(
      tokenTable,
      { hash: legacyHashOf("old-secret"), user: alice.id },
      { id: "tok-legacy" },
    );

    const res = await controller.handle(
      new Request("http://localhost/api/auth/check-token", {
        headers: { Authorization: "Bearer token:tok-legacy:old-secret" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("returns 401 for a token whose user has since been deleted", async () => {
    const orphan = await userModel.create({
      name: "Gone",
      email: "gone@example.com",
      password: "x",
    });
    await db.adapter.insert(
      tokenTable,
      { hash: hashOf("orphan"), user: orphan.id },
      { id: "tok-orphan" },
    );
    await userModel.destroy(orphan.id);

    const res = await controller.handle(
      new Request("http://localhost/api/auth/check-token", {
        headers: { Authorization: "Bearer token:tok-orphan:orphan" },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /logout", () => {
  it("deletes the token and returns the user", async () => {
    const bearer = await setValidToken("tok-logout");
    const res = await controller.handle(
      new Request("http://localhost/api/auth/logout", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bearer}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.email).toBe("alice@example.com");
    expect(await db.adapter.find(tokenTable, "tok-logout")).toBeNull();
  });
});

describe("bearer auth", () => {
  it("surfaces an unexpected lookup failure as 500, not 401", async () => {
    db.failNext("find");
    const res = await controller.handle(
      new Request("http://localhost/api/auth/check-token", {
        headers: { Authorization: "Bearer token:id:secret" },
      }),
    );
    expect(res.status).toBe(500);
  });

  it("returns 401, not 500, for a malformed bearer token", async () => {
    for (const header of ["Bearer abc", "Bearer token:onlyid"]) {
      const res = await controller.handle(
        new Request("http://localhost/api/auth/check-token", {
          headers: { Authorization: header },
        }),
      );
      expect(res.status).toBe(401);
    }
  });
});

describe("POST /login", () => {
  it("stores the token hash as plain hex text, whatever the secret hashes to", async () => {
    for (let n = 0; n < 40; n++) {
      const res = await post("/login", {
        email: "alice@example.com",
        password: plainPassword,
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { data: { token: string } };
      const [, id, secret] = body.data.token.split(":");
      const stored = await db.adapter.find(tokenTable, id as string);
      expect(stored?.hash).toBe(hashOf(secret as string));
      expect(stored?.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("still verifies a password when the email is unknown (no timing shortcut)", async () => {
    const verify = spyOn(Bun.password, "verify");
    try {
      await post("/login", { email: "x@example.com", password: "pw" });
      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify.mock.calls[0]?.[1]).toBe(DUMMY_HASH);
    } finally {
      verify.mockRestore();
    }
  });

  it("surfaces unexpected database errors as 500, not 401", async () => {
    db.failNext("list");
    const res = await post("/login", {
      email: "a@example.com",
      password: "pw",
    });
    expect(res.status).toBe(500);
  });

  it("matches the email case-insensitively", async () => {
    const res = await post("/login", {
      email: "Alice@Example.com",
      password: plainPassword,
    });

    expect(res.status).toBe(200);
  });

  it("returns 401 when the user does not exist", async () => {
    const res = await post("/login", {
      email: "nobody@example.com",
      password: "whatever",
    });

    expect(res.status).toBe(401);
  });

  it("returns 401 when the password is wrong", async () => {
    const res = await post("/login", {
      email: "alice@example.com",
      password: "wrong-password",
    });
    expect(res.status).toBe(401);
  });

  it("logs in, stores a token for the user, and returns a usable token without the password", async () => {
    const res = await post("/login", {
      email: "alice@example.com",
      password: plainPassword,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.password).toBeUndefined();
    expect(body.data.token).toMatch(/^token:[^:]+:.+$/);

    // The token it returned actually authenticates.
    const check = await controller.handle(
      new Request("http://localhost/api/auth/check-token", {
        headers: { Authorization: `Bearer ${body.data.token}` },
      }),
    );
    expect(check.status).toBe(200);

    // And the stored token points at the user by plain id.
    const [id] = (body.data.token as string).split(":").slice(1);
    const stored = await db.adapter.find(tokenTable, id as string);
    expect(stored?.user).toBe(alice.id);
  });
});
