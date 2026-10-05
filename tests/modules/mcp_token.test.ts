import { describe, expect, it, mock } from "bun:test";
import Elysia from "elysia";
import { RecordId, type Table } from "surrealdb";
import * as realConfig from "../../src/core/config";
import * as realElysiaModule from "../../src/modules/elysia";
import * as realSurrealModule from "../../src/modules/surreal";
import { makeFakeAuthPlugin } from "../helpers/fake_auth";
import { makeFakeElysia } from "../helpers/fake_elysia";

const tokens = new Map<string, Record<string, unknown>>();

const fakeDb = {
  select: async (target: RecordId | Table) => {
    if (target instanceof RecordId) return tokens.get(String(target)) ?? null;
    return [...tokens.values()];
  },
  create: (table: Table) => ({
    content: async (data: Record<string, unknown>) => {
      const id = new RecordId(table.name, `mcp${tokens.size + 1}`);
      const record = { ...data, id };
      tokens.set(String(id), record);
      return [record];
    },
  }),
  update: (id: RecordId) => ({
    merge: async (data: Record<string, unknown>) => {
      const record = { ...tokens.get(String(id)), ...data };
      tokens.set(String(id), record);
      return record;
    },
  }),
  delete: async (id: RecordId) => {
    tokens.delete(String(id));
    return {};
  },
};

// publicBase() reads config for the 401's resource_metadata pointer.
mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ publicUrl: "https://site.example" }),
}));

// Spreading real exports — without --isolate, mock.module() replaces the module in a
// registry shared across the whole test run, so a partial mock would break other files.
mock.module("../../src/modules/surreal", () => ({
  ...realSurrealModule,
  default: () => fakeDb,
}));

