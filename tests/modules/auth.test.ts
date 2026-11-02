import { describe, expect, it, mock, setDefaultTimeout, spyOn } from "bun:test";
import Elysia from "elysia";
import { MAX_FAILURES } from "../../src/core/auth/rate_limit";
import { tokenTable } from "../../src/core/db/internal";
import * as realConfig from "../../src/core/runtime/config";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeElysia } from "../helpers/fake_elysia";
import { useTestDb } from "../helpers/test_db";

// Every login attempt hashes a password (argon2), and the lockout tests make a dozen of them.
setDefaultTimeout(30_000);

// The db module is a real in-memory adapter, so these tests drive the actual user/token
// round trips instead of a hand-written fake.
const db = await useTestDb();

// publicBase() reads config for the 401's resource_metadata pointer.
mock.module("../../src/core/runtime/config", () => ({
  ...realConfig,
  getConfig: () => ({ publicUrl: "https://site.example" }),
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const { default: userModel, DUMMY_HASH } = await import(
  "../../src/models/user"
);
const { default: accessGroup, ensureFullAccessGroup } = await import(
  "../../src/models/access_group"
);
const { default: auth } = await import("../../src/modules/auth");
const { issueToken } = await import("../../src/modules/token");
const { access } = await import("../../src/core/auth/access");

await db.sync([userModel.def, accessGroup.def]);

const plainPassword = "correct-password";
const fullAccess = await ensureFullAccessGroup();
const readers = await accessGroup.create({
  name: "Readers",
  grants: ["post:read:own"],
});

const alice = await userModel.create({
  name: "Alice",
  email: "alice@example.com",
  password: Bun.password.hashSync(plainPassword),
  groups: [fullAccess],
});
const bob = await userModel.create({
  name: "Bob",
  email: "bob@example.com",
  password: Bun.password.hashSync(plainPassword),
});
const carol = await userModel.create({
  name: "Carol",
  email: "carol@example.com",
  password: Bun.password.hashSync(plainPassword),
  groups: [readers.id],
});

const hashOf = (plain: string) =>
  new Bun.CryptoHasher("sha256").update(plain).digest("hex");

await auth.init();
const controller = fakeElysia.buildApp();

// Routes behind each way of using the macro, to see what lets whom through.
const { plugin } = await auth();
const probe = new Elysia()
  .use(plugin)
  .get("/any", ({ principal }) => ({ kind: principal.kind }), { auth: true })
  .get("/session", () => ({ ok: true }), { auth: { session: true } })
  .get("/mcp", () => ({ ok: true }), { auth: { mcp: true } })
  .get(
    "/can",
    ({ principal }) => ({
      level: access(principal.permissions, "post", "read"),
    }),
    { auth: { can: ["post", "read"] } },
  );

const call = (
  app: { handle: (request: Request) => Response | Promise<Response> },
  path: string,
  bearer?: string,
  init: RequestInit = {},
) =>
  Promise.resolve(
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      }),
    ),
  );

const sessionFor = async (user: { id: string }) =>
  (await issueToken({ user: user.id, kind: "session" })).bearer;
const patFor = async (user: { id: string }, scopes: string[]) =>
  (await issueToken({ user: user.id, kind: "pat", name: "Script", scopes }))
    .bearer;
const oauthFor = async (user: { id: string }, scopes: string[]) =>
  (
    await issueToken({
      user: user.id,
      kind: "oauth",
      name: "Claude",
      clientId: "client1",
      scopes,
    })
  ).bearer;

const post = (path: string, body: unknown) =>
  call(controller, `/api/auth${path}`, undefined, {
    method: "POST",
    body: JSON.stringify(body),
  });

