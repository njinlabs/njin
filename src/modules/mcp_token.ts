import { randomBytes, timingSafeEqual } from "node:crypto";
import bearer from "@elysia/bearer";
import Elysia, { status } from "elysia";
import moment from "moment";
import { RecordId, Table } from "surrealdb";
import z from "zod";
import { makeModule } from "../core/module";
import { publicBase } from "../core/public_url";
import auth from "./auth";
import elysia from "./elysia";
import surreal from "./surreal";

const table = new Table("mcp_token");

// Bearer prefixes, not just cosmetic — a session token ("token:<id>:<plain>") fed to an
// MCP-only route (or the reverse) fails the prefix check before any DB lookup happens, and an
// access token can't be replayed as a refresh token (or vice versa).
const ACCESS_PREFIX = "mcp";
const REFRESH_PREFIX = "mcpr";

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_DAYS = 30;

// One record per agent connection. "manual" tokens are minted by an admin through
// POST /api/mcp-token (no expiry); "oauth" ones are issued by the OAuth flow in oauth.ts to a
// specific user + client, expire quickly, and renew through a rotating refresh token that
// lives on the same record — so listing/revoking connections is one table for both kinds.
type McpToken = {
  id: RecordId;
  name: string;
  hash: string;
  createdAt: string;
  createdBy: RecordId;
  kind?: "manual" | "oauth";
  expiresAt?: string;
  refreshHash?: string;
  refreshExpiresAt?: string;
  clientId?: string;
};

const newSecret = () => randomBytes(32).toString("base64url");

const hashSecret = (plain: string) =>
  new Bun.CryptoHasher("sha256").update(plain).digest("hex");

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
};

const parseBearer = (value: string | undefined, prefix: string) => {
  if (!value) return null;

  const [head, id, secret, ...rest] = value.split(":");
  if (head !== prefix || !id || !secret || rest.length > 0) return null;

  return { id, secret };
};

const isPast = (iso: string | undefined) =>
  iso !== undefined && moment().isAfter(iso);

// Never leaks `hash`/`refreshHash` — they are the only thing standing between a DB read and a
// usable token.
const toPublic = ({
  id,
  name,
  createdAt,
  createdBy,
  kind,
  expiresAt,
  clientId,
}: McpToken) => ({
  id: id.id.toString(),
  name,
  kind: kind ?? "manual",
  createdAt,
  createdBy: createdBy?.id?.toString() ?? null,
  expiresAt: expiresAt ?? null,
  clientId: clientId ?? null,
});

const verifyToken = async (bearerValue: string | undefined) => {
  const parsed = parseBearer(bearerValue, ACCESS_PREFIX);
  if (!parsed) return null;

  const token = await surreal().select<McpToken>(
    new RecordId(table, parsed.id),
  );
  if (!token) return null;

  if (!safeEqual(token.hash, hashSecret(parsed.secret))) return null;
  if (isPast(token.expiresAt)) return null;

  return token;
};

const tokenResponse = (id: string, access: string, refresh: string) => ({
  access_token: `${ACCESS_PREFIX}:${id}:${access}`,
  token_type: "Bearer" as const,
  expires_in: ACCESS_TTL_SECONDS,
  refresh_token: `${REFRESH_PREFIX}:${id}:${refresh}`,
});

const accessExpiry = () =>
  moment().add(ACCESS_TTL_SECONDS, "seconds").toISOString();
const refreshExpiry = () =>
  moment().add(REFRESH_TTL_DAYS, "days").toISOString();

// Called by oauth.ts once an authorization code has been redeemed.
export const issueOAuthTokens = async (input: {
  name: string;
  clientId: string;
  userId: RecordId;
}) => {
  const access = newSecret();
  const refresh = newSecret();

  const [created] = await surreal()
    .create<McpToken>(table)
    .content({
      name: input.name,
      kind: "oauth",
      clientId: input.clientId,
      createdBy: input.userId as unknown as McpToken["createdBy"],
      createdAt: moment().toISOString(),
      hash: hashSecret(access),
      expiresAt: accessExpiry(),
      refreshHash: hashSecret(refresh),
      refreshExpiresAt: refreshExpiry(),
    });

  return tokenResponse(created!.id.id.toString(), access, refresh);
};

