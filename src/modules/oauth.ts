import { createHash, randomBytes } from "node:crypto";
import Elysia, { status } from "elysia";
import moment from "moment";
import z from "zod";
import { isScope, scopeCovers } from "../core/auth/access";
import { oauthClientTable, oauthCodeTable } from "../core/db/internal";
import { noStore } from "../core/http/html_page";
import { publicBase } from "../core/http/public_url";
import { makeModule } from "../core/module";
import { getConfig } from "../core/runtime/config";
import auth from "./auth";
import db from "./db";
import elysia from "./elysia";
import { getCatalog, getGuard } from "./guard";
import { findConsent, rememberConsent } from "./oauth_consent";
import {
  issueOAuthTokens,
  type Principal,
  revokeOAuthToken,
  rotateOAuthTokens,
} from "./token";

// OAuth 2.1 authorization server for MCP clients (Claude etc.), living in the same process as
// the MCP endpoint. The user signs in with their normal njin account on a page served here (once:
// the sign-in is remembered in a cookie that only these pages read), then says what the client
// may do, and the client gets its own revocable token limited to that — nobody pastes a token
// anywhere. Public clients only (PKCE S256, no client secret), registered through RFC 7591
// dynamic client registration.

const CODE_TTL_MINUTES = 10;
const UNUSED_CLIENT_TTL_HOURS = 24;

