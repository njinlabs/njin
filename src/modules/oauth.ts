import { createHash, randomBytes } from "node:crypto";
import Elysia from "elysia";
import moment from "moment";
import { eq, RecordId, Table } from "surrealdb";
import { escapeHtml, noStore, page } from "../core/html_page";
import { makeModule } from "../core/module";
import { publicBase } from "../core/public_url";
import elysia from "./elysia";
import {
  issueOAuthTokens,
  revokeOAuthToken,
  rotateOAuthTokens,
} from "./mcp_token";
import surreal from "./surreal";

// OAuth 2.1 authorization server for MCP clients (Claude etc.), living in the same process as
// the MCP endpoint: the user signs in with their normal njin account on a page served here and
// the agent gets its own revocable token — nobody pastes a token anywhere. Public clients only
// (PKCE S256, no client secret), registered through RFC 7591 dynamic client registration.

const clientTable = new Table("oauth_client");
const codeTable = new Table("oauth_code");

const CODE_TTL_MINUTES = 10;
const UNUSED_CLIENT_TTL_HOURS = 24;

// Dynamic registration is open to anyone who can reach the server, so the redirect URI is the
// only thing stopping a rogue client from receiving an authorization code — only the hosted
// Claude callbacks and loopback addresses (native/dev clients, RFC 8252) are accepted.
const HOSTED_CALLBACKS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const parseUrl = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const isAllowedRedirectUri = (value: string) => {
  const url = parseUrl(value);
  if (!url || url.hash) return false;
  if (HOSTED_CALLBACKS.has(value)) return true;

  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
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
  id: RecordId;
  clientName: string;
  redirectUris: string[];
  // Flipped once any user completes sign-in for it, so abandoned registrations (Claude
  // registers a fresh client per connection attempt) can be pruned without touching real ones.
  used: boolean;
  createdAt: string;
};

type OAuthCode = {
  id: RecordId;
  clientId: string;
  userId: RecordId;
  redirectUri: string;
  codeChallenge: string;
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

const errorPage = (message: string) =>
  page(
    "Cannot authorize",
    `<h1>Cannot authorize</h1><p>${escapeHtml(message)}</p>`,
    400,
  );

type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
};

const consentPage = (
  client: OAuthClient,
  params: AuthorizeParams,
  error?: string,
  status = 200,
) => {
  const hidden = (name: string, value: string | null) =>
    value === null
      ? ""
      : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

  // The redirect host is spelled out because that — not the client's self-chosen display
  // name — is where the authorization code actually goes (MCP authorization spec).
  const host = parseUrl(params.redirectUri)?.host ?? params.redirectUri;

  return page(
    "Authorize access",
    `<h1>Authorize ${escapeHtml(client.clientName)}</h1>
<p><strong>${escapeHtml(client.clientName)}</strong> wants to manage this site on your behalf: read, create, change and delete content, settings and files. It will return to <span class="host">${escapeHtml(host)}</span>.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${hidden("client_id", params.clientId)}
${hidden("redirect_uri", params.redirectUri)}
${hidden("code_challenge", params.codeChallenge)}
${hidden("state", params.state)}
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<div class="row">
<button type="submit" name="action" value="deny" formnovalidate>Deny</button>
<button type="submit" name="action" value="approve" class="primary">Allow</button>
</div>
</form>`,
    status,
  );
};

const redirectWith = (
  redirectUri: string,
  values: Record<string, string | null>,
) => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) url.searchParams.set(key, value);
  }

  return new Response(null, {
    status: 303,
    headers: { Location: url.toString(), ...noStore },
  });
};

// Wrong-password attempts are capped per account (in-memory, per worker — a speed bump, not a
// guarantee: njin has no general rate limiting yet, and this page takes a password).
const MAX_FAILED_SIGN_INS = 10;
const FAILED_WINDOW_MS = 15 * 60 * 1000;
const failedSignIns = new Map<string, { count: number; resetAt: number }>();

const isLockedOut = (email: string) => {
  const entry = failedSignIns.get(email);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    failedSignIns.delete(email);
    return false;
  }
  return entry.count >= MAX_FAILED_SIGN_INS;
};

const recordFailedSignIn = (email: string) => {
  const entry = failedSignIns.get(email);
  if (!entry || Date.now() > entry.resetAt) {
    failedSignIns.set(email, {
      count: 1,
      resetAt: Date.now() + FAILED_WINDOW_MS,
    });
    return;
  }
  entry.count += 1;
};

// Verified against when the email is unknown, so a wrong email and a wrong password cost the
// same amount of time and the page doesn't reveal which accounts exist.
const DUMMY_HASH = Bun.password.hashSync("njin-dummy-password");