describe("auth macro", () => {
  it("returns 401 when no bearer token is supplied", async () => {
    expect((await call(probe, "/any")).status).toBe(401);
  });

  it("returns 401 when the token id does not exist", async () => {
    expect((await call(probe, "/any", "njt:nope:whatever")).status).toBe(401);
  });

  it("returns 401 when the secret does not match", async () => {
    const bearer = await sessionFor(alice);
    const [prefix, id] = bearer.split(":");

    expect((await call(probe, "/any", `${prefix}:${id}:wrong`)).status).toBe(
      401,
    );
  });

  it("returns 401 for a bearer that is not ours", async () => {
    for (const bearer of [
      "abc",
      "njt:onlyid",
      "njt::secret",
      "njt:id:secret:extra",
      // the prefixes of the credentials this replaced, and a refresh token
      "token:id:secret",
      "mcp:id:secret",
      "njr:id:secret",
    ]) {
      expect((await call(probe, "/any", bearer)).status).toBe(401);
    }
  });

  it("returns 401 for a token past its expiry", async () => {
    const bearer = await sessionFor(alice);
    const id = bearer.split(":")[1] as string;
    await db.adapter.update(tokenTable, id, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    expect((await call(probe, "/any", bearer)).status).toBe(401);
  });

  it("returns 401 for a token whose user has since been deleted", async () => {
    const orphan = await userModel.create({
      name: "Gone",
      email: "gone@example.com",
      password: "x",
    });
    const bearer = await sessionFor(orphan);
    await userModel.destroy(orphan.id);

    expect((await call(probe, "/any", bearer)).status).toBe(401);
  });

  it("surfaces an unexpected lookup failure as 500, not 401", async () => {
    db.failNext("find");

    expect((await call(probe, "/any", "njt:id:secret")).status).toBe(500);
  });

  it("strips the password and token id from the user it exposes", async () => {
    const res = await call(
      controller,
      "/api/auth/check-token",
      await sessionFor(alice),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.email).toBe("alice@example.com");
    expect(body.data.id).toBe(alice.id);
    expect(body.data.password).toBeUndefined();
    expect(body.data.tokenId).toBeUndefined();
  });
});

describe("where a kind of token may be used", () => {
  it("lets every kind into the content API", async () => {
    for (const bearer of [
      await sessionFor(alice),
      await patFor(alice, ["*:*"]),
      await oauthFor(alice, ["*:*"]),
    ]) {
      expect((await call(probe, "/any", bearer)).status).toBe(200);
    }
  });

  it("keeps management to a session", async () => {
    expect(
      (await call(probe, "/session", await sessionFor(alice))).status,
    ).toBe(200);

    for (const bearer of [
      await patFor(alice, ["*:*"]),
      await oauthFor(alice, ["*:*"]),
    ]) {
      expect((await call(probe, "/session", bearer)).status).toBe(401);
    }
  });

  it("keeps the agent endpoint to personal and OAuth tokens", async () => {
    expect(
      (await call(probe, "/mcp", await patFor(alice, ["*:*"]))).status,
    ).toBe(200);
    expect(
      (await call(probe, "/mcp", await oauthFor(alice, ["*:*"]))).status,
    ).toBe(200);
    expect((await call(probe, "/mcp", await sessionFor(alice))).status).toBe(
      401,
    );
  });

  it("points an agent without a valid token at the OAuth metadata", async () => {
    const res = await call(probe, "/mcp");

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://site.example/.well-known/oauth-protected-resource"',
    );
  });

  it("does not send that pointer for the other surfaces", async () => {
    expect((await call(probe, "/any")).headers.get("www-authenticate")).toBe(
      null,
    );
    expect(
      (await call(probe, "/session")).headers.get("www-authenticate"),
    ).toBe(null);
  });
});

describe("permissions of the caller", () => {
  it("come from the access groups of the user", async () => {
    const asAlice = await call(probe, "/can", await sessionFor(alice));
    expect(asAlice.status).toBe(200);
    expect(((await asAlice.json()) as { level: string }).level).toBe("all");

    const asCarol = await call(probe, "/can", await sessionFor(carol));
    expect(asCarol.status).toBe(200);
    expect(((await asCarol.json()) as { level: string }).level).toBe("own");
  });

  it("answer 403 to a user whose groups grant nothing there", async () => {
    expect((await call(probe, "/can", await sessionFor(bob))).status).toBe(403);
  });

  it("are narrowed by the scopes of a delegated token", async () => {
    expect(
      (await call(probe, "/can", await patFor(carol, ["post:read"]))).status,
    ).toBe(200);
    expect(
      (await call(probe, "/can", await patFor(carol, ["post:update"]))).status,
    ).toBe(403);
    expect(
      (await call(probe, "/can", await oauthFor(carol, ["*:read"]))).status,
    ).toBe(200);
  });

  it("can never exceed what the user has", async () => {
    expect((await call(probe, "/can", await patFor(bob, ["*:*"]))).status).toBe(
      403,
    );
  });

  it("follow a change to the user's groups on the next request", async () => {
    const dave = await userModel.create({
      name: "Dave",
      email: "dave@example.com",
      password: "x",
    });
    const bearer = await patFor(dave, ["*:*"]);
    expect((await call(probe, "/can", bearer)).status).toBe(403);

    await userModel.update(dave.id, { groups: [readers.id] });
    expect((await call(probe, "/can", bearer)).status).toBe(200);

    await userModel.update(dave.id, { groups: [] });
    expect((await call(probe, "/can", bearer)).status).toBe(403);
  });

  it("ignore a group that was deleted", async () => {
    const doomed = await accessGroup.create({
      name: "Doomed",
      grants: ["post:read:all"],
    });
    const erin = await userModel.create({
      name: "Erin",
      email: "erin@example.com",
      password: "x",
      groups: [doomed.id],
    });
    const bearer = await sessionFor(erin);
    expect((await call(probe, "/can", bearer)).status).toBe(200);

    await accessGroup.destroy(doomed.id);

    expect((await call(probe, "/can", bearer)).status).toBe(403);
  });
});

