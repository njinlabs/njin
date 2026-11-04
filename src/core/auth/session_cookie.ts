// The browser's copy of a session: an HttpOnly cookie, so a script on the admin page (an XSS, a
// compromised dependency) can use the session but never read the token out of it.
//
// It is only ever a session token. `SameSite=Strict` keeps other sites from riding on it, and the
// API asks for a custom header on anything that changes data (see `auth.ts`), which a cross-site
// form cannot add. Scoped to `/api`: the admin's own files never need it.

export const SESSION_COOKIE = "njin_session";

const SESSION_COOKIE_PATH = "/api";

// A request that only reads cannot change anything, so it needs no more than the cookie.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Sent by the admin on every request. A browser will not add a custom header to a request made
// from another site without the server agreeing to it first (CORS), and this server never does.
export const CSRF_HEADER = "x-requested-with";

export const isSafeMethod = (method: string) =>
  SAFE_METHODS.has(method.toUpperCase());

export const sessionCookieOf = (request: Request) => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === SESSION_COOKIE) return rest.join("=") || undefined;
  }

  return undefined;
};

export const setSessionCookie = (
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
) =>
  `${SESSION_COOKIE}=${value}; Path=${SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;

export const clearSessionCookie = (secure: boolean) =>
  setSessionCookie("", 0, secure);
