import {
  beforeAll,
  describe,
  expect,
  it,
  mock,
  setDefaultTimeout,
} from "bun:test";
import { createHash } from "node:crypto";
import Elysia from "elysia";
import {
  oauthClientTable,
  oauthCodeTable,
  oauthConsentTable,
  tokenTable,
} from "../../src/core/db/internal";
import * as realConfig from "../../src/core/runtime/config";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeElysia } from "../helpers/fake_elysia";
import { useTestDb } from "../helpers/test_db";

// Every sign-in hashes a password (argon2), and the lockout tests make a dozen of them.
setDefaultTimeout(30_000);

// Real in-memory database rather than a hand-rolled fake — the OAuth flow leans on id-keyed
// creates, merges and conditional deletes, which a fake would only echo back.
const db = await useTestDb();

mock.module("../../src/core/runtime/config", () => ({
  ...realConfig,
  getConfig: () => ({
    publicUrl: "https://site.example",
    models: [],
    vars: [],
    permissions: [],
    mcp: {
      redirectUris: [
        "https://app.example/cb",
        "https://client.example/connectors/*",
      ],
    },
  }),
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const { default: userModel } = await import("../../src/models/user");
const { default: accessGroup } = await import("../../src/models/access_group");
const { default: oauth } = await import("../../src/modules/oauth");
const { default: oauthConsent } = await import(
  "../../src/modules/oauth_consent"
);
const { default: auth } = await import("../../src/modules/auth");
const { issueToken } = await import("../../src/modules/token");

await db.sync([userModel.def, accessGroup.def]);
await oauth.init();
await oauthConsent.init();
await auth.init();
const app = fakeElysia.buildApp();

// A real auth-protected route, so a token coming out of the OAuth flow is proven against
// the actual verifier rather than just inspected.
const { plugin: authPlugin } = await auth();
const protectedApp = new Elysia().use(authPlugin).get(
  "/probe",
  ({ principal }) => ({
    data: {
      name: principal.token.name,
      kind: principal.kind,
      createdBy: principal.user.id,
    },
  }),
  { auth: { mcp: true } },
);

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const PASSWORD = "correct-horse";
const EMAIL = "admin@example.com";

beforeAll(async () => {
  const everything = await accessGroup.create({
    name: "Full access",
    grants: ["*:*:all"],
  });

  await db.adapter.insert(
    userModel.def,
    {
      name: "Admin",
      email: EMAIL,
      password: Bun.password.hashSync(PASSWORD),
      groups: [everything.id],
    },
    { id: "admin1" },
  );
});

const request = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost${path}`, init));

const form = (
  values: Record<string, string> | [string, string][],
  headers: Record<string, string> = {},
) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(
    Array.isArray(values) ? values : Object.entries(values),
  ).toString(),
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

const authorizeQuery = (
  clientId: string,
  challenge: string,
  extra: Record<string, string> = {},
) =>
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    ...extra,
  }).toString();

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const login = (
  values: { email?: string; password?: string } = {},
  headers: Record<string, string> = {},
) =>
  request(
    "/api/auth/login",
    json(
      {
        email: values.email ?? EMAIL,
        password: values.password ?? PASSWORD,
      },
      headers,
    ),
  );

const dataOf = async (res: Response) =>
  ((await res.clone().json()) as { data: Record<string, any> }).data;

// The session token the admin holds once someone has signed in there.
const sessionToken = async (
  values: { email?: string; password?: string } = {},
) => (await dataOf(await login(values))).token as string;

const asUser = (token?: string): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

// What the admin's authorize page asks first: may this client have this, and what could it get?
const authorizePage = (query: string, token?: string) =>
  request(`/api/oauth/authorize?${query}`, { headers: asUser(token) });

// ...and what it sends once the user has chosen.
const decide = (
  query: string,
  token: string | undefined,
  decision: { action: string; grant?: string[] },
) =>
  request(
    "/api/oauth/authorize",
    json(
      { ...Object.fromEntries(new URLSearchParams(query)), ...decision },
      asUser(token),
    ),
  );

// An answer that sends the client back (`data.redirect`) as the browser would see it: a redirect.
// Any other answer is passed through untouched.
const followed = async (res: Response) => {
  const redirect =
    res.status === 200 ? ((await dataOf(res)).redirect as string) : undefined;

  return redirect
    ? new Response(null, { status: 303, headers: { location: redirect } })
    : res;
};

// What the client would be allowed, as the page lists it.
const offeredBy = async (res: Response) =>
  ((await dataOf(res)).scopes ?? []) as string[];

// Runs register, the admin's sign-in and the authorize page and returns what the client would
// have in hand when the browser lands back on its callback. A failed sign-in stops there.
const signIn = async (
  overrides: {
    email?: string;
    password?: string;
    action?: string;
    scope?: string;
    redirectUri?: string;
    token?: string;
    grant?: string[];
  } = {},
) => {
  const redirectUri = overrides.redirectUri ?? CALLBACK;
  const { body: client } = await register([redirectUri]);
  const { verifier, challenge } = pkce();
  const query = authorizeQuery(client.client_id, challenge, {
    redirect_uri: redirectUri,
    ...(overrides.scope ? { scope: overrides.scope } : {}),
  });

  let token = overrides.token;
  if (!token) {
    const signedIn = await login({
      email: overrides.email,
      password: overrides.password,
    });
    if (signedIn.status !== 200) {
      return { res: signedIn, client, verifier, challenge, query, token: "" };
    }
    token = (await dataOf(signedIn)).token as string;
  }

  const page = await authorizePage(query, token);
  if (page.status !== 200) {
    return { res: page, client, verifier, challenge, query, token };
  }

  const res = await followed(
    await decide(query, token, {
      action: overrides.action ?? "approve",
      grant: overrides.grant ?? (await offeredBy(page)),
    }),
  );

  return { res, client, verifier, challenge, query, token };
};

const codeFrom = (res: Response) =>
  new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";

const exchange = (
  clientId: string,
  code: string,
  verifier: string,
  redirectUri = CALLBACK,
  extra: Record<string, string> = {},
) =>
  request(
    "/oauth/token",
    form({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      ...extra,
    }),
  );

const connect = async (overrides: Parameters<typeof signIn>[0] = {}) => {
  const flow = await signIn(overrides);
  const tokens = (await (
    await exchange(
      flow.client.client_id,
      codeFrom(flow.res),
      flow.verifier,
      overrides.redirectUri,
    )
  ).json()) as Record<string, string>;
  return { ...flow, tokens };
};

const probe = (bearer: string) =>
  protectedApp.handle(
    new Request("http://localhost/probe", {
      headers: { Authorization: `Bearer ${bearer}` },
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

  it("advertises the scopes a client can ask for, and that responses carry the issuer", async () => {
    const body = (await (
      await request("/.well-known/oauth-authorization-server")
    ).json()) as Record<string, any>;

    expect(body.authorization_response_iss_parameter_supported).toBe(true);
    expect(body.scopes_supported).toContain("*:*");
    expect(body.scopes_supported).toContain("user:read");
    expect(body.scopes_supported).toContain("analytics:read");
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

describe("GET /api/oauth/authorize", () => {
  const signedIn = async (extra: Record<string, string> = {}) => {
    const { body: client } = await register();
    const query = authorizeQuery(client.client_id, pkce().challenge, extra);
    return { query, token: await sessionToken(), client };
  };

  it("needs a session", async () => {
    const { body: client } = await register();
    const query = authorizeQuery(client.client_id, pkce().challenge);

    expect((await authorizePage(query)).status).toBe(401);
    expect((await authorizePage(query, "njt:nope:nope")).status).toBe(401);
  });

  it("does not take a personal token for a session", async () => {
    const { query } = await signedIn();
    const pat = await issueToken({
      user: "admin1",
      kind: "pat",
      scopes: ["*:*"],
    });

    expect((await authorizePage(query, pat.bearer)).status).toBe(401);
  });

  it("does not take a session that has ended", async () => {
    const { query, token } = await signedIn();
    await db.adapter.update(tokenTable, token.split(":")[1] ?? "", {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    expect((await authorizePage(query, token)).status).toBe(401);
  });

  it("says who is asking, where the code goes and what the client could be allowed", async () => {
    const { query, token, client } = await signedIn();
    const res = await authorizePage(query, token);
    const data = await dataOf(res);

    expect(res.status).toBe(200);
    expect(data.client).toEqual({ id: client.client_id, name: "Claude" });
    expect(data.host).toBe("claude.ai");
    expect(data.redirect).toBeUndefined();
    expect(data.scopes).toContain("user:read");
    expect(data.scopes).toContain("analytics:read");
    // a reference to someone else's record is not something to hand out
    expect(
      (data.scopes as string[]).every((g) => g.split(":").length === 2),
    ).toBe(true);
  });

  it("offers only what was asked for, within what the user can do", async () => {
    const { query, token } = await signedIn({
      scope: "user:read analytics:read nonsense ghost:read",
    });

    expect((await offeredBy(await authorizePage(query, token))).sort()).toEqual(
      ["analytics:read", "user:read"],
    );
  });

  it("takes a wildcard in the request to mean everything it covers", async () => {
    const { query, token } = await signedIn({ scope: "*:read" });
    const scopes = await offeredBy(await authorizePage(query, token));

    expect(scopes.length).toBeGreaterThan(2);
    expect(scopes.every((g) => g.endsWith(":read"))).toBe(true);
  });

  it("offers nothing to a user who can do nothing", async () => {
    await db.adapter.insert(
      userModel.def,
      {
        name: "Nobody",
        email: "nobody-can@example.com",
        password: Bun.password.hashSync(PASSWORD),
      },
      { id: "powerless1" },
    );
    const { body: client } = await register();
    const query = authorizeQuery(client.client_id, pkce().challenge);
    const token = await sessionToken({ email: "nobody-can@example.com" });

    expect(await offeredBy(await authorizePage(query, token))).toEqual([]);
  });

  it("refuses, without a redirect, an unknown client", async () => {
    const res = await authorizePage(
      authorizeQuery("nope", pkce().challenge),
      await sessionToken(),
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(((await res.json()) as { message: string }).message).toBe(
      "Unknown client.",
    );
  });

  it("refuses, without a redirect, an unregistered redirect URI", async () => {
    const { body: client } = await register();
    const res = await authorizePage(
      authorizeQuery(client.client_id, pkce().challenge, {
        redirect_uri: "https://evil.example/cb",
      }),
      await sessionToken(),
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(JSON.stringify(await res.json())).not.toContain("evil.example/cb?");
  });

  it("sends invalid_request back to the client when PKCE is missing", async () => {
    const { body: client } = await register();
    const res = await authorizePage(
      authorizeQuery(client.client_id, ""),
      await sessionToken(),
    );

    const location = new URL((await dataOf(res)).redirect);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("iss")).toBe("https://site.example");
  });

  it("sends invalid_target back for a resource that is not this site's", async () => {
    const { body: client } = await register();
    const res = await authorizePage(
      authorizeQuery(client.client_id, pkce().challenge, {
        resource: "https://elsewhere.example/mcp",
      }),
      await sessionToken(),
    );

    expect(
      new URL((await dataOf(res)).redirect).searchParams.get("error"),
    ).toBe("invalid_target");
  });

  it("accepts the MCP endpoint, or the site, as the resource", async () => {
    const { body: client } = await register();
    const token = await sessionToken();

    for (const resource of [
      "https://site.example/mcp",
      "https://site.example/mcp/",
      "https://site.example",
    ]) {
      const res = await authorizePage(
        authorizeQuery(client.client_id, pkce().challenge, { resource }),
        token,
      );
      expect(res.status).toBe(200);
      expect((await dataOf(res)).redirect).toBeUndefined();
    }
  });
});

describe("POST /api/oauth/authorize", () => {
  it("answers with a redirect carrying a code, the original state and the issuer", async () => {
    const { res } = await signIn();

    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("iss")).toBe("https://site.example");
  });

  it("answers with access_denied when the user declines", async () => {
    const { res } = await signIn({ action: "deny" });

    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
    expect(location.searchParams.get("iss")).toBe("https://site.example");
  });

  it("issues no code for a wrong password", async () => {
    const { res } = await signIn({ password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("needs a session", async () => {
    const { query } = await signIn({ action: "deny" });

    const res = await decide(query, undefined, {
      action: "approve",
      grant: ["user:read"],
    });

    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("code=");
  });

  it("does not take a personal token for a session", async () => {
    const { query } = await signIn({ action: "deny" });
    const pat = await issueToken({
      user: "admin1",
      kind: "pat",
      scopes: ["*:*"],
    });

    const res = await decide(query, pat.bearer, {
      action: "approve",
      grant: ["user:read"],
    });

    expect(res.status).toBe(401);
  });

  it("refuses a request that is not valid, before issuing anything", async () => {
    const token = await sessionToken();
    const { query } = await signIn({ action: "deny", token });

    expect((await decide(query, token, { action: "maybe" })).status).toBe(422);

    const unknown = await decide("client_id=nope&redirect_uri=x", token, {
      action: "approve",
      grant: ["user:read"],
    });
    expect(unknown.status).toBe(400);
  });

  describe("what is allowed", () => {
    const consented = async (overrides: Parameters<typeof signIn>[0] = {}) => {
      const flow = await signIn(overrides);
      const code = codeFrom(flow.res);
      const stored = await db.adapter.find(
        oauthCodeTable,
        createHash("sha256").update(code).digest("hex"),
      );
      return { ...flow, code, scopes: stored?.scopes };
    };

    it("is everything, as a wildcard, when all was asked for and all was allowed", async () => {
      expect((await consented()).scopes).toEqual(["*:*"]);
    });

    it("is what was ticked, when the user took some away", async () => {
      const { scopes } = await consented({ grant: ["user:read"] });

      expect(scopes).toEqual(["user:read"]);
    });

    it("is what was asked for, when the client asked for specifics", async () => {
      const { scopes } = await consented({
        scope: "user:read analytics:read",
      });

      expect((scopes as string[]).sort()).toEqual([
        "analytics:read",
        "user:read",
      ]);
    });

    it("never goes beyond what the user can do, or what was offered", async () => {
      const { scopes } = await consented({
        scope: "user:read",
        grant: ["user:read", "user:delete", "ghost:read"],
      });

      expect(scopes).toEqual(["user:read"]);
    });

    it("needs at least one thing allowed", async () => {
      const flow = await signIn({ grant: [] });

      expect(flow.res.status).toBe(400);
      expect(flow.res.headers.get("location")).toBeNull();
      expect(
        ((await flow.res.json()) as { message: string }).message,
      ).toContain("Choose at least one");
    });
  });

  it("remembers what the user approved, to list under connected apps", async () => {
    const { client } = await signIn({
      grant: ["user:read"],
      scope: "user:read",
    });

    const { rows } = await db.adapter.list(oauthConsentTable, {
      where: [{ field: "clientId", op: "$eq", value: client.client_id }],
      page: 1,
      limit: 10,
      populate: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.user).toBe("admin1");
    expect(rows[0]?.clientName).toBe("Claude");
    expect(rows[0]?.scopes).toEqual(["user:read"]);
  });
});

describe("approving again", () => {
  // One client, one browser: the user comes back to the same app.
  const comeBack = async (scope?: string) => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const query = authorizeQuery(client.client_id, challenge, {
      ...(scope ? { scope } : {}),
    });
    const token = await sessionToken();
    const first = await authorizePage(query, token);
    await decide(query, token, {
      action: "approve",
      grant: await offeredBy(first),
    });

    return { client, challenge, verifier, token };
  };

  it("does not ask again for something already approved", async () => {
    const { client, token } = await comeBack();

    const again = await followed(
      await authorizePage(
        authorizeQuery(client.client_id, pkce().challenge, {
          state: "second",
        }),
        token,
      ),
    );

    expect(again.status).toBe(303);
    const location = new URL(again.headers.get("location") ?? "");
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("second");
  });

  it("still asks when the client wants to be asked", async () => {
    const { client, token } = await comeBack();

    const again = await authorizePage(
      authorizeQuery(client.client_id, pkce().challenge, {
        prompt: "consent",
      }),
      token,
    );

    expect((await dataOf(again)).redirect).toBeUndefined();
    expect((await dataOf(again)).scopes.length).toBeGreaterThan(0);
  });

  it("asks when the client now wants more than was approved", async () => {
    const { client, token } = await comeBack("user:read");

    const wider = await authorizePage(
      authorizeQuery(client.client_id, pkce().challenge, {
        scope: "user:read user:delete",
      }),
      token,
    );
    expect((await dataOf(wider)).redirect).toBeUndefined();

    const same = await authorizePage(
      authorizeQuery(client.client_id, pkce().challenge, {
        scope: "user:read",
      }),
      token,
    );
    expect((await dataOf(same)).redirect).toBeTruthy();
  });

  it("gives the new code only what was asked for this time", async () => {
    const { client, token } = await comeBack();
    const { verifier, challenge } = pkce();

    const again = await followed(
      await authorizePage(
        authorizeQuery(client.client_id, challenge, { scope: "user:read" }),
        token,
      ),
    );
    const tokens = (await (
      await exchange(client.client_id, codeFrom(again), verifier)
    ).json()) as Record<string, string>;

    const stored = await db.adapter.find(
      tokenTable,
      (tokens.access_token ?? "").split(":")[1] ?? "",
    );
    expect(stored?.scopes).toEqual(["user:read"]);
  });
});

describe("what the site no longer serves", () => {
  it("has no sign-in or consent pages of its own", async () => {
    for (const [method, path] of [
      ["GET", "/oauth/authorize"],
      ["POST", "/oauth/authorize"],
      ["POST", "/oauth/login"],
      ["POST", "/oauth/logout"],
    ] as const) {
      expect((await request(path, { method })).status).toBe(404);
    }
  });

  it("sends clients to the admin's authorize page", async () => {
    const body = (await (
      await request("/.well-known/oauth-authorization-server")
    ).json()) as Record<string, any>;

    expect(body.authorization_endpoint).toBe(
      "https://site.example/_admin/oauth/authorize",
    );
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

    const response = await probe(tokens.access_token);
    const body = (await response.json()) as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data.name).toBe("Claude");
    expect(body.data.kind).toBe("oauth");
    expect(body.data.createdBy).toBe("admin1");
  });

  it("gives the token the scopes that were approved, and ties it to the approval", async () => {
    const { tokens, client } = await connect({
      grant: ["user:read"],
      scope: "user:read",
    });

    const stored = await db.adapter.find(
      tokenTable,
      (tokens.access_token ?? "").split(":")[1] ?? "",
    );
    expect(stored?.scopes).toEqual(["user:read"]);

    const { rows } = await db.adapter.list(oauthConsentTable, {
      where: [{ field: "clientId", op: "$eq", value: client.client_id }],
      page: 1,
      limit: 1,
      populate: [],
    });
    expect(stored?.consent).toBe(rows[0]?.id);
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
    const id = createHash("sha256").update(code).digest("hex");
    await db.adapter.update(oauthCodeTable, id, {
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

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

  it("rejects a resource that is not this site's", async () => {
    const { res, client, verifier } = await signIn();
    const bad = await exchange(
      client.client_id,
      codeFrom(res),
      verifier,
      CALLBACK,
      { resource: "https://elsewhere.example/mcp" },
    );

    expect(((await bad.json()) as any).error).toBe("invalid_target");
  });
});

describe("POST /oauth/token — refresh_token", () => {
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

    const first = await refresh(client.client_id, tokens.refresh_token ?? "");
    expect(first.status).toBe(200);
    const next = (await first.json()) as Record<string, string>;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);

    const replay = await refresh(client.client_id, tokens.refresh_token ?? "");
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects a refresh from another client", async () => {
    const { tokens } = await connect();
    const { body: other } = await register();
    const res = await refresh(other.client_id, tokens.refresh_token ?? "");

    expect(((await res.json()) as any).error).toBe("invalid_grant");
  });
});

describe("POST /oauth/revoke", () => {
  it("revokes the connection so the access token stops working", async () => {
    const { tokens } = await connect();

    const revoke = await request(
      "/oauth/revoke",
      form({ token: tokens.access_token ?? "" }),
    );
    expect(revoke.status).toBe(200);

    expect((await probe(tokens.access_token ?? "")).status).toBe(401);
  });

  it("answers 200 even for a token that never existed", async () => {
    const res = await request(
      "/oauth/revoke",
      form({ token: "njt:nope:nope" }),
    );
    expect(res.status).toBe(200);
  });
});

describe("connected apps", () => {
  type Connected = {
    id: string;
    clientName: string;
    scopes: string[];
    tokens: number;
    lastUsedAt: string | null;
  };

  const api = async (
    path: string,
    bearer: string,
    init: { method?: string; body?: unknown } = {},
  ) =>
    request(`/api/oauth/consents${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

  const sessionOf = async (user: string) =>
    (await issueToken({ user, kind: "session" })).bearer;

  const listed = async (bearer: string) =>
    ((await (await api("", bearer)).json()) as { data: Connected[] }).data;

  it("lists what the user connected, how much it may do and how many tokens it holds", async () => {
    const { client, tokens } = await connect({
      grant: ["user:read", "analytics:read"],
      scope: "user:read analytics:read",
    });
    await request(
      "/oauth/token",
      form({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: tokens.refresh_token ?? "",
      }),
    );

    const mine = (await listed(await sessionOf("admin1"))).find(
      (c) => c.clientName === "Claude" && c.scopes.includes("analytics:read"),
    );

    expect(mine?.scopes.sort()).toEqual(["analytics:read", "user:read"]);
    expect(mine?.tokens).toBe(1);
    expect(mine?.lastUsedAt).toBeTruthy();
  });

  it("lists only the user's own", async () => {
    await connect();
    await db.adapter.insert(
      userModel.def,
      {
        name: "Second",
        email: "second@example.com",
        password: "x",
      },
      { id: "second1" },
    );

    expect(await listed(await sessionOf("second1"))).toEqual([]);
  });

  it("narrows an app, and what it already holds shrinks with it", async () => {
    const { tokens } = await connect({
      grant: ["user:read", "analytics:read"],
      scope: "user:read analytics:read",
    });
    const session = await sessionOf("admin1");
    const mine = (await listed(session)).find((c) =>
      c.scopes.includes("analytics:read"),
    );

    const res = await api(`/${mine?.id}`, session, {
      method: "PUT",
      body: { scopes: ["user:read"] },
    });

    expect(res.status).toBe(200);
    const stored = await db.adapter.find(
      tokenTable,
      (tokens.access_token ?? "").split(":")[1] ?? "",
    );
    expect(stored?.scopes).toEqual(["user:read"]);
  });

  it("will not widen an app", async () => {
    await connect({ grant: ["user:read"], scope: "user:read" });
    const session = await sessionOf("admin1");
    const mine = (await listed(session)).find(
      (c) => c.scopes.length === 1 && c.scopes[0] === "user:read",
    );

    const res = await api(`/${mine?.id}`, session, {
      method: "PUT",
      body: { scopes: ["user:read", "user:delete"] },
    });

    expect(res.status).toBe(422);
  });

  it("takes an app away, and its tokens with it", async () => {
    const { tokens } = await connect({
      grant: ["analytics:read"],
      scope: "analytics:read",
    });
    const session = await sessionOf("admin1");
    const mine = (await listed(session)).find(
      (c) => c.scopes.length === 1 && c.scopes[0] === "analytics:read",
    );
    expect((await probe(tokens.access_token ?? "")).status).toBe(200);

    const res = await api(`/${mine?.id}`, session, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect((await probe(tokens.access_token ?? "")).status).toBe(401);
    expect(await db.adapter.find(oauthConsentTable, mine?.id ?? "")).toBeNull();
  });

  it("answers 404 for an app that is not the caller's", async () => {
    await connect();
    const mine = (await listed(await sessionOf("admin1")))[0];
    const other = await sessionOf("second1");

    for (const method of ["PUT", "DELETE"]) {
      const res = await api(`/${mine?.id}`, other, {
        method,
        body: method === "PUT" ? { scopes: ["user:read"] } : undefined,
      });
      expect(res.status).toBe(404);
    }
  });

  it("is closed to the apps themselves", async () => {
    const { tokens } = await connect();
    const personal = (await issueToken({ user: "admin1", kind: "pat" })).bearer;

    for (const bearer of [tokens.access_token ?? "", personal]) {
      expect((await api("", bearer)).status).toBe(401);
    }
    expect((await api("", "")).status).toBe(401);
  });
});

describe("pruning", () => {
  it("drops abandoned clients and expired codes when a new client registers", async () => {
    const stale = await db.adapter.insert(oauthClientTable, {
      clientName: "Stale",
      redirectUris: [CALLBACK],
      used: false,
      createdAt: "2000-01-01T00:00:00.000Z",
    });

    await register();

    expect(await db.adapter.find(oauthClientTable, stale.id)).toBeNull();
  });
});

describe("redirect URI allowlist", () => {
  const registers = async (uri: string) => (await register([uri])).res.status;

  it("accepts the other built-in client callbacks", async () => {
    for (const uri of [
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector/oauth/abc123",
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "https://vscode.dev/redirect",
      "https://insiders.vscode.dev/redirect",
      "http://127.0.0.1:33418/",
      "http://localhost:7777/oauth/callback",
    ]) {
      expect(await registers(uri)).toBe(201);
    }
  });

  it("accepts callbacks added in config, exact or by prefix", async () => {
    expect(await registers("https://app.example/cb")).toBe(201);
    expect(await registers("https://client.example/connectors/9f2")).toBe(201);
  });

  it("does not let an exact config entry match a different path", async () => {
    expect(await registers("https://app.example/other")).toBe(400);
    expect(await registers("https://app.example/cb/extra")).toBe(400);
  });

  it("rejects look-alike hosts, userinfo and scheme changes", async () => {
    for (const uri of [
      "https://chatgpt.com.evil.example/connector/oauth/x",
      "https://evil.example/connector/oauth/x",
      "https://chatgpt.com@evil.example/connector/oauth/x",
      "https://user@chatgpt.com/connector/oauth/x",
      "http://chatgpt.com/connector/oauth/x",
      "https://chatgpt.com:8443/connector/oauth/x",
      "cursor://evil.example/oauth/callback",
      "cursor://anysphere.cursor-mcp/other",
      "https://claude.ai/api/mcp/auth_callback#frag",
    ]) {
      expect(await registers(uri)).toBe(400);
    }
  });

  it("does not let .. segments escape a path prefix", async () => {
    expect(
      await registers("https://chatgpt.com/connector/oauth/../../evil"),
    ).toBe(400);
    expect(
      await registers("https://chatgpt.com/connector/oauth/%2e%2e/evil"),
    ).toBe(400);
  });

  it("rejects a non-loopback http callback and arbitrary schemes", async () => {
    expect(await registers("http://example.com/cb")).toBe(400);
    expect(await registers("javascript:alert(1)")).toBe(400);
    expect(await registers("file:///etc/passwd")).toBe(400);
  });

  it("completes a sign-in for a custom-scheme client and returns to it", async () => {
    const cursor = "cursor://anysphere.cursor-mcp/oauth/callback";
    const flow = await signIn({ redirectUri: cursor });

    expect(flow.res.status).toBe(303);
    expect(flow.res.headers.get("location")).toStartWith(`${cursor}?`);

    const tokens = await exchange(
      flow.client.client_id,
      codeFrom(flow.res),
      flow.verifier,
      cursor,
    );
    expect(tokens.status).toBe(200);
  });

  it("names the host the code goes to", async () => {
    const cursor = "cursor://anysphere.cursor-mcp/oauth/callback";
    const { body: client } = await register([cursor]);

    const data = await dataOf(
      await authorizePage(
        authorizeQuery(client.client_id, pkce().challenge, {
          redirect_uri: cursor,
        }),
        await sessionToken(),
      ),
    );
    expect(data.host).toBe("anysphere.cursor-mcp");
  });
});

describe("authorize request validation", () => {
  it("rejects a response_type other than code", async () => {
    const { body: client } = await register();
    const res = await authorizePage(
      authorizeQuery(client.client_id, pkce().challenge, {
        response_type: "token",
      }),
      await sessionToken(),
    );

    expect(
      new URL((await dataOf(res)).redirect).searchParams.get("error"),
    ).toBe("unsupported_response_type");
  });

  it("ignores a malformed redirect URI instead of crashing", async () => {
    const { res } = await register(["not a url"]);
    expect(res.status).toBe(400);
  });

  it("lets a loopback client use a different port but not a different path", async () => {
    const { body: client } = await register(["http://127.0.0.1:3118/callback"]);
    const { challenge } = pkce();
    const token = await sessionToken();

    const otherPort = await authorizePage(
      authorizeQuery(client.client_id, challenge, {
        redirect_uri: "http://127.0.0.1:49152/callback",
      }),
      token,
    );
    expect(otherPort.status).toBe(200);

    const otherPath = await authorizePage(
      authorizeQuery(client.client_id, challenge, {
        redirect_uri: "http://127.0.0.1:3118/elsewhere",
      }),
      token,
    );
    expect(otherPath.status).toBe(400);

    const otherHost = await authorizePage(
      authorizeQuery(client.client_id, challenge, {
        redirect_uri: "http://localhost:3118/callback",
      }),
      token,
    );
    expect(otherHost.status).toBe(400);
  });
});