const hashCode = (code: string) =>
  createHash("sha256").update(code).digest("hex");

const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

const readForm = async (request: Request) =>
  new URLSearchParams(await request.text());

const pruneExpired = async () => {
  await surreal().query(
    "DELETE oauth_code WHERE expiresAt < $now; DELETE oauth_client WHERE used = false AND createdAt < $cutoff;",
    {
      now: moment().toISOString(),
      cutoff: moment().subtract(UNUSED_CLIENT_TTL_HOURS, "hours").toISOString(),
    },
  );
};

const oauth = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
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
        ? ((await surreal().select<OAuthClient>(
            new RecordId(clientTable, clientId),
          )) ?? null)
        : null;

    // Shared by GET (show the page) and POST (submit it): resolves the client and validates the
    // request. A bad client_id or redirect_uri is shown to the user and never redirected to —
    // redirecting to an unvalidated URI would turn this endpoint into an open redirector.
    const resolveAuthorize = async (values: URLSearchParams) => {
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
        redirectWith(redirectUri, {
          error,
          error_description: description,
          state,
        });

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

      return {
        response: null,
        client,
        params: { clientId, redirectUri, codeChallenge, state },
      };
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
          scopes_supported: ["offline_access"],
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
              "redirect_uris must be the Claude callback or a loopback address.",
            );
          }

          const clientName =
            typeof client_name === "string" && client_name.trim()
              ? client_name.trim().slice(0, 100)
              : "Unknown client";

          await pruneExpired();

          const [created] = await surreal()
            .create<OAuthClient>(clientTable)
            .content({
              clientName,
              redirectUris: redirect_uris as string[],
              used: false,
              createdAt: moment().toISOString(),
            });

          return json(
            {
              client_id: created!.id.id.toString(),
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
        const values = new URL(request.url).searchParams;
        const resolved = await resolveAuthorize(values);
        if (resolved.response) return resolved.response;

        return consentPage(resolved.client, resolved.params);
      })
      .post(
        "/oauth/authorize",
        async ({ request }) => {
          const values = await readForm(request);
          const resolved = await resolveAuthorize(values);
          if (resolved.response) return resolved.response;

          const { client, params } = resolved;

          if (values.get("action") === "deny") {
            return redirectWith(params.redirectUri, {
              error: "access_denied",
              state: params.state,
            });
          }

          const email = (values.get("email") ?? "").trim().toLowerCase();
          const password = values.get("password") ?? "";

          if (isLockedOut(email)) {
            return consentPage(
              client,
              params,
              "Too many failed attempts. Try again in a few minutes.",
              429,
            );
          }

          const { default: user } = await import("../models/user");
          const [account] = await surreal()
            .select<{ id: RecordId; password: string }>(user.table)
            .where(eq("email", email));

          const passwordOk = await Bun.password.verify(
            password,
            account?.password ?? DUMMY_HASH,
          );

          if (!account || !passwordOk) {
            recordFailedSignIn(email);
            return consentPage(
              client,
              params,
              "Incorrect email or password.",
              401,
            );
          }

          failedSignIns.delete(email);

          const code = randomBytes(32).toString("base64url");

          // The record id is the code's hash, so redeeming is a direct lookup and the plain
          // code never touches the DB.
          await surreal()
            .create<OAuthCode>(new RecordId(codeTable, hashCode(code)))
            .content({
              clientId: params.clientId,
              userId: account.id as unknown as OAuthCode["userId"],
              redirectUri: params.redirectUri,
              codeChallenge: params.codeChallenge,
              expiresAt: moment()
                .add(CODE_TTL_MINUTES, "minutes")
                .toISOString(),
            });

          await surreal().update(client.id).merge({ used: true });

          return redirectWith(params.redirectUri, {
            code,
            state: params.state,
          });
        },
        { parse: "none" },
      )
      .post(
        "/oauth/token",
        async ({ request }) => {
          const values = await readForm(request);
          const grantType = values.get("grant_type");
          const clientId = values.get("client_id") ?? "";

          const client = await lookupClient(clientId);
          if (!client) {
            return oauthError("invalid_client", "Unknown client.", 401);
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
          const id = new RecordId(codeTable, hashCode(code));

          const record = code
            ? await surreal().select<OAuthCode>(id)
            : undefined;
          if (!record) {
            return oauthError("invalid_grant", "Code is not valid.");
          }

          // Single use, burned before any other check: a code that fails PKCE or redirect
          // verification is dead too, so it can't be retried with guessed verifiers.
          await surreal().delete(id);

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

          return json(
            await issueOAuthTokens({
              name: client.clientName,
              clientId,
              userId: record.userId,
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
