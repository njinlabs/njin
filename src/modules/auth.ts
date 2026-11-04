import bearer from "@elysia/bearer";
import Elysia, { status } from "elysia";
import z from "zod";
import { access, isScope } from "../core/auth/access";
import {
  clearFailures,
  isLimited,
  recordFailure,
} from "../core/auth/rate_limit";
import {
  CSRF_HEADER,
  clearSessionCookie,
  isSafeMethod,
  isSecure,
  sessionCookieOf,
  setSessionCookie,
} from "../core/auth/session_cookie";
import { publicBase } from "../core/http/public_url";
import { makeModule } from "../core/module";
import elysia from "./elysia";
import {
  allowedOn,
  findOwnToken,
  issueToken,
  listTokens,
  type Principal,
  removeToken,
  resolveBearer,
  SESSION_TTL_SECONDS,
  type Surface,
  toPublic,
} from "./token";

export type AuthOptions = {
  // Only an admin session (managing users, groups and tokens).
  session?: true;
  // Only a delegated token (the agent endpoint); a 401 there tells an MCP client where to sign in.
  mcp?: true;
  // The caller must hold some access to this resource.
  can?: readonly [resource: string, action: string];
};

const surfaceOf = (options: true | AuthOptions): Surface => {
  if (options === true) return "any";
  if (options.session) return "session";
  if (options.mcp) return "mcp";
  return "any";
};

// `auth` is the one way to protect a route:
//   { auth: true }                content API: a session, personal token or OAuth token
//   { auth: { session: true } }   a session only
//   { auth: { mcp: true } }       a personal or OAuth token only
//   { auth: { can: [r, a] } }     also needs access to resource r, action a
// A credential comes in an Authorization header (any kind of token) or, for the admin in a
// browser, in an HttpOnly cookie that holds a session. A request on the cookie that changes data
// must also carry `X-Requested-With`, which another site cannot add.
// It resolves `principal` (who, with what, allowed to do what) plus `user` with the id of the
// token it came in on.
const auth = makeModule(() => {
  const fn = async () => {
    const plugin = new Elysia({ name: "auth" }).use(bearer()).macro({
      auth: (options: true | AuthOptions) => ({
        resolve: async ({ bearer, request, set }) => {
          const surface = surfaceOf(options);
          const cookie = bearer ? undefined : sessionCookieOf(request);
          const principal = await resolveBearer(bearer ?? cookie);

          if (
            !principal ||
            !allowedOn(principal.kind, surface) ||
            (cookie && principal.kind !== "session")
          ) {
            if (surface === "mcp") {
              // RFC 9728 — this header is how an MCP client discovers the OAuth flow; without
              // it (and a real 401 status) Claude never starts sign-in.
              set.headers["www-authenticate"] =
                `Bearer resource_metadata="${publicBase(request)}/.well-known/oauth-protected-resource"`;
            }

            return status(401, { message: "Unauthorized" });
          }

          if (cookie) {
            if (
              !isSafeMethod(request.method) &&
              !request.headers.has(CSRF_HEADER)
            ) {
              return status(403, { message: "Forbidden" });
            }

            // A session slides with use, so the cookie does too.
            set.headers["set-cookie"] = setSessionCookie(
              cookie,
              SESSION_TTL_SECONDS,
              isSecure(request),
            );
          }

          if (
            typeof options === "object" &&
            options.can &&
            !access(principal.permissions, ...options.can)
          ) {
            return status(403, { message: "Forbidden" });
          }

          return {
            principal,
            user: { ...principal.user, tokenId: principal.token.id },
          };
        },
      }),
    });

    return {
      plugin,
    };
  };

  fn.init = async () => {
    const { DUMMY_HASH, findUserByEmail } = await import("../models/user");

    const controller = new Elysia({
      prefix: "/api/auth",
    })
      .use((await fn()).plugin)
      .get(
        "/check-token",
        ({ user: { tokenId: _, ...user } }) => ({ data: user }),
        { auth: true },
      )
      .delete(
        "/logout",
        async ({ user: { tokenId, ...user }, request, set }) => {
          await removeToken(tokenId);
          set.headers["set-cookie"] = clearSessionCookie(isSecure(request));

          return { data: user };
        },
        { auth: { session: true } },
      )
      .post(
        "/login",
        async ({ body, request, set }) => {
          const limitKey = `login:${body.email.trim().toLowerCase()}`;

          if (await isLimited(limitKey)) {
            return status(429, {
              message: "Too many failed attempts. Try again in a few minutes.",
            });
          }

          const data = await findUserByEmail<{ id: string; password: string }>(
            body.email,
          );

          // Always run one verify, even for an unknown email, so timing doesn't reveal
          // whether the account exists.
          const passwordOk = await Bun.password.verify(
            body.password,
            data?.password ?? DUMMY_HASH,
          );

          if (!data || !passwordOk) {
            await recordFailure(limitKey);
            return status(401, { message: "Unauthorized" });
          }

          await clearFailures(limitKey);

          const { bearer: token } = await issueToken({
            user: data.id,
            kind: "session",
          });

          // The same session twice: in the cookie the browser keeps (out of reach of scripts),
          // and in the body for a client that is not a browser.
          set.headers["set-cookie"] = setSessionCookie(
            token,
            SESSION_TTL_SECONDS,
            isSecure(request),
          );

          const { password: _, ...safeData } = data;

          return { data: { ...safeData, token } };
        },
        {
          body: z.object({
            email: z.email(),
            password: z.string(),
          }),
        },
      );

    // The signed-in user's own credentials: sessions, personal tokens and connected agents.
    // Only a session may manage them, so a leaked agent token cannot mint a replacement.
    const tokens = new Elysia({ prefix: "/api/token" })
      .use((await fn()).plugin)
      .get(
        "/",
        async ({ principal }) => ({
          data: (await listTokens(principal.user.id)).map(toPublic),
        }),
        { auth: { session: true } },
      )
      .post(
        "/",
        async ({ body, principal }) => {
          const issued = await issueToken({
            user: principal.user.id,
            kind: "pat",
            name: body.name,
            scopes: body.scopes,
          });

          const created = await findOwnToken(principal.user.id, issued.id);

          return {
            data: {
              ...(created ? toPublic(created) : { id: issued.id }),
              // Returned exactly once — only the hash is stored, so it can't be shown again.
              token: issued.bearer,
            },
          };
        },
        {
          auth: { session: true },
          body: z.object({
            name: z.string().trim().min(1).max(100),
            // What the token may do, as "<resource>:<action>" (wildcards allowed). It can never
            // do more than its owner can.
            scopes: z
              .array(z.string().refine(isScope, "Use <resource>:<action>"))
              .min(1)
              .default(["*:*"]),
          }),
        },
      )
      .delete(
        "/:id",
        async ({ params, principal }) => {
          const existing = await findOwnToken(principal.user.id, params.id);

          if (!existing) {
            return status(404, { message: "Token not found" });
          }

          await removeToken(existing.id);

          return { data: toPublic(existing) };
        },
        {
          auth: { session: true },
          params: z.object({ id: z.coerce.string() }),
        },
      );

    elysia().use(controller).use(tokens);

    return {};
  };

  return fn;
});

export type { Principal };
export default auth;
