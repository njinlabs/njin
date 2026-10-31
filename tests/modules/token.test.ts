import { describe, expect, it } from "bun:test";
import { access } from "../../src/core/access";
import { tokenTable } from "../../src/core/db/internal";
import { useTestDb } from "../helpers/test_db";

const db = await useTestDb();

const { default: userModel } = await import("../../src/models/user");
const { default: accessGroup } = await import("../../src/models/access_group");
const {
  findOwnToken,
  issueOAuthTokens,
  issueToken,
  listTokens,
  resolveBearer,
  revokeOAuthToken,
  rotateOAuthTokens,
  toPublic,
} = await import("../../src/modules/token");

await db.sync([userModel.def, accessGroup.def]);

const editors = await accessGroup.create({
  name: "Editors",
  grants: ["post:*:own", "category:read:all"],
});
const user = await userModel.create({
  name: "Alice",
  email: "alice@example.com",
  password: "x",
  groups: [editors.id],
});
const other = await userModel.create({
  name: "Bob",
  email: "bob@example.com",
  password: "x",
});

const idOf = (bearer: string) => bearer.split(":")[1] as string;
const secretOf = (bearer: string) => bearer.split(":")[2] as string;
const hashOf = (plain: string) =>
  new Bun.CryptoHasher("sha256").update(plain).digest("hex");
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const stored = async (bearer: string) => {
  const row = await db.adapter.find(tokenTable, idOf(bearer));
  if (!row) throw new Error("token row is missing");
  return row;
};

// A principal that must exist, with its permissions at hand for assertions.
const permissionsOf = async (bearer: string) => {
  const principal = await resolveBearer(bearer);
  if (!principal) throw new Error("token did not resolve");
  return principal.permissions;
};