// Refresh-token rotation: the presented token is replaced in place, so it can never be used
// twice. Returns null for any reason the grant is unusable (unknown, wrong client, expired,
// already rotated) — the caller reports all of them as OAuth `invalid_grant`.
export const rotateOAuthTokens = async (
  refreshBearer: string,
  clientId: string,
) => {
  const parsed = parseBearer(refreshBearer, REFRESH_PREFIX);
  if (!parsed) return null;

  const id = new RecordId(table, parsed.id);
  const token = await surreal().select<McpToken>(id);

  if (
    token?.kind !== "oauth" ||
    token.clientId !== clientId ||
    !token.refreshHash ||
    !safeEqual(token.refreshHash, hashSecret(parsed.secret)) ||
    isPast(token.refreshExpiresAt)
  ) {
    return null;
  }

  const access = newSecret();
  const refresh = newSecret();

  await surreal()
    .update<McpToken>(id)
    .merge({
      hash: hashSecret(access),
      expiresAt: accessExpiry(),
      refreshHash: hashSecret(refresh),
      refreshExpiresAt: refreshExpiry(),
    });

  return tokenResponse(parsed.id, access, refresh);
};

// RFC 7009 — accepts either token type; deleting the record kills both halves at once.
export const revokeOAuthToken = async (bearerValue: string) => {
  for (const prefix of [ACCESS_PREFIX, REFRESH_PREFIX]) {
    const parsed = parseBearer(bearerValue, prefix);
    if (!parsed) continue;

    const id = new RecordId(table, parsed.id);
    const token = await surreal().select<McpToken>(id);
    if (!token) return;

    const expected = prefix === ACCESS_PREFIX ? token.hash : token.refreshHash;
    if (expected && safeEqual(expected, hashSecret(parsed.secret))) {
      await surreal().delete(id);
    }
    return;
  }
};

// Dedicated credential for AI agents (MCP) — deliberately a separate table and bearer
// format from the admin session token in auth.ts, so an MCP token can never satisfy the
// `auth: true` macro (and with it the whole /api/* admin surface), and a leaked MCP token
// is revoked by deleting one record without touching anybody's login session.
const mcpToken = makeModule(() => {
  const fn = async () => {
    const plugin = new Elysia({ name: "mcp-auth" }).use(bearer()).macro({
      mcpAuth: {
        resolve: async ({ bearer, request, set }) => {
          const token = await verifyToken(bearer);

          if (!token) {
            // RFC 9728 — this header is how an MCP client discovers the OAuth flow; without
            // it (and a real 401 status) Claude never starts sign-in.
            set.headers["www-authenticate"] =
              `Bearer resource_metadata="${publicBase(request)}/.well-known/oauth-protected-resource"`;

            return status(401, { message: "Unauthorized" });
          }

          return { mcpToken: toPublic(token) };
        },
      },
    });

    return { plugin };
  };

  fn.init = async () => {
    const authPlugin = (await auth()).plugin;

    // Managed with a regular admin session (`auth: true`), never with an MCP token itself —
    // otherwise a leaked agent token could mint itself a replacement after being revoked.
    const controller = new Elysia({ prefix: "/api/mcp-token" })
      .use(authPlugin)
      .get(
        "/",
        async () => {
          const tokens = await surreal().select<McpToken>(table);

          return {
            data: tokens
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map(toPublic),
          };
        },
        { auth: true },
      )
      .post(
        "/",
        async ({ body, user }) => {
          const plain = newSecret();

          const [created] = await surreal()
            .create<McpToken>(table)
            .content({
              name: body.name,
              kind: "manual",
              hash: hashSecret(plain),
              createdAt: moment().toISOString(),
              createdBy: user.id as unknown as McpToken["createdBy"],
            });

          return {
            data: {
              ...toPublic(created!),
              // Returned exactly once — only the hash is stored, so it can't be shown again.
              token: `${ACCESS_PREFIX}:${created!.id.id}:${plain}`,
            },
          };
        },
        {
          auth: true,
          body: z.object({ name: z.string().trim().min(1).max(100) }),
        },
      )
      .delete(
        "/:id",
        async ({ params }) => {
          const id = new RecordId(table, params.id);
          const existing = await surreal().select<McpToken>(id);

          if (!existing) {
            return status(404, { message: "Token not found" });
          }

          await surreal().delete(id);

          return { data: toPublic(existing) };
        },
        { auth: true, params: z.object({ id: z.coerce.string() }) },
      );

    elysia().use(controller);

    return {};
  };

  return fn;
});

export default mcpToken;
