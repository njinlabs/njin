import { randomBytes } from "node:crypto";
import moment from "moment";
import { compile, type Permissions } from "../core/access";
import type { Row } from "../core/db/contract";
import { tokenTable } from "../core/db/internal";
import { hashToken, tokenMatches } from "../core/token_hash";
import type userModel from "../models/user";
import db from "./db";

// Every credential njin hands out lives in one table (core/db/internal.ts) and is resolved the
// same way, whatever it was issued for:
//
//   session  an admin signing in with a password; carries the user's full permissions
//   pat      a personal access token made on purpose for a script or agent; narrowed to `scopes`
//   oauth    what an MCP client gets after the user approves it; narrowed to `scopes`
//
// A bearer is "njt:<id>:<secret>" (refresh tokens, only for oauth, "njr:<id>:<secret>"). Only a
// hash of the secret is stored. Permissions are not copied into the token: they are worked out
// from the user's groups on every request, so taking a permission away takes effect at once.

export const ACCESS_PREFIX = "njt";
export const REFRESH_PREFIX = "njr";

const SESSION_TTL_DAYS = 30;
const WEB_TTL_DAYS = 7;
const OAUTH_ACCESS_TTL_SECONDS = 60 * 60;
const OAUTH_REFRESH_TTL_DAYS = 30;
// `lastUsedAt` (and a session's expiry, which slides with use) is rewritten at most this often,
// so reading with a token does not mean writing on every request.
const TOUCH_EVERY_SECONDS = 60;

export type TokenKind = "session" | "pat" | "oauth" | "web";

const KINDS: ReadonlySet<string> = new Set<TokenKind>([
  "session",
  "pat",
  "oauth",
  "web",
]);

// What an Authorization header may carry. A "web" token is the cookie of the OAuth sign-in page
// and is read by that page alone.
const DELEGABLE: readonly TokenKind[] = ["session", "pat", "oauth"];

// Where a token is being used. "any" is the content API; "session" is for managing users,
// groups and tokens, which a delegated token must never reach (otherwise a leaked agent token
// could mint its own replacement); "mcp" is the agent endpoint, which a session never uses.
export type Surface = "any" | "session" | "mcp";

export const allowedOn = (kind: TokenKind, surface: Surface) => {
  if (kind === "web") return false;
  if (surface === "session") return kind === "session";
  if (surface === "mcp") return kind !== "session";
  return true;
};

export type TokenRecord = {
  id: string;
  kind: TokenKind;
  hash: string;
  name: string | null;
  clientId: string | null;
  consent: string | null;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  refreshHash: string | null;
  refreshExpiresAt: string | null;
  createdAt: string | null;
};

const text = (value: unknown) => (typeof value === "string" ? value : null);

const texts = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A row that is not a well-formed token is no token at all.
const toRecord = (row: Row): TokenRecord | null => {
  const hash = text(row.hash);
  const kind = text(row.kind);
  if (!hash || !kind || !KINDS.has(kind)) return null;

  return {
    id: row.id,
    kind: kind as TokenKind,
    hash,
    name: text(row.name),
    clientId: text(row.clientId),
    // Not populated, so a link is its bare id (a populated one would be an object).
    consent: text(row.consent),
    scopes: texts(row.scopes),
    expiresAt: text(row.expiresAt),
    lastUsedAt: text(row.lastUsedAt),
    refreshHash: text(row.refreshHash),
    refreshExpiresAt: text(row.refreshExpiresAt),
    createdAt: text(row.createdAt),
  };
};

const isPast = (iso: string | null) => iso !== null && moment().isAfter(iso);

const newSecret = () => randomBytes(32).toString("base64url");

// Wrong prefix, wrong number of parts or an empty part: not one of ours, so no lookup is made.
const parseBearer = (value: string | undefined, prefix: string) => {
  if (!value) return null;

  const [head, id, secret, ...rest] = value.split(":");
  if (head !== prefix || !id || !secret || rest.length > 0) return null;

  return { id, secret };
};

