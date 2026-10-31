import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Elysia from "elysia";
import moment from "moment";
import { isScope, scopeCovers } from "../core/access";
import { getConfig } from "../core/config";
import {
  oauthClientTable,
  oauthCodeTable,
  tokenTable,
} from "../core/db/internal";
import { escapeHtml, noStore, page } from "../core/html_page";
import { makeModule } from "../core/module";
import { publicBase } from "../core/public_url";
import { clearFailures, isLimited, recordFailure } from "../core/rate_limit";
import db from "./db";
import elysia from "./elysia";
import { getCatalog, getGuard } from "./guard";
import { findConsent, rememberConsent } from "./oauth_consent";
import {
  issueOAuthTokens,
  issueToken,
  type Principal,
  removeToken,
  resolveBearer,
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

// The cookie of the sign-in page. Path-limited and HttpOnly, so nothing but these pages (and no
// script) ever sees it, and it is a "web" token, which no API accepts.
const COOKIE = "njin_web";
const COOKIE_PATH = "/oauth";

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

const errorPage = (message: string, status = 400) =>
  page(
    "Cannot authorize",
    `<h1>Cannot authorize</h1><p>${escapeHtml(message)}</p>`,
    status,
  );

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

const VERBS: Record<string, string> = {
  read: "Read",
  create: "Create",
  update: "Edit",
  delete: "Delete",
  publish: "Publish",
  write: "Change",
};

const describeScope = (scope: string) => {
  const [resource = "", action = ""] = scope.split(":");
  const what = resource.startsWith("vars.")
    ? `the “${resource.slice(5)}” settings`
    : resource;

  return `${VERBS[action] ?? action} ${what}`;
};

const hidden = (name: string, value: string | null) =>
  value === null
    ? ""
    : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

// The redirect host is spelled out because that — not the client's self-chosen display
// name — is where the authorization code actually goes (MCP authorization spec).
const hostOf = (uri: string) => parseUrl(uri)?.host ?? uri;

const loginPage = (
  client: OAuthClient,
  params: AuthorizeParams,
  returnTo: string,
  error?: string,
  status = 200,
) =>
  page(
    "Sign in",
    `<h1>Sign in</h1>
<p><strong>${escapeHtml(client.clientName)}</strong> wants to connect to this site. Sign in to choose what it may do. It will return to <span class="host">${escapeHtml(hostOf(params.redirectUri))}</span>.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/oauth/login">
${hidden("return", returnTo)}
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<div class="row">
<button type="submit" class="primary">Sign in</button>
</div>
</form>`,
    status,
  );

const consentPage = (input: {
  client: OAuthClient;
  params: AuthorizeParams;
  returnTo: string;
  email: string;
  offered: string[];
  csrf: string;
  error?: string;
  status?: number;
}) => {
  const { client, params, offered } = input;

  // One group per resource, in the order the user's permissions come in.
  const groups = new Map<string, string[]>();
  for (const scope of offered) {
    const resource = scope.split(":")[0] ?? scope;
    groups.set(resource, [...(groups.get(resource) ?? []), scope]);
  }

  const choices = [...groups.values()]
    .map((scopes) =>
      scopes
        .map(
          (scope) =>
            `<label class="scope"><input type="checkbox" name="grant" value="${escapeHtml(scope)}" checked> <span>${escapeHtml(describeScope(scope))}</span></label>`,
        )
        .join("\n"),
    )
    .join("\n");

  return page(
    "Authorize access",
    `<h1>Authorize ${escapeHtml(client.clientName)}</h1>
<p><strong>${escapeHtml(client.clientName)}</strong> wants to act on this site as you. It will return to <span class="host">${escapeHtml(hostOf(params.redirectUri))}</span>.</p>
${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${hidden("client_id", params.clientId)}
${hidden("redirect_uri", params.redirectUri)}
${hidden("code_challenge", params.codeChallenge)}
${hidden("state", params.state)}
${hidden("scope", params.scope)}
${hidden("resource", params.resource)}
${hidden("csrf", input.csrf)}
${
  offered.length
    ? `<p>It will be able to:</p>
<div class="scopes">
${choices}
</div>`
    : "<p>Your account has nothing this client could be given.</p>"
}
<div class="row">
<!-- Allow must come first in the markup: pressing Enter in a field submits with the form's
first submit button, and that must never be Deny. CSS puts Deny back on the left. -->
${offered.length ? '<button type="submit" name="action" value="approve" class="primary">Allow</button>' : ""}
<button type="submit" name="action" value="deny" formnovalidate>Deny</button>
</div>
</form>
<form method="post" action="/oauth/logout" class="who">
${hidden("return", input.returnTo)}
Signed in as ${escapeHtml(input.email)}. <button type="submit">Not you?</button>
</form>`,
    input.status ?? 200,
  );
};

const redirectWith = (
  redirectUri: string,
  values: Record<string, string | null>,
  issuer: string,
) => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries({ ...values, iss: issuer })) {
    if (value !== null) url.searchParams.set(key, value);
  }

  return new Response(null, {
    status: 303,
    headers: { Location: url.toString(), ...noStore },
  });
};