// Dynamic registration is open to anyone who can reach the server, so the redirect URI is the
// only thing stopping a rogue client from receiving an authorization code. Only these known
// callbacks, anything in config `mcp.redirectUris`, and loopback addresses (native/dev clients,
// RFC 8252 — Gemini CLI, VS Code and others use these) are accepted. An entry ending in "*" is a
// path prefix. Sources: each vendor's own docs (ChatGPT's callback carries a per-connector id).
const BUILT_IN_REDIRECTS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/connector/oauth/*",
  "cursor://anysphere.cursor-mcp/oauth/callback",
  "https://vscode.dev/redirect",
  "https://insiders.vscode.dev/redirect",
];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const parseUrl = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

// Compares parsed parts, never raw strings: `https://chatgpt.com@evil.com/...` and
// `https://chatgpt.com.evil.com/...` both start with an allowed string but are other hosts, and
// `..` segments are already resolved by URL parsing before the path is compared.
const matchesEntry = (url: URL, entry: string) => {
  const wildcard = entry.endsWith("*");
  const base = parseUrl(wildcard ? entry.slice(0, -1) : entry);
  if (!base) return false;

  if (url.protocol !== base.protocol || url.host !== base.host) return false;

  return wildcard
    ? url.pathname.startsWith(base.pathname)
    : url.pathname === base.pathname && url.search === base.search;
};

const isAllowedRedirectUri = (value: string) => {
  const url = parseUrl(value);
  if (!url || url.hash || url.username || url.password) return false;

  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return true;

  const extra = getConfig().mcp?.redirectUris ?? [];
  return [...BUILT_IN_REDIRECTS, ...extra].some((entry) =>
    matchesEntry(url, entry),
  );
};

// Exact match, except that a loopback client's ephemeral port is ignored (RFC 8252 §7.3) —
// a native app can't know its port at registration time.
const redirectMatches = (requested: string, registered: string[]) => {
  if (registered.includes(requested)) return true;

  const req = parseUrl(requested);
  if (req?.protocol !== "http:" || !LOOPBACK_HOSTS.has(req.hostname)) {
    return false;
  }

  return registered.some((candidate) => {
    const reg = parseUrl(candidate);
    return (
      reg?.protocol === "http:" &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    );
  });
};

type OAuthClient = {
  id: string;
  clientName: string;
  redirectUris: string[];
  // Flipped once any user completes sign-in for it, so abandoned registrations (Claude
  // registers a fresh client per connection attempt) can be pruned without touching real ones.
  used: boolean;
  createdAt: string;
};

type OAuthCode = {
  id: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: string;
};

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...noStore, ...headers },
  });

const oauthError = (
  error: string,
  description: string,
  status = 400,
  headers: HeadersInit = {},
) => json({ error, error_description: description }, status, headers);

type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  // As the client sent it: space-separated "<resource>:<action>" entries, anything else ignored.
  scope: string | null;
  resource: string | null;
};

// What a client asks for when it asks for nothing in particular: everything the user can do.
const ALL = "*:*";

const parseScopes = (raw: string | null) => {
  const scopes = (raw ?? "").split(/\s+/).filter(isScope);
  return scopes.length ? [...new Set(scopes)] : [ALL];
};

// The redirect host is spelled out because that — not the client's self-chosen display
// name — is where the authorization code actually goes (MCP authorization spec).
const hostOf = (uri: string) => parseUrl(uri)?.host ?? uri;

const redirectUrl = (
  redirectUri: string,
  values: Record<string, string | null>,
  issuer: string,
) => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries({ ...values, iss: issuer })) {
    if (value !== null) url.searchParams.set(key, value);
  }

  return url.toString();
};

const hashCode = (code: string) =>
  createHash("sha256").update(code).digest("hex");

const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

const readForm = async (request: Request) =>
  new URLSearchParams(await request.text());

const pruneExpired = async () => {
  await db().removeWhere(oauthCodeTable, [
    { field: "expiresAt", op: "$lt", value: moment().toISOString() },
  ]);
  await db().removeWhere(oauthClientTable, [
    { field: "used", op: "$eq", value: false },
    {
      field: "createdAt",
      op: "$lt",
      value: moment().subtract(UNUSED_CLIENT_TTL_HOURS, "hours").toISOString(),
    },
  ]);
};

const oauth = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const guard = await getGuard();
    const catalog = await getCatalog();

    // Every "<resource>:<action>" a client could be given.
    const everyScope = catalog.flatMap((entry) =>
      entry.actions.map((action) => `${entry.resource}:${action}`),
    );

    // The part of those that this user can actually do themselves — a reference to a record is
    // not something to hand out.
    const grantable = (principal: Principal) =>
      everyScope.filter((scope) => {
        const [resource = "", action = ""] = scope.split(":");
        const level = guard.can(principal, resource, action);
        return level !== false && level !== "ref";
      });

    const resourceMetadata = ({ request }: { request: Request }) => {
      const base = publicBase(request);

      return json({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ["header"],
        resource_name: "njin",
      });
    };

    const lookupClient = async (clientId: string) =>
      clientId
        ? (((await db().find(
            oauthClientTable,
            clientId,
          )) as OAuthClient | null) ?? null)
        : null;

    // RFC 8707: a client may name the resource it wants a token for, and the only one here is
    // the MCP endpoint (the site itself is accepted as a spelling of it).
    const isOurResource = (resource: string, base: string) =>
      [base, `${base}/mcp`].includes(resource.replace(/\/+$/, ""));

    // Shared by GET (what the page shows) and POST (the decision): resolves the client and
    // validates the request. A bad client_id or redirect_uri is an error for the admin page to show
    // and is never redirected to — redirecting to an unvalidated URI would turn this endpoint into
    // an open redirector. Anything else wrong with the request goes back to the client.
    const resolveAuthorize = async (values: URLSearchParams, base: string) => {
      const clientId = values.get("client_id") ?? "";
      const redirectUri = values.get("redirect_uri") ?? "";

      const client = await lookupClient(clientId);
      if (!client) return { error: "Unknown client." };
      if (!redirectMatches(redirectUri, client.redirectUris)) {
        return { error: "The redirect address is not registered." };
      }

      const state = values.get("state");
      const reject = (error: string, description: string) => ({
        redirect: redirectUrl(
          redirectUri,
          { error, error_description: description, state },
          base,
        ),
      });

      if (values.get("response_type") !== "code") {
        return reject("unsupported_response_type", "Only code is supported.");
      }

      const codeChallenge = values.get("code_challenge") ?? "";
      const method = values.get("code_challenge_method") ?? "S256";
      if (!codeChallenge || method !== "S256") {
        return reject("invalid_request", "PKCE with S256 is required.");
      }

      const resource = values.get("resource");
      if (resource && !isOurResource(resource, base)) {
        return reject("invalid_target", "Unknown resource.");
      }

      return {
        client,
        params: {
          clientId,
          redirectUri,
          codeChallenge,
          state,
          scope: values.get("scope"),
          resource,
        } satisfies AuthorizeParams,
      };
    };

    const issueCode = async (
      client: OAuthClient,
      params: AuthorizeParams,
      userId: string,
      scopes: string[],
    ) => {
      const code = randomBytes(32).toString("base64url");

      // The record id is the code's hash, so redeeming is a direct lookup and the plain
      // code never touches the DB.
      await db().insert(
        oauthCodeTable,
        {
          clientId: params.clientId,
          userId,
          redirectUri: params.redirectUri,
          codeChallenge: params.codeChallenge,
          scopes,
          expiresAt: moment().add(CODE_TTL_MINUTES, "minutes").toISOString(),
        },
        { id: hashCode(code) },
      );

      await db().update(oauthClientTable, client.id, { used: true });

      return code;
    };

    const controller = new Elysia()
      .use((await auth()).plugin)
      .get("/.well-known/oauth-protected-resource", resourceMetadata)
      .get("/.well-known/oauth-protected-resource/mcp", resourceMetadata)
      .get("/.well-known/oauth-authorization-server", ({ request }) => {
        const base = publicBase(request);

        return json({
          issuer: base,
          authorization_endpoint: `${base}/_admin/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
          revocation_endpoint: `${base}/oauth/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          revocation_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
          scopes_supported: [ALL, ...everyScope],
        });
      })
      .post(
        "/oauth/register",
        async ({ request }) => {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return oauthError("invalid_client_metadata", "Body must be JSON.");
          }

          const { redirect_uris, client_name } = (body ?? {}) as {
            redirect_uris?: unknown;
            client_name?: unknown;
          };

          if (
            !Array.isArray(redirect_uris) ||
            redirect_uris.length === 0 ||
            redirect_uris.length > 10 ||
            !redirect_uris.every(
              (uri) => typeof uri === "string" && isAllowedRedirectUri(uri),
            )
          ) {
            return oauthError(
              "invalid_redirect_uri",
              "redirect_uris must be a known client callback or a loopback address (extra callbacks go in config mcp.redirectUris).",
            );
          }

          const clientName =
            typeof client_name === "string" && client_name.trim()
              ? client_name.trim().slice(0, 100)
              : "Unknown client";

          await pruneExpired();

          const created = await db().insert(oauthClientTable, {
            clientName,
            redirectUris: redirect_uris as string[],
            used: false,
            createdAt: moment().toISOString(),
          });

          return json(
            {
              client_id: created.id,
              client_name: clientName,
              redirect_uris,
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              client_id_issued_at: moment().unix(),
            },
            201,
          );
        },
        { parse: "none" },
      )
      .get(
        "/api/oauth/authorize",
        async ({ request, principal }) => {
          const base = publicBase(request);
          const url = new URL(request.url);
          const resolved = await resolveAuthorize(url.searchParams, base);
          if ("error" in resolved) {
            return status(400, { message: resolved.error });
          }
          if ("redirect" in resolved) return { data: resolved };

          const { client, params } = resolved;
          const wanted = parseScopes(params.scope);

          // Approved before, and for at least this much: no need to ask again — unless the client
          // asked to be asked (`prompt=consent`).
          const earlier = await findConsent(principal.user.id, client.id);
          if (
            earlier &&
            url.searchParams.get("prompt") !== "consent" &&
            scopeCovers(earlier.scopes, wanted)
          ) {
            const code = await issueCode(
              client,
              params,
              principal.user.id,
              wanted,
            );
            await rememberConsent({
              userId: principal.user.id,
              clientId: client.id,
              clientName: client.clientName,
              scopes: wanted,
            });

            return {
              data: {
                redirect: redirectUrl(
                  params.redirectUri,
                  { code, state: params.state },
                  base,
                ),
              },
            };
          }

          return {
            data: {
              client: { id: client.id, name: client.clientName },
              host: hostOf(params.redirectUri),
              scopes: grantable(principal).filter((scope) =>
                scopeCovers(wanted, [scope]),
              ),
            },
          };
        },
        { auth: { session: true } },
      )
      .post(
        "/api/oauth/authorize",
        async ({ request, body, principal }) => {
          const base = publicBase(request);
          const { action, grant, ...rest } = body;

          const values = new URLSearchParams();
          for (const [key, value] of Object.entries(rest)) {
            if (typeof value === "string") values.set(key, value);
          }

          const resolved = await resolveAuthorize(values, base);
          if ("error" in resolved) {
            return status(400, { message: resolved.error });
          }
          if ("redirect" in resolved) return { data: resolved };

          const { client, params } = resolved;

          if (action === "deny") {
            return {
              data: {
                redirect: redirectUrl(
                  params.redirectUri,
                  { error: "access_denied", state: params.state },
                  base,
                ),
              },
            };
          }

          const wanted = parseScopes(params.scope);
          const offered = grantable(principal).filter((scope) =>
            scopeCovers(wanted, [scope]),
          );

          // Only what was offered: a scope the page never showed is ignored.
          const granted = grant.filter((scope) => offered.includes(scope));

          if (granted.length === 0) {
            return status(400, {
              message: "Choose at least one thing to allow, or deny.",
            });
          }

          // Kept as "everything" when that is what was asked for and all of it was allowed, so
          // what the user can do later (a new model, say) is covered too.
          const scopes =
            wanted.includes(ALL) && granted.length === offered.length
              ? [ALL]
              : [...new Set(granted)];

          await rememberConsent({
            userId: principal.user.id,
            clientId: client.id,
            clientName: client.clientName,
            scopes,
          });

          const code = await issueCode(
            client,
            params,
            principal.user.id,
            scopes,
          );

          return {
            data: {
              redirect: redirectUrl(
                params.redirectUri,
                { code, state: params.state },
                base,
              ),
            },
          };
        },
        {
          auth: { session: true },
          body: z.looseObject({
            action: z.enum(["approve", "deny"]),
            grant: z.array(z.string()).default([]),
          }),
        },
      )
      .post(
        "/oauth/token",
        async ({ request }) => {
          const base = publicBase(request);
          const values = await readForm(request);
          const grantType = values.get("grant_type");
          const clientId = values.get("client_id") ?? "";

          const client = await lookupClient(clientId);
          if (!client) {
            return oauthError("invalid_client", "Unknown client.", 401);
          }

          const resource = values.get("resource");
          if (resource && !isOurResource(resource, base)) {
            return oauthError("invalid_target", "Unknown resource.");
          }

          if (grantType === "refresh_token") {
            const tokens = await rotateOAuthTokens(
              values.get("refresh_token") ?? "",
              clientId,
            );

            return tokens
              ? json(tokens)
              : oauthError("invalid_grant", "Refresh token is not valid.");
          }

          if (grantType !== "authorization_code") {
            return oauthError(
              "unsupported_grant_type",
              "Use authorization_code or refresh_token.",
            );
          }

          const code = values.get("code") ?? "";
          const verifier = values.get("code_verifier") ?? "";
          const id = hashCode(code);

          const record = code
            ? ((await db().find(oauthCodeTable, id)) as OAuthCode | null)
            : null;
          if (!record) {
            return oauthError("invalid_grant", "Code is not valid.");
          }

          // Single use, burned before any other check: a code that fails PKCE or redirect
          // verification is dead too, so it can't be retried with guessed verifiers.
          await db().remove(oauthCodeTable, id);

          const challengeMatches =
            verifier.length >= 43 &&
            verifier.length <= 128 &&
            pkceChallenge(verifier) === record.codeChallenge;

          if (
            moment().isAfter(record.expiresAt) ||
            record.clientId !== clientId ||
            record.redirectUri !== values.get("redirect_uri") ||
            !challengeMatches
          ) {
            return oauthError("invalid_grant", "Code is not valid.");
          }

          // The connection is listed (and can be taken away) under what the user approved.
          const consent = await findConsent(record.userId, clientId);

          return json(
            await issueOAuthTokens({
              name: client.clientName,
              clientId,
              userId: record.userId,
              scopes: Array.isArray(record.scopes) ? record.scopes : [],
              consent: consent?.id,
            }),
          );
        },
        { parse: "none" },
      )
      .post(
        "/oauth/revoke",
        async ({ request }) => {
          const values = await readForm(request);
          const token = values.get("token");

          if (token) await revokeOAuthToken(token);

          // RFC 7009: always 200, so a caller can't probe which tokens exist.
          return json({});
        },
        { parse: "none" },
      );

    elysia().use(controller);

    return {};
  };

  return fn;
});

export default oauth;