describe("DELETE /logout", () => {
  it("deletes the session and returns the user", async () => {
    const bearer = await sessionFor(alice);
    const id = bearer.split(":")[1] as string;

    const res = await call(controller, "/api/auth/logout", bearer, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.email).toBe("alice@example.com");
    expect(await db.adapter.find(tokenTable, id)).toBeNull();
    expect((await call(probe, "/any", bearer)).status).toBe(401);
  });

  it("is not for a delegated token", async () => {
    const bearer = await patFor(alice, ["*:*"]);

    const res = await call(controller, "/api/auth/logout", bearer, {
      method: "DELETE",
    });

    expect(res.status).toBe(401);
    expect((await call(probe, "/any", bearer)).status).toBe(200);
  });
});

describe("POST /login", () => {
  it("logs in and returns a session token that works, without the password", async () => {
    const res = await post("/login", {
      email: "alice@example.com",
      password: plainPassword,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.password).toBeUndefined();
    expect(body.data.token).toMatch(/^njt:[^:]+:[^:]+$/);

    const bearer = body.data.token as string;
    expect((await call(probe, "/session", bearer)).status).toBe(200);

    const stored = await db.adapter.find(
      tokenTable,
      bearer.split(":")[1] as string,
    );
    expect(stored?.user).toBe(alice.id);
    expect(stored?.kind).toBe("session");
    expect(stored?.hash).toBe(hashOf(bearer.split(":")[2] as string));
    expect(typeof stored?.expiresAt).toBe("string");
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
    // the rate limit is looked up first, then the user
    db.failNext("list");
    const res = await post("/login", {
      email: "a@example.com",
      password: "pw",
    });

    expect(res.status).toBe(500);
  });

  describe("after repeated failures", () => {
    const attempt = (email: string, password: string) =>
      post("/login", { email, password });

    it("locks the account out, whatever the password", async () => {
      const email = "lockout@example.com";
      await userModel.create({
        name: "Locked",
        email,
        password: Bun.password.hashSync(plainPassword),
      });

      for (let n = 0; n < MAX_FAILURES; n++) {
        expect((await attempt(email, "wrong")).status).toBe(401);
      }

      expect((await attempt(email, "wrong")).status).toBe(429);
      expect((await attempt(email, plainPassword)).status).toBe(429);
    });

    it("counts an unknown email too, so it cannot be told apart", async () => {
      const email = "ghost@example.com";

      for (let n = 0; n < MAX_FAILURES; n++) {
        await attempt(email, "wrong");
      }

      expect((await attempt(email, "wrong")).status).toBe(429);
    });

    it("counts the email without regard to case", async () => {
      for (let n = 0; n < MAX_FAILURES; n++) {
        await attempt(n % 2 ? "CaSe@example.com" : "case@example.com", "x");
      }

      expect((await attempt("CASE@example.com", "x")).status).toBe(429);
    });

    it("forgets the failures after a successful login", async () => {
      const email = "forgiven@example.com";
      await userModel.create({
        name: "Forgiven",
        email,
        password: Bun.password.hashSync(plainPassword),
      });

      for (let n = 0; n < MAX_FAILURES - 1; n++) {
        await attempt(email, "wrong");
      }
      expect((await attempt(email, plainPassword)).status).toBe(200);

      for (let n = 0; n < MAX_FAILURES - 1; n++) {
        expect((await attempt(email, "wrong")).status).toBe(401);
      }
    });

    it("leaves other accounts alone", async () => {
      for (let n = 0; n < MAX_FAILURES; n++) {
        await attempt("victim@example.com", "wrong");
      }

      expect((await attempt("alice@example.com", plainPassword)).status).toBe(
        200,
      );
    });
  });
});

describe("/api/token", () => {
  type Listed = Record<string, unknown> & { id: string };

  const list = async (bearer: string) => {
    const res = await call(controller, "/api/token", bearer);
    return {
      res,
      data: ((await res.json()) as { data: Listed[] }).data,
    };
  };

  const create = (bearer: string, body: unknown) =>
    call(controller, "/api/token", bearer, {
      method: "POST",
      body: JSON.stringify(body),
    });

  it("makes a personal token and shows its secret once", async () => {
    const res = await create(await sessionFor(alice), {
      name: "CI",
      scopes: ["post:read"],
    });

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.name).toBe("CI");
    expect(data.kind).toBe("pat");
    expect(data.scopes).toEqual(["post:read"]);
    expect(data.token).toMatch(/^njt:[^:]+:[^:]+$/);
    expect(data.hash).toBeUndefined();

    const token = data.token as string;
    const stored = await db.adapter.find(
      tokenTable,
      token.split(":")[1] as string,
    );
    expect(stored?.hash).toBe(hashOf(token.split(":")[2] as string));
    expect(JSON.stringify(stored)).not.toContain(token.split(":")[2] as string);
  });

  it("defaults a token to everything its owner can do", async () => {
    const res = await create(await sessionFor(alice), { name: "Wide" });
    const { data } = (await res.json()) as { data: { scopes: string[] } };

    expect(data.scopes).toEqual(["*:*"]);
  });

  it("rejects a bad name or scope", async () => {
    const bearer = await sessionFor(alice);

    for (const body of [
      { name: "   " },
      { name: "x", scopes: [] },
      { name: "x", scopes: ["nocolon"] },
      { name: "x", scopes: ["a:b:c"] },
      { name: "x", scopes: ["has space:read"] },
    ]) {
      expect((await create(bearer, body)).status).toBe(422);
    }
  });

  it("lists only the caller's own credentials, never a hash or secret", async () => {
    const aliceBearer = await sessionFor(alice);
    await create(aliceBearer, { name: "Alice token" });
    const bobBearer = await sessionFor(bob);
    await create(bobBearer, { name: "Bob token" });

    const { res, data } = await list(aliceBearer);

    expect(res.status).toBe(200);
    expect(data.some((t) => t.name === "Alice token")).toBe(true);
    expect(data.some((t) => t.name === "Bob token")).toBe(false);
    for (const item of data) {
      expect(item.hash).toBeUndefined();
      expect(item.refreshHash).toBeUndefined();
      expect(item.token).toBeUndefined();
    }
  });

  it("lists connected agents alongside personal tokens", async () => {
    await oauthFor(alice, ["post:read"]);
    const { data } = await list(await sessionFor(alice));

    expect(data.some((t) => t.kind === "oauth")).toBe(true);
    expect(data.some((t) => t.kind === "pat")).toBe(true);
    expect(data.some((t) => t.kind === "session")).toBe(true);
  });

  it("revokes a token at once", async () => {
    const aliceBearer = await sessionFor(alice);
    const created = await create(aliceBearer, { name: "Revocable" });
    const { data } = (await created.json()) as {
      data: { id: string; token: string };
    };
    expect((await call(probe, "/mcp", data.token)).status).toBe(200);

    const res = await call(controller, `/api/token/${data.id}`, aliceBearer, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect((await call(probe, "/mcp", data.token)).status).toBe(401);
  });

  it("answers 404 for an unknown token and for someone else's", async () => {
    const aliceBearer = await sessionFor(alice);
    const bobBearer = await sessionFor(bob);
    const created = await create(bobBearer, { name: "Not yours" });
    const { data } = (await created.json()) as {
      data: { id: string; token: string };
    };

    for (const id of ["nope", data.id]) {
      const res = await call(controller, `/api/token/${id}`, aliceBearer, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    }

    expect((await call(probe, "/mcp", data.token)).status).toBe(200);
  });

  it("is closed to a delegated token, so a leaked agent cannot mint another", async () => {
    for (const bearer of [
      await patFor(alice, ["*:*"]),
      await oauthFor(alice, ["*:*"]),
    ]) {
      expect((await list(bearer)).res.status).toBe(401);
      expect((await create(bearer, { name: "Backdoor" })).status).toBe(401);
    }
  });
});
