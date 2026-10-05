import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { createNodeEngines } from "@surrealdb/node";
import Elysia from "elysia";
import { RecordId, Surreal, Table } from "surrealdb";
import * as realConfig from "../../src/core/config";
import realUserModel from "../../src/models/user";
import * as realElysiaModule from "../../src/modules/elysia";
import * as realSurrealModule from "../../src/modules/surreal";
import { makeFakeAuthPlugin } from "../helpers/fake_auth";
import { makeFakeElysia } from "../helpers/fake_elysia";

// Real embedded SurrealDB rather than a hand-rolled fake — the OAuth flow leans on record-id
// creates, merges and DELETE ... WHERE queries, which a fake would only echo back.
const db = new Surreal({ engines: createNodeEngines() });
await db.connect("mem://");
await db.use({ namespace: "test", database: "test" });
// Mirrors ensureTables(): selecting by record id on a never-DEFINE'd table throws.
await db.query(
  "DEFINE TABLE IF NOT EXISTS user SCHEMALESS; DEFINE TABLE IF NOT EXISTS mcp_token SCHEMALESS; DEFINE TABLE IF NOT EXISTS oauth_client SCHEMALESS; DEFINE TABLE IF NOT EXISTS oauth_code SCHEMALESS;",
);

mock.module("../../src/modules/surreal", () => ({
  ...realSurrealModule,
  default: () => db,
}));
mock.module("../../src/models/user", () => ({ default: realUserModel }));
mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ publicUrl: "https://site.example" }),
}));
mock.module("../../src/modules/auth", () => ({
  default: async () => ({ plugin: makeFakeAuthPlugin() }),
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const { default: oauth } = await import("../../src/modules/oauth");
const { default: mcpToken } = await import("../../src/modules/mcp_token");

await oauth.init();
await mcpToken.init();
const app = fakeElysia.buildApp();

// A real mcpAuth-protected route, so a token coming out of the OAuth flow is proven against
// the actual verifier rather than just inspected.
const { plugin: mcpAuthPlugin } = await mcpToken();
const protectedApp = new Elysia()
  .use(mcpAuthPlugin)
  .get("/probe", ({ mcpToken }) => ({ data: mcpToken }), { mcpAuth: true });

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const PASSWORD = "correct-horse";
const EMAIL = "admin@example.com";

// An embedded engine left open at exit crashed Bun with a segfault on Linux CI (after all
// tests had passed) — close it explicitly.
afterAll(async () => {
  await db.close();
});

beforeAll(async () => {
  await db.create(new RecordId("user", "admin1")).content({
    name: "Admin",
    email: EMAIL,
    password: Bun.password.hashSync(PASSWORD),
  });
});

const request = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost${path}`, init));

const form = (values: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(values).toString(),
});

const register = async (redirectUris: string[] = [CALLBACK]) => {
  const res = await request("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: redirectUris,
    }),
  });
  return { res, body: (await res.json()) as Record<string, any> };
};

const pkce = () => {
  const verifier = "v".repeat(64);
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
};

const authorizeQuery = (clientId: string, challenge: string, extra = {}) =>
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    ...extra,
  }).toString();

// Runs register + the sign-in form and returns what the client would have in hand when the
// browser lands back on its callback.
const signIn = async (overrides: Record<string, string> = {}) => {
  const { body: client } = await register();
  const { verifier, challenge } = pkce();

  const res = await request(
    "/oauth/authorize",
    form({
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      state: "xyz",
      email: EMAIL,
      password: PASSWORD,
      action: "approve",
      ...overrides,
    }),
  );

  return { res, client, verifier, challenge };
};

const codeFrom = (res: Response) =>
  new URL(res.headers.get("location")!).searchParams.get("code")!;

const exchange = (
  clientId: string,
  code: string,
  verifier: string,
  redirectUri = CALLBACK,
) =>
  request(
    "/oauth/token",
    form({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  );

describe("discovery documents", () => {
  it("serves protected resource metadata naming the MCP URL and this server as issuer", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const body = (await (await request(path)).json()) as Record<string, any>;
      expect(body.resource).toBe("https://site.example/mcp");
      expect(body.authorization_servers).toEqual(["https://site.example"]);
    }
  });

  it("advertises PKCE S256, public clients and dynamic registration", async () => {
    const body = (await (
      await request("/.well-known/oauth-authorization-server")
    ).json()) as Record<string, any>;

    expect(body.issuer).toBe("https://site.example");
    expect(body.registration_endpoint).toBe(
      "https://site.example/oauth/register",
    );
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.grant_types_supported).toContain("refresh_token");
  });
});

describe("POST /oauth/register", () => {
  it("registers a client with the Claude callback", async () => {
    const { res, body } = await register();

    expect(res.status).toBe(201);
    expect(body.client_id).toBeTruthy();
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  it("accepts a loopback redirect for native clients", async () => {
    const { res } = await register(["http://localhost:3118/callback"]);
    expect(res.status).toBe(201);
  });

  it("rejects an arbitrary redirect URI", async () => {
    const { res, body } = await register(["https://evil.example/callback"]);

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("rejects a missing or non-JSON body", async () => {
    const res = await request("/oauth/register", {
      method: "POST",
      body: "nope",
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /oauth/authorize", () => {
  it("shows the sign-in page naming the client and where it will return", async () => {
    const { body: client } = await register();
    const res = await request(
      `/oauth/authorize?${authorizeQuery(client.client_id, pkce().challenge)}`,
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Authorize Claude");
    expect(html).toContain("claude.ai");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("escapes the client name it displays", async () => {
    const res = await request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "<script>alert(1)</script>",
        redirect_uris: [CALLBACK],
      }),
    });
    const { client_id } = (await res.json()) as { client_id: string };

    const html = await (
      await request(
        `/oauth/authorize?${authorizeQuery(client_id, pkce().challenge)}`,
      )
    ).text();

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows an error, without redirecting, for an unknown client", async () => {
    const res = await request(
      `/oauth/authorize?${authorizeQuery("nope", pkce().challenge)}`,
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("shows an error, without redirecting, for an unregistered redirect URI", async () => {
    const { body: client } = await register();
    const res = await request(
      `/oauth/authorize?${authorizeQuery(client.client_id, pkce().challenge, {
        redirect_uri: "https://evil.example/cb",
      })}`,
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects back with invalid_request when PKCE is missing", async () => {
    const { body: client } = await register();
    const res = await request(
      `/oauth/authorize?${authorizeQuery(client.client_id, "")}`,
    );

    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe("xyz");
  });
});

describe("POST /oauth/authorize", () => {
  it("redirects back with a code and the original state after a correct sign-in", async () => {
    const { res } = await signIn();

    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("xyz");
  });

  it("re-shows the page with 401 for a wrong password, issuing no code", async () => {
    const { res } = await signIn({ password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("Incorrect email or password");
  });

  it("answers an unknown email exactly like a wrong password", async () => {
    const { res } = await signIn({ email: "nobody@example.com" });

    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Incorrect email or password");
  });

  it("redirects back with access_denied when the user declines", async () => {
    const { res } = await signIn({ action: "deny", password: "" });

    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("locks an account out of this page after repeated failures", async () => {
    const email = "locked@example.com";
    for (let i = 0; i < 10; i++) await signIn({ email, password: "bad" });

    const { res } = await signIn({ email, password: "bad" });
    expect(res.status).toBe(429);
  });
});

describe("POST /oauth/token — authorization_code", () => {
  it("exchanges a code for tokens that authenticate against the MCP verifier", async () => {
    const { res, client, verifier } = await signIn();
    const tokenRes = await exchange(client.client_id, codeFrom(res), verifier);
    const tokens = (await tokenRes.json()) as Record<string, any>;

    expect(tokenRes.status).toBe(200);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");

    const probe = await protectedApp.handle(
      new Request("http://localhost/probe", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    const body = (await probe.json()) as { data: Record<string, unknown> };

    expect(probe.status).toBe(200);
    expect(body.data.name).toBe("Claude");
    expect(body.data.kind).toBe("oauth");
    expect(body.data.createdBy).toBe("admin1");
  });

  it("burns the code after one use", async () => {
    const { res, client, verifier } = await signIn();
    const code = codeFrom(res);

    expect((await exchange(client.client_id, code, verifier)).status).toBe(200);

    const again = await exchange(client.client_id, code, verifier);
    expect(again.status).toBe(400);
    expect(((await again.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects a wrong PKCE verifier and burns the code anyway", async () => {
    const { res, client, verifier } = await signIn();
    const code = codeFrom(res);

    const bad = await exchange(client.client_id, code, "x".repeat(64));
    expect(((await bad.json()) as any).error).toBe("invalid_grant");

    expect((await exchange(client.client_id, code, verifier)).status).toBe(400);
  });

  it("rejects a redirect_uri that differs from the authorization request", async () => {
    const { res, client, verifier } = await signIn();
    const bad = await exchange(
      client.client_id,
      codeFrom(res),
      verifier,
      "http://localhost:9/other",
    );

    expect(((await bad.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects a code presented by a different client", async () => {
    const { res, verifier } = await signIn();
    const { body: other } = await register();
    const bad = await exchange(other.client_id, codeFrom(res), verifier);

    expect(((await bad.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects an expired code", async () => {
    const { res, client, verifier } = await signIn();
    const code = codeFrom(res);
    const id = new RecordId(
      "oauth_code",
      createHash("sha256").update(code).digest("hex"),
    );
    await db.update(id).merge({ expiresAt: "2000-01-01T00:00:00.000Z" });

    const bad = await exchange(client.client_id, code, verifier);
    expect(((await bad.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects an unknown client and an unsupported grant type", async () => {
    const unknown = await request(
      "/oauth/token",
      form({ grant_type: "authorization_code", client_id: "nope" }),
    );
    expect(unknown.status).toBe(401);

    const { body: client } = await register();
    const unsupported = await request(
      "/oauth/token",
      form({ grant_type: "client_credentials", client_id: client.client_id }),
    );
    expect(((await unsupported.json()) as any).error).toBe(
      "unsupported_grant_type",
    );
  });
});

describe("POST /oauth/token — refresh_token", () => {
  const connect = async () => {
    const { res, client, verifier } = await signIn();
    const tokens = (await (
      await exchange(client.client_id, codeFrom(res), verifier)
    ).json()) as Record<string, string>;
    return { client, tokens };
  };

  const refresh = (clientId: string, token: string) =>
    request(
      "/oauth/token",
      form({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: token,
      }),
    );

  it("rotates: returns a new pair and kills the old refresh token", async () => {
    const { client, tokens } = await connect();

    const first = await refresh(client.client_id, tokens.refresh_token!);
    expect(first.status).toBe(200);
    const next = (await first.json()) as Record<string, string>;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);

    const replay = await refresh(client.client_id, tokens.refresh_token!);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects a refresh from another client", async () => {
    const { tokens } = await connect();
    const { body: other } = await register();
    const res = await refresh(other.client_id, tokens.refresh_token!);

    expect(((await res.json()) as any).error).toBe("invalid_grant");
  });
});

describe("POST /oauth/revoke", () => {
  it("revokes the connection so the access token stops working", async () => {
    const { res, client, verifier } = await signIn();
    const tokens = (await (
      await exchange(client.client_id, codeFrom(res), verifier)
    ).json()) as Record<string, string>;

    const revoke = await request(
      "/oauth/revoke",
      form({ token: tokens.access_token! }),
    );
    expect(revoke.status).toBe(200);

    const probe = await protectedApp.handle(
      new Request("http://localhost/probe", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    expect(probe.status).toBe(401);
  });

  it("answers 200 even for a token that never existed", async () => {
    const res = await request(
      "/oauth/revoke",
      form({ token: "mcp:nope:nope" }),
    );
    expect(res.status).toBe(200);
  });
});

describe("pruning", () => {
  it("drops abandoned clients and expired codes when a new client registers", async () => {
    const stale = await db.create(new Table("oauth_client")).content({
      clientName: "Stale",
      redirectUris: [CALLBACK],
      used: false,
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    const staleId = (stale as any)[0].id as RecordId;

    await register();

    expect(await db.select(staleId)).toBeUndefined();
  });
});