const hashCode = (code: string) =>
  createHash("sha256").update(code).digest("hex");

const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

const readForm = async (request: Request) =>
  new URLSearchParams(await request.text());

const cookieOf = (request: Request, name: string) => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
};

const setCookie = (value: string, maxAgeSeconds: number, base: string) =>
  `${COOKIE}=${value}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${base.startsWith("https://") ? "; Secure" : ""}`;

const WEB_COOKIE_SECONDS = 7 * 24 * 60 * 60;

// Tied to the sign-in, so a form posted from another site (which has no such cookie, and could
// not guess this) is refused.
const csrfOf = (bearer: string) =>
  createHash("sha256")
    .update(`csrf:${bearer.split(":")[2] ?? ""}`)
    .digest("hex")
    .slice(0, 32);

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

// The query string of an authorize request travels through the sign-in page as a form field and
// comes back in a Location header: only URL-safe characters may pass.
const safeQuery = (value: string | null) =>
  value !== null && /^[\x21-\x7E]*$/.test(value) ? value : "";

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
  await db().removeWhere(tokenTable, [
    { field: "kind", op: "$eq", value: "web" },
    { field: "expiresAt", op: "$lt", value: moment().toISOString() },
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

    // Shared by GET (show the page) and POST (submit it): resolves the client and validates the
    // request. A bad client_id or redirect_uri is shown to the user and never redirected to —
    // redirecting to an unvalidated URI would turn this endpoint into an open redirector.
    const resolveAuthorize = async (values: URLSearchParams, base: string) => {
      const clientId = values.get("client_id") ?? "";
      const redirectUri = values.get("redirect_uri") ?? "";

      const client = await lookupClient(clientId);
      if (!client) {
        return { response: errorPage("Unknown client."), client: null };
      }
      if (!redirectMatches(redirectUri, client.redirectUris)) {
        return {
          response: errorPage("The redirect address is not registered."),
          client: null,
        };
      }

      const state = values.get("state");
      const reject = (error: string, description: string) =>
        redirectWith(
          redirectUri,
          { error, error_description: description, state },
          base,
        );

      if (values.get("response_type") !== "code" && !values.has("action")) {
        return {
          response: reject(
            "unsupported_response_type",
            "Only code is supported.",
          ),
          client: null,
        };
      }

      const codeChallenge = values.get("code_challenge") ?? "";
      const method = values.get("code_challenge_method") ?? "S256";
      if (!codeChallenge || method !== "S256") {
        return {
          response: reject("invalid_request", "PKCE with S256 is required."),
          client: null,
        };
      }

      const resource = values.get("resource");
      if (resource && !isOurResource(resource, base)) {
        return {
          response: reject("invalid_target", "Unknown resource."),
          client: null,
        };
      }

      return {
        response: null,
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

    // The sign-in of whoever is at the keyboard, if they have one.
    const webSession = async (request: Request) => {
      const bearer = cookieOf(request, COOKIE);
      if (!bearer) return null;

      const principal = await resolveBearer(bearer, ["web"]);
      return principal ? { bearer, principal } : null;
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
      .get("/.well-known/oauth-protected-resource", resourceMetadata)
      .get("/.well-known/oauth-protected-resource/mcp", resourceMetadata)
      .get("/.well-known/oauth-authorization-server", ({ request }) => {
        const base = publicBase(request);

        return json({
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
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
      .get("/oauth/authorize", async ({ request }) => {
        const base = publicBase(request);
        const url = new URL(request.url);
        const resolved = await resolveAuthorize(url.searchParams, base);
        if (resolved.response) return resolved.response;

        const { client, params } = resolved;
        const returnTo = safeQuery(url.search.slice(1));

        const session = await webSession(request);
        if (!session) return loginPage(client, params, returnTo);

        const { principal, bearer } = session;
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

          return redirectWith(
            params.redirectUri,
            { code, state: params.state },
            base,
          );
        }

        return consentPage({
          client,
          params,
          returnTo,
          email: principal.user.email,
          offered: grantable(principal).filter((scope) =>
            scopeCovers(wanted, [scope]),
          ),
          csrf: csrfOf(bearer),
        });
      })
      .post(
        "/oauth/login",
        async ({ request }) => {
          const base = publicBase(request);
          const values = await readForm(request);
          const returnTo = safeQuery(values.get("return"));

          const resolved = await resolveAuthorize(
            new URLSearchParams(returnTo),
            base,
          );
          if (resolved.response) return resolved.response;

          const { client, params } = resolved;
          const email = (values.get("email") ?? "").trim().toLowerCase();
          const password = values.get("password") ?? "";
          const limitKey = `oauth-login:${email}`;

          if (await isLimited(limitKey)) {
            return loginPage(
              client,
              params,
              returnTo,
              "Too many failed attempts. Try again in a few minutes.",
              429,
            );
          }

          const { DUMMY_HASH, findUserByEmail } = await import(
            "../models/user"
          );
          const account = await findUserByEmail<{
            id: string;
            password: string;
          }>(email);

          const passwordOk = await Bun.password.verify(
            password,
            account?.password ?? DUMMY_HASH,
          );

          if (!account || !passwordOk) {
            await recordFailure(limitKey);
            return loginPage(
              client,
              params,
              returnTo,
              "Incorrect email or password.",
              401,
            );
          }

          await clearFailures(limitKey);

          const { bearer } = await issueToken({
            user: account.id,
            kind: "web",
          });

          return new Response(null, {
            status: 303,
            headers: {
              Location: `/oauth/authorize?${returnTo}`,
              "Set-Cookie": setCookie(bearer, WEB_COOKIE_SECONDS, base),
              ...noStore,
            },
          });
        },
        { parse: "none" },
      )
      .post(
        "/oauth/logout",
        async ({ request }) => {
          const base = publicBase(request);
          const values = await readForm(request);
          const session = await webSession(request);

          if (session) await removeToken(session.principal.token.id);

          return new Response(null, {
            status: 303,
            headers: {
              Location: `/oauth/authorize?${safeQuery(values.get("return"))}`,
              "Set-Cookie": setCookie("", 0, base),
              ...noStore,
            },
          });
        },
        { parse: "none" },
      )
      .post(
        "/oauth/authorize",
        async ({ request }) => {
          const base = publicBase(request);
          const values = await readForm(request);
          const resolved = await resolveAuthorize(values, base);
          if (resolved.response) return resolved.response;

          const { client, params } = resolved;

          // Signed out (or never signed in): back to the start, which asks for a sign-in.
          const session = await webSession(request);
          if (!session) {
            const query = new URLSearchParams({
              response_type: "code",
              client_id: params.clientId,
              redirect_uri: params.redirectUri,
              code_challenge: params.codeChallenge,
              code_challenge_method: "S256",
              ...(params.state === null ? {} : { state: params.state }),
              ...(params.scope === null ? {} : { scope: params.scope }),
              ...(params.resource === null
                ? {}
                : { resource: params.resource }),
            });

            return new Response(null, {
              status: 303,
              headers: {
                Location: `/oauth/authorize?${query}`,
                ...noStore,
              },
            });
          }

          const { principal, bearer } = session;

          if (!sameText(values.get("csrf") ?? "", csrfOf(bearer))) {
            return errorPage(
              "This page is out of date. Go back to the app and start again.",
              403,
            );
          }

          if (values.get("action") === "deny") {
            return redirectWith(
              params.redirectUri,
              { error: "access_denied", state: params.state },
              base,
            );
          }

          const wanted = parseScopes(params.scope);
          const offered = grantable(principal).filter((scope) =>
            scopeCovers(wanted, [scope]),
          );

          // Only what was offered: a checkbox the page never showed is ignored.
          const granted = values
            .getAll("grant")
            .filter((scope) => offered.includes(scope));

          if (granted.length === 0) {
            return consentPage({
              client,
              params,
              returnTo: "",
              email: principal.user.email,
              offered,
              csrf: csrfOf(bearer),
              error: "Choose at least one thing to allow, or deny.",
              status: 400,
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

          return redirectWith(
            params.redirectUri,
            { code, state: params.state },
            base,
          );
        },
        { parse: "none" },
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