describe("issueToken", () => {
  it("stores only a hash of the secret", async () => {
    const issued = await issueToken({ user: user.id, kind: "session" });
    const row = await stored(issued.bearer);

    expect(issued.bearer).toMatch(/^njt:[^:]+:[A-Za-z0-9_-]{40,}$/);
    expect(row.hash).toBe(hashOf(secretOf(issued.bearer)));
    expect(JSON.stringify(row)).not.toContain(secretOf(issued.bearer));
  });

  it("stores the hash as plain hex, whatever the secret hashes to", async () => {
    for (let n = 0; n < 100; n++) {
      const issued = await issueToken({ user: user.id, kind: "pat" });
      expect((await stored(issued.bearer)).hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("never issues the same secret twice", async () => {
    const secrets = new Set<string>();
    for (let n = 0; n < 50; n++) {
      secrets.add(
        secretOf((await issueToken({ user: user.id, kind: "pat" })).bearer),
      );
    }

    expect(secrets.size).toBe(50);
  });

  it("gives a session a month that renews as it is used, and no refresh token", async () => {
    const issued = await issueToken({ user: user.id, kind: "session" });
    const days = (Date.parse(issued.expiresAt ?? "") - Date.now()) / 864e5;

    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    expect(issued.refresh).toBeNull();
  });

  it("lets a personal token live until it is revoked", async () => {
    const issued = await issueToken({
      user: user.id,
      kind: "pat",
      name: "CI",
      scopes: ["post:read"],
    });
    const row = await stored(issued.bearer);

    expect(issued.expiresAt).toBeNull();
    expect(issued.refresh).toBeNull();
    expect(row.expiresAt ?? null).toBeNull();
    expect(row.name).toBe("CI");
    expect(row.scopes).toEqual(["post:read"]);
  });

  it("gives an OAuth token an hour and a refresh token with its own prefix", async () => {
    const issued = await issueToken({
      user: user.id,
      kind: "oauth",
      name: "Claude",
      clientId: "client1",
    });
    const minutes = (Date.parse(issued.expiresAt ?? "") - Date.now()) / 6e4;

    expect(minutes).toBeGreaterThan(59);
    expect(minutes).toBeLessThanOrEqual(60);
    expect(issued.refresh).toMatch(/^njr:[^:]+:[^:]+$/);
    expect(idOf(issued.refresh ?? "")).toBe(idOf(issued.bearer));
    expect((await stored(issued.bearer)).clientId).toBe("client1");
  });
});

describe("resolveBearer", () => {
  it("returns who the token is for, what kind it is and what it may do", async () => {
    const bearer = (await issueToken({ user: user.id, kind: "session" }))
      .bearer;
    const principal = await resolveBearer(bearer);

    expect(principal?.user.id).toBe(user.id);
    expect(principal?.user.email).toBe("alice@example.com");
    expect(principal?.kind).toBe("session");
    expect(principal?.token.id).toBe(idOf(bearer));

    const permissions = await permissionsOf(bearer);
    expect(access(permissions, "post", "update")).toBe("own");
    expect(access(permissions, "category", "read")).toBe("all");
    expect(access(permissions, "category", "update")).toBe(false);
  });

  it("never exposes the password", async () => {
    const principal = await resolveBearer(
      (await issueToken({ user: user.id, kind: "session" })).bearer,
    );

    expect(principal).not.toBeNull();
    expect("password" in (principal?.user ?? {})).toBe(false);
  });

  it("narrows a delegated token to its scopes, but not a session", async () => {
    const pat = await permissionsOf(
      (
        await issueToken({
          user: user.id,
          kind: "pat",
          scopes: ["post:read"],
        })
      ).bearer,
    );
    expect(access(pat, "post", "read")).toBe("own");
    expect(access(pat, "post", "update")).toBe(false);
    expect(access(pat, "category", "read")).toBe(false);

    const session = await permissionsOf(
      (
        await issueToken({
          user: user.id,
          kind: "session",
          scopes: ["post:read"],
        })
      ).bearer,
    );
    expect(access(session, "post", "update")).toBe("own");
  });

  it("gives a delegated token with no scopes no access at all", async () => {
    const permissions = await permissionsOf(
      (await issueToken({ user: user.id, kind: "oauth" })).bearer,
    );

    expect(access(permissions, "post", "read")).toBe(false);
  });

  it("gives a user in no group no access", async () => {
    const permissions = await permissionsOf(
      (await issueToken({ user: other.id, kind: "session" })).bearer,
    );

    expect(access(permissions, "post", "read")).toBe(false);
  });

  it("accepts neither a wrong secret nor a refresh token", async () => {
    const issued = await issueToken({
      user: user.id,
      kind: "oauth",
      scopes: ["*:*"],
    });

    expect(await resolveBearer(`njt:${idOf(issued.bearer)}:wrong`)).toBeNull();
    expect(await resolveBearer(issued.refresh ?? "")).toBeNull();
    expect(await resolveBearer(undefined)).toBeNull();
  });

  it("refuses an expired token", async () => {
    const bearer = (await issueToken({ user: user.id, kind: "oauth" })).bearer;
    await db.adapter.update(tokenTable, idOf(bearer), { expiresAt: ago(1000) });

    expect(await resolveBearer(bearer)).toBeNull();
  });

  describe("last use", () => {
    it("is not written again within a minute", async () => {
      const bearer = (await issueToken({ user: user.id, kind: "pat" })).bearer;
      const before = (await stored(bearer)).lastUsedAt;

      await resolveBearer(bearer);
      await resolveBearer(bearer);

      expect((await stored(bearer)).lastUsedAt).toBe(before);
    });

    it("is written once a minute has gone by", async () => {
      const bearer = (await issueToken({ user: user.id, kind: "pat" })).bearer;
      const stale = ago(2 * 60 * 1000);
      await db.adapter.update(tokenTable, idOf(bearer), { lastUsedAt: stale });

      await resolveBearer(bearer);

      const after = String((await stored(bearer)).lastUsedAt);
      expect(Date.parse(after)).toBeGreaterThan(Date.parse(stale));
    });

    it("keeps a session alive for as long as it is used, but leaves other kinds' expiry", async () => {
      const session = (await issueToken({ user: user.id, kind: "session" }))
        .bearer;
      const oauth = (await issueToken({ user: user.id, kind: "oauth" })).bearer;
      const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      for (const bearer of [session, oauth]) {
        await db.adapter.update(tokenTable, idOf(bearer), {
          expiresAt: soon,
          lastUsedAt: ago(2 * 60 * 1000),
        });
      }

      await resolveBearer(session);
      await resolveBearer(oauth);

      const renewed = String((await stored(session)).expiresAt);
      expect(Date.parse(renewed) - Date.now()).toBeGreaterThan(29 * 864e5);
      expect((await stored(oauth)).expiresAt).toBe(soon);
    });
  });
});

describe("OAuth tokens", () => {
  const issue = () =>
    issueOAuthTokens({
      name: "Claude",
      clientId: "client1",
      userId: user.id,
      scopes: ["post:read"],
    });

  it("answers in the shape RFC 6749 asks for", async () => {
    const issued = await issue();

    expect(issued.token_type).toBe("Bearer");
    expect(issued.expires_in).toBe(3600);
    expect(issued.access_token).toMatch(/^njt:/);
    expect(issued.refresh_token).toMatch(/^njr:/);
  });

  it("issues an access token that works and a refresh token that does not", async () => {
    const issued = await issue();

    expect((await resolveBearer(issued.access_token))?.kind).toBe("oauth");
    expect(await resolveBearer(issued.refresh_token)).toBeNull();
  });

  it("carries the scopes it was issued with", async () => {
    const permissions = await permissionsOf((await issue()).access_token);

    expect(access(permissions, "post", "read")).toBe("own");
    expect(access(permissions, "post", "update")).toBe(false);
  });

  it("rotates the refresh token — the old pair stops working", async () => {
    const first = await issue();
    const second = await rotateOAuthTokens(first.refresh_token, "client1");

    expect(second).not.toBeNull();
    expect(idOf(second?.access_token ?? "")).toBe(idOf(first.access_token));
    expect(await resolveBearer(second?.access_token ?? "")).not.toBeNull();
    expect(await resolveBearer(first.access_token)).toBeNull();
    expect(await rotateOAuthTokens(first.refresh_token, "client1")).toBeNull();
  });

  it("keeps the scopes through a rotation", async () => {
    const first = await issue();
    const second = await rotateOAuthTokens(first.refresh_token, "client1");
    const permissions = await permissionsOf(second?.access_token ?? "");

    expect(access(permissions, "post", "read")).toBe("own");
    expect(access(permissions, "post", "update")).toBe(false);
  });

  it("refuses a refresh from a different client", async () => {
    const issued = await issue();

    expect(await rotateOAuthTokens(issued.refresh_token, "other")).toBeNull();
  });

  it("refuses a refresh token whose lifetime ran out", async () => {
    const issued = await issue();
    await db.adapter.update(tokenTable, idOf(issued.access_token), {
      refreshExpiresAt: ago(1000),
    });

    expect(await rotateOAuthTokens(issued.refresh_token, "client1")).toBeNull();
  });

  it("refuses a wrong secret and an access token", async () => {
    const issued = await issue();
    const id = idOf(issued.access_token);

    expect(await rotateOAuthTokens(`njr:${id}:wrong`, "client1")).toBeNull();
    expect(await rotateOAuthTokens(issued.access_token, "client1")).toBeNull();
  });

  it("does not rotate the credentials of anything but a connected app", async () => {
    const pat = await issueToken({ user: user.id, kind: "pat" });

    expect(
      await rotateOAuthTokens(`njr:${idOf(pat.bearer)}:x`, "client1"),
    ).toBeNull();
  });

  it("revokes the whole connection from either token", async () => {
    const byAccess = await issue();
    await revokeOAuthToken(byAccess.access_token);
    expect(await resolveBearer(byAccess.access_token)).toBeNull();

    const byRefresh = await issue();
    await revokeOAuthToken(byRefresh.refresh_token);
    expect(await resolveBearer(byRefresh.access_token)).toBeNull();
  });

  it("ignores a revoke with the wrong secret", async () => {
    const issued = await issue();
    await revokeOAuthToken(`njt:${idOf(issued.access_token)}:wrong`);

    expect(await resolveBearer(issued.access_token)).not.toBeNull();
  });

  it("cannot be used to revoke a session or a personal token", async () => {
    const session = (await issueToken({ user: user.id, kind: "session" }))
      .bearer;
    const pat = (await issueToken({ user: user.id, kind: "pat" })).bearer;

    await revokeOAuthToken(session);
    await revokeOAuthToken(pat);

    expect(await resolveBearer(session)).not.toBeNull();
    expect(await resolveBearer(pat)).not.toBeNull();
  });

  it("ignores a revoke of something that is not a token", async () => {
    await revokeOAuthToken("garbage");
    await revokeOAuthToken("njt:missing:secret");
  });
});

describe("listing tokens", () => {
  it("returns the user's own, newest first, without anything secret", async () => {
    await issueToken({ user: other.id, kind: "pat", name: "Bobs" });
    const mine = await issueToken({
      user: user.id,
      kind: "pat",
      name: "Mine",
    });

    const tokens = await listTokens(user.id);

    expect(tokens.some((t) => t.id === idOf(mine.bearer))).toBe(true);
    expect(tokens.some((t) => t.name === "Bobs")).toBe(false);

    const times = tokens.map((t) => Date.parse(t.createdAt ?? ""));
    expect(times).toEqual([...times].sort((a, b) => b - a));

    for (const token of tokens) {
      const shown: Record<string, unknown> = { ...toPublic(token) };
      expect(shown.hash).toBeUndefined();
      expect(shown.refreshHash).toBeUndefined();
    }
  });

  it("leaves out the sign-in cookie of the OAuth pages", async () => {
    const web = await issueToken({ user: user.id, kind: "web" });

    const tokens = await listTokens(user.id);

    expect(tokens.some((t) => t.id === idOf(web.bearer))).toBe(false);
  });

  it("finds a token only for its owner", async () => {
    const mine = await issueToken({ user: user.id, kind: "pat" });

    expect((await findOwnToken(user.id, idOf(mine.bearer)))?.id).toBe(
      idOf(mine.bearer),
    );
    expect(await findOwnToken(other.id, idOf(mine.bearer))).toBeNull();
    expect(await findOwnToken(user.id, "nope")).toBeNull();
  });
});