const accessExpiry = (kind: TokenKind) => {
  if (kind === "session") {
    return moment().add(SESSION_TTL_DAYS, "days").toISOString();
  }
  if (kind === "web") {
    return moment().add(WEB_TTL_DAYS, "days").toISOString();
  }
  if (kind === "oauth") {
    return moment().add(OAUTH_ACCESS_TTL_SECONDS, "seconds").toISOString();
  }
  return null;
};

const refreshExpiry = () =>
  moment().add(OAUTH_REFRESH_TTL_DAYS, "days").toISOString();

export type NewToken = {
  user: string;
  kind: TokenKind;
  name?: string;
  clientId?: string;
  consent?: string;
  // "<resource>:<action>" entries (wildcards allowed); ignored for a session.
  scopes?: string[];
};

export type IssuedToken = {
  id: string;
  bearer: string;
  refresh: string | null;
  expiresAt: string | null;
};

export const issueToken = async (input: NewToken): Promise<IssuedToken> => {
  const access = newSecret();
  const refresh = input.kind === "oauth" ? newSecret() : null;
  const now = moment().toISOString();
  const expiresAt = accessExpiry(input.kind);

  const row = await db().insert(tokenTable, {
    user: input.user,
    kind: input.kind,
    hash: hashToken(access),
    scopes: input.scopes ?? [],
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
    ...(input.name ? { name: input.name } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.consent ? { consent: input.consent } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(refresh
      ? { refreshHash: hashToken(refresh), refreshExpiresAt: refreshExpiry() }
      : {}),
  });

  return {
    id: row.id,
    bearer: `${ACCESS_PREFIX}:${row.id}:${access}`,
    refresh: refresh ? `${REFRESH_PREFIX}:${row.id}:${refresh}` : null,
    expiresAt,
  };
};

// RFC 6749 §5.1.
const oauthResponse = (issued: IssuedToken & { refresh: string }) => ({
  access_token: issued.bearer,
  token_type: "Bearer" as const,
  expires_in: OAUTH_ACCESS_TTL_SECONDS,
  refresh_token: issued.refresh,
});

// Called by oauth.ts once an authorization code has been redeemed.
export const issueOAuthTokens = async (input: {
  name: string;
  clientId: string;
  userId: string;
  scopes: string[];
  consent?: string;
}) => {
  const issued = await issueToken({
    user: input.userId,
    kind: "oauth",
    name: input.name,
    clientId: input.clientId,
    scopes: input.scopes,
    consent: input.consent,
  });

  if (!issued.refresh) {
    throw new Error("An oauth token is always issued with a refresh token");
  }

  return oauthResponse({ ...issued, refresh: issued.refresh });
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

  const found = await db().find(tokenTable, parsed.id);
  const token = found ? toRecord(found) : null;

  if (
    token?.kind !== "oauth" ||
    token.clientId !== clientId ||
    !token.refreshHash ||
    !tokenMatches(token.refreshHash, parsed.secret) ||
    isPast(token.refreshExpiresAt)
  ) {
    return null;
  }

  const access = newSecret();
  const refresh = newSecret();

  await db().update(tokenTable, token.id, {
    hash: hashToken(access),
    expiresAt: accessExpiry("oauth"),
    lastUsedAt: moment().toISOString(),
    refreshHash: hashToken(refresh),
    refreshExpiresAt: refreshExpiry(),
  });

  return oauthResponse({
    id: token.id,
    bearer: `${ACCESS_PREFIX}:${token.id}:${access}`,
    refresh: `${REFRESH_PREFIX}:${token.id}:${refresh}`,
    expiresAt: null,
  });
};

// RFC 7009 — accepts either half of an oauth token; deleting the record kills both at once.
export const revokeOAuthToken = async (bearerValue: string) => {
  for (const prefix of [ACCESS_PREFIX, REFRESH_PREFIX]) {
    const parsed = parseBearer(bearerValue, prefix);
    if (!parsed) continue;

    const found = await db().find(tokenTable, parsed.id);
    const token = found ? toRecord(found) : null;
    if (token?.kind !== "oauth") return;

    const expected = prefix === ACCESS_PREFIX ? token.hash : token.refreshHash;
    if (expected && tokenMatches(expected, parsed.secret)) {
      await db().remove(tokenTable, token.id);
    }
    return;
  }
};

export type AccountUser = Omit<
  Awaited<ReturnType<typeof userModel.create>>,
  "password"
>;

const toAccount = (value: unknown): AccountUser | null => {
  if (!isRecord(value)) return null;

  const { password: _password, ...rest } = value;
  return rest as unknown as AccountUser;
};

const touch = async (token: TokenRecord) => {
  if (
    token.lastUsedAt &&
    moment().diff(token.lastUsedAt, "seconds") < TOUCH_EVERY_SECONDS
  ) {
    return;
  }

  await db().update(tokenTable, token.id, {
    lastUsedAt: moment().toISOString(),
    // A session stays alive for as long as it is used.
    ...(token.kind === "session" || token.kind === "web"
      ? { expiresAt: accessExpiry(token.kind) }
      : {}),
  });
};

// The grants of every access group a user is in. A group that no longer exists is left behind as
// a bare id on adapters that do not enforce links, and is skipped.
const grantsOf = async (userId: string) => {
  const { default: user } = await import("../models/user");
  const row = await db().find(user.def, userId, { populate: ["groups"] });

  const groups = Array.isArray(row?.groups) ? row.groups : [];
  return groups.flatMap((group) =>
    isRecord(group) ? texts(group.grants) : [],
  );
};

export type Principal = {
  user: AccountUser;
  kind: TokenKind;
  token: { id: string; name: string | null; clientId: string | null };
  permissions: Permissions;
};

// The credential in an Authorization header, or null when it is not valid: unknown, wrong
// secret, expired, or its user is gone.
export const resolveBearer = async (
  bearerValue: string | undefined,
  accepts: readonly TokenKind[] = DELEGABLE,
): Promise<Principal | null> => {
  const parsed = parseBearer(bearerValue, ACCESS_PREFIX);
  if (!parsed) return null;

  const found = await db().find(tokenTable, parsed.id, { populate: ["user"] });
  const token = found ? toRecord(found) : null;
  if (!found || !token) return null;

  if (
    !accepts.includes(token.kind) ||
    !tokenMatches(token.hash, parsed.secret) ||
    isPast(token.expiresAt)
  ) {
    return null;
  }

  // A token whose user was deleted is just a bad credential (the link is then a bare id, or
  // null where the database clears links to deleted rows — not a record).
  const user = toAccount(found.user);
  if (!user) return null;

  await touch(token);

  return {
    user,
    kind: token.kind,
    token: { id: token.id, name: token.name, clientId: token.clientId },
    permissions: compile(
      await grantsOf(user.id),
      // A sign-in is the user themselves, like a session; only a delegated token is narrowed.
      token.kind === "session" || token.kind === "web" ? null : token.scopes,
    ),
  };
};

// What a listing shows of a token. Never the hashes: they are all that stands between a
// database read and a usable token.
export const toPublic = (token: TokenRecord) => ({
  id: token.id,
  name: token.name,
  kind: token.kind,
  clientId: token.clientId,
  scopes: token.scopes,
  createdAt: token.createdAt,
  expiresAt: token.expiresAt,
  lastUsedAt: token.lastUsedAt,
});

export const listTokens = async (userId: string) => {
  const { rows } = await db().list(tokenTable, {
    where: [{ field: "user", op: "$eq", value: userId }],
    page: 1,
    limit: 1000,
    sort: { field: "createdAt", order: "desc" },
    populate: [],
  });

  // The sign-in cookie of the OAuth pages is not a credential to manage.
  return rows.flatMap((row) => {
    const token = toRecord(row);
    return token && token.kind !== "web" ? [token] : [];
  });
};

// Only the user's own: someone else's token is "not found", not "forbidden".
export const findOwnToken = async (userId: string, tokenId: string) => {
  const found = await db().find(tokenTable, tokenId);
  if (!found || text(found.user) !== userId) return null;

  return toRecord(found);
};

export const removeToken = async (tokenId: string) => {
  await db().remove(tokenTable, tokenId);
};