mock.module("../../src/modules/auth", () => ({
  default: async () => ({ plugin: makeFakeAuthPlugin() }),
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const {
  default: mcpToken,
  issueOAuthTokens,
  revokeOAuthToken,
  rotateOAuthTokens,
} = await import("../../src/modules/mcp_token");

await mcpToken.init();
const admin = fakeElysia.buildApp();

// The macro is exercised through a throwaway probe route — it has no route of its own yet.
const { plugin } = await mcpToken();
const probe = new Elysia()
  .use(plugin)
  .get("/probe", ({ mcpToken }) => ({ data: mcpToken }), { mcpAuth: true });

const createToken = async (name = "Claude") => {
  const res = await admin.handle(
    new Request("http://localhost/api/mcp-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  const body = (await res.json()) as { data: Record<string, string> };
  return { res, data: body.data };
};

const callProbe = (bearer?: string) =>
  probe.handle(
    new Request("http://localhost/probe", {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    }),
  );

describe("POST /api/mcp-token", () => {
  it("returns the plain token once and stores only its hash", async () => {
    const { res, data } = await createToken("Claude Desktop");

    expect(res.status).toBe(200);
    expect(data.name).toBe("Claude Desktop");
    expect(data.token).toMatch(/^mcp:mcp\d+:.{40,}$/);
    expect(data.hash).toBeUndefined();

    const stored = tokens.get(String(new RecordId("mcp_token", data.id!)))!;
    const plain = data.token!.split(":")[2]!;
    expect(stored.hash).toBe(
      new Bun.CryptoHasher("sha256").update(plain).digest("hex"),
    );
    expect(JSON.stringify(stored)).not.toContain(plain);
  });

  it("rejects an empty name", async () => {
    const res = await admin.handle(
      new Request("http://localhost/api/mcp-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      }),
    );

    expect(res.status).toBe(422);
  });
});

describe("GET /api/mcp-token", () => {
  it("lists tokens without hash or plain token", async () => {
    await createToken("Listed");
    const res = await admin.handle(
      new Request("http://localhost/api/mcp-token"),
    );
    const body = (await res.json()) as { data: Record<string, unknown>[] };

    expect(res.status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(item.hash).toBeUndefined();
      expect(item.token).toBeUndefined();
    }
  });
});

describe("DELETE /api/mcp-token/:id", () => {
  it("revokes a token so it no longer authenticates", async () => {
    const { data } = await createToken("Revocable");
    expect((await callProbe(data.token)).status).toBe(200);

    const res = await admin.handle(
      new Request(`http://localhost/api/mcp-token/${data.id}`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(200);

    expect((await callProbe(data.token)).status).toBe(401);
  });

  it("returns 404 for an unknown token", async () => {
    const res = await admin.handle(
      new Request("http://localhost/api/mcp-token/nope", { method: "DELETE" }),
    );

    expect(res.status).toBe(404);
  });
});

describe("mcpAuth macro", () => {
  it("passes a valid token and exposes its public fields", async () => {
    const { data } = await createToken("Valid");
    const res = await callProbe(data.token);
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data.name).toBe("Valid");
    expect(body.data.hash).toBeUndefined();
  });

  it("returns 401 without a bearer", async () => {
    expect((await callProbe()).status).toBe(401);
  });

  it("returns 401 for a session-style token (wrong prefix)", async () => {
    const { data } = await createToken("Prefix");
    const [, id, plain] = data.token!.split(":");

    expect((await callProbe(`token:${id}:${plain}`)).status).toBe(401);
  });

  it("returns 401 for an unknown id", async () => {
    expect((await callProbe("mcp:nope:whatever")).status).toBe(401);
  });

  it("returns 401 for a wrong secret", async () => {
    const { data } = await createToken("Wrong");
    const [prefix, id] = data.token!.split(":");

    expect((await callProbe(`${prefix}:${id}:not-the-secret`)).status).toBe(
      401,
    );
  });
});

describe("401 discovery pointer", () => {
  it("tells the client where the OAuth metadata lives", async () => {
    const res = await callProbe();

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://site.example/.well-known/oauth-protected-resource"',
    );
  });
});

describe("OAuth-issued tokens", () => {
  const userId = new RecordId("user", "u1");

  const issue = () =>
    issueOAuthTokens({ name: "Claude", clientId: "client1", userId });

  it("issues an access token that authenticates and a refresh token that does not", async () => {
    const issued = await issue();

    expect(issued.token_type).toBe("Bearer");
    expect(issued.expires_in).toBe(3600);
    expect((await callProbe(issued.access_token)).status).toBe(200);
    expect((await callProbe(issued.refresh_token)).status).toBe(401);
  });

  it("rejects an expired access token", async () => {
    const issued = await issue();
    const id = issued.access_token.split(":")[1]!;
    const key = String(new RecordId("mcp_token", id));
    tokens.set(key, {
      ...tokens.get(key),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    expect((await callProbe(issued.access_token)).status).toBe(401);
  });

  it("rotates the refresh token — the old pair stops working", async () => {
    const first = await issue();
    const second = await rotateOAuthTokens(first.refresh_token, "client1");

    expect(second).not.toBeNull();
    expect((await callProbe(second!.access_token)).status).toBe(200);
    expect((await callProbe(first.access_token)).status).toBe(401);
    expect(await rotateOAuthTokens(first.refresh_token, "client1")).toBeNull();
  });

  it("refuses a refresh from a different client", async () => {
    const issued = await issue();

    expect(await rotateOAuthTokens(issued.refresh_token, "other")).toBeNull();
  });

  it("refuses a refresh token whose lifetime ran out", async () => {
    const issued = await issue();
    const id = issued.refresh_token.split(":")[1]!;
    const key = String(new RecordId("mcp_token", id));
    tokens.set(key, {
      ...tokens.get(key),
      refreshExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    expect(await rotateOAuthTokens(issued.refresh_token, "client1")).toBeNull();
  });

  it("revokes the whole connection from either token", async () => {
    const byAccess = await issue();
    await revokeOAuthToken(byAccess.access_token);
    expect((await callProbe(byAccess.access_token)).status).toBe(401);

    const byRefresh = await issue();
    await revokeOAuthToken(byRefresh.refresh_token);
    expect((await callProbe(byRefresh.access_token)).status).toBe(401);
  });

  it("ignores a revoke with the wrong secret", async () => {
    const issued = await issue();
    const [prefix, id] = issued.access_token.split(":");
    await revokeOAuthToken(`${prefix}:${id}:wrong`);

    expect((await callProbe(issued.access_token)).status).toBe(200);
  });

  it("lists OAuth connections alongside manual tokens", async () => {
    await issue();
    const res = await admin.handle(
      new Request("http://localhost/api/mcp-token"),
    );
    const body = (await res.json()) as { data: { kind: string }[] };

    expect(body.data.some((t) => t.kind === "oauth")).toBe(true);
    expect(body.data.some((t) => t.kind === "manual")).toBe(true);
  });
});
