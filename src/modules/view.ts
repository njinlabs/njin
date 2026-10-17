import { join } from "node:path";
import { Edge } from "edge.js";
import Elysia from "elysia";
import { getConfig } from "../core/config";
import { escapeHtml } from "../core/html_page";
import { HttpError } from "../core/http_error";
import { makeModule } from "../core/module";
import {
  cacheKey,
  getOrRenderStatic,
  purgeStatic,
  registerStaticRoute,
  warmStatic,
} from "../core/static_cache";
import elysia from "./elysia";
import logger from "./logger";

const isDev = process.env.NODE_ENV !== "production";
// Lazy, not a top-level const — this module's static import runs (as a side effect of
// module.ts importing it) before module.ts's own `await loadConfig()` line, so getConfig()
// isn't populated yet at that point. Every call site below only runs from inside fn.init()
// or a request handler, both well after loadConfig() has resolved.
const publicDir = () => join(getConfig().rootDir, "public");

type ViteManifestChunk = {
  file: string;
  css?: string[];
  isEntry?: boolean;
};

type ViteGlobal = {
  asset: (entry: string) => string;
  static: (path: string) => string;
};

export const buildViteGlobal = async (): Promise<ViteGlobal> => {
  if (isDev) {
    const { createServer } = await import("vite");
    const server = await createServer();
    await server.listen();
    server.printUrls();

    const url =
      server.resolvedUrls?.local[0]?.replace(/\/$/, "") ??
      "http://localhost:5173";

    process.once("SIGINT", () => server.close());
    process.once("SIGTERM", () => server.close());

    return {
      asset: (entry) => {
        if (entry.endsWith(".css")) {
          return `<link rel="stylesheet" href="${url}/${entry}">`;
        }
        return (
          `<script type="module" src="${url}/@vite/client"></script>\n` +
          `<script type="module" src="${url}/${entry}"></script>`
        );
      },
      static: (path) => `${url}/${path.replace(/^\//, "")}`,
    };
  }

  const manifestFile = Bun.file(join(publicDir(), "manifest.json"));

  if (!(await manifestFile.exists())) {
    return {
      asset: () => "<!-- vite manifest not found, run: bun run build -->",
      static: (path) => `/${path.replace(/^\//, "")}`,
    };
  }

  const manifest = (await manifestFile.json()) as Record<
    string,
    ViteManifestChunk
  >;

  return {
    asset: (entry) => {
      const chunk = manifest[entry];
      if (!chunk) return `<!-- vite entry "${entry}" not found in manifest -->`;
      if (entry.endsWith(".css")) {
        return `<link rel="stylesheet" href="/${chunk.file}">`;
      }
      const styles =
        chunk.css
          ?.map((f) => `<link rel="stylesheet" href="/${f}">`)
          .join("\n") ?? "";
      const script = `<script type="module" src="/${chunk.file}"></script>`;
      return [styles, script].filter(Boolean).join("\n");
    },
    static: (path) => `/${path.replace(/^\//, "")}`,
  };
};

// Defaults for every server-rendered page. The CSP is deliberately limited to directives that
// can't break a site's own inline scripts/styles or third-party embeds — a project that wants a
// strict script-src can still set its own policy on top.
const securityHeaders = (request: Request): Record<string, string> => {
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy":
      "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'",
  };

  // HSTS is only honoured over HTTPS, and pinning it during local dev would stick to localhost.
  const https =
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  if (!isDev && https) {
    headers["Strict-Transport-Security"] =
      "max-age=31536000; includeSubDomains";
  }

  return headers;
};

// A static route without `revalidate` only changes through purgeStatic() (which also BANs the
// shared cache), so the cache may keep it for a long while; this is just the safety net for a
// cache that missed the BAN.
const STATIC_SHARED_MAX_AGE = 86400;
const STATIC_DEFAULT_SWR = 60;

export const htmlResponse = (
  request: Request,
  html: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
  // Set for a page served from the static cache: shared caches (Varnish, CDN) may store it.
  shared?: { revalidate?: number },
) => {
  const headers = { ...securityHeaders(request), ...extraHeaders };

  // Successful pages revalidate (cheap 304s via ETag); errors are never cached.
  if (status !== 200) {
    headers["Cache-Control"] = "no-store";
    return new Response(html, { status, headers });
  }

  const etag = `W/"${Bun.hash(html).toString(36)}"`;
  // max-age=0 keeps browsers revalidating through the ETag; s-maxage is for shared caches.
  headers["Cache-Control"] = shared
    ? `public, max-age=0, s-maxage=${shared.revalidate ?? STATIC_SHARED_MAX_AGE}, stale-while-revalidate=${shared.revalidate ?? STATIC_DEFAULT_SWR}`
    : "no-cache";
  headers.ETag = etag;

  const ifNoneMatch = request.headers.get("if-none-match");
  if (
    ifNoneMatch?.split(",").some((v) => v.trim() === etag || v.trim() === "*")
  ) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(html, { status, headers });
};

type PageContext = {
  params: Record<string, string>;
  query: Record<string, unknown>;
  request: { path: string; url: string };
};

// Shared by the live route handler and the static build. A template's `abort()` is wrapped by
// EdgeJS on its way out, so the original HttpError is saved here and rethrown unwrapped.
export const renderPage = async (
  edge: Edge,
  template: string,
  context: PageContext,
): Promise<string> => {
  // Object property — avoids TypeScript's overly-aggressive narrowing of
  // closure-assigned variables to `never`.
  const ctx: { abortErr: HttpError | null } = { abortErr: null };

  try {
    return await edge.render(template, {
      ...context,
      abort: (statusCode: number, message?: string) => {
        ctx.abortErr = new HttpError(statusCode, message);
        throw ctx.abortErr;
      },
    });
  } catch (err) {
    throw ctx.abortErr ?? err;
  }
};

// Fire-and-forget — never awaited, so it can't add latency to the response.
const trackVisit = (
  path: string,
  request: Request,
  server: { requestIP: (req: Request) => { address: string } | null } | null,
) =>
  import("./analytics")
    .then(({ default: analytics, resolveClientIp, resolveRequestOrigin }) =>
      analytics().track({
        path,
        referrer: request.headers.get("referer"),
        userAgent: request.headers.get("user-agent"),
        ip: resolveClientIp(request, server),
        requestUrl: resolveRequestOrigin(request),
      }),
    )
    // Fire-and-forget: nothing awaits this, so an uncaught failure here (building the input
    // happens outside track()'s own try/catch) would be an unhandled rejection that kills the app.
    .catch((e) => logger().error(e, "[view] failed to track visit"));

// Mounts views and registers every template global.
const setupEdge = async (edge: Edge, viewsDir: string) => {
  edge.mount(viewsDir);

  edge.global("vite", await buildViteGlobal());
  // Fallback abort for non-page contexts (components, error templates).
  // Pages get a per-request override that saves the error before EdgeJS wraps it.
  edge.global("abort", (statusCode: number, message?: string) => {
    throw new HttpError(statusCode, message);
  });

  for (const modelPromise of getConfig().models) {
    const { default: model } = await modelPromise();
    edge.global(model.prefix, model);
  }

  for (const varsPromise of getConfig().vars) {
    const { default: group } = await varsPromise();
    edge.global(group.prefix, group);
  }

  for (const helperPromise of getConfig().helpers) {
    const { default: helper } = await helperPromise();
    edge.global(helper.name, helper.fn);
  }
};

const scanPages = async (pagesDir: string) => {
  const pages: { route: string; template: string }[] = [];
  const glob = new Bun.Glob("**/*.edge");
  for await (const file of glob.scan({ cwd: pagesDir })) {
    pages.push({
      route: fileToRoute(file),
      template: `pages/${file.replace(/\\/g, "/").replace(/\.edge$/, "")}`,
    });
  }
  return pages;
};

const view = makeModule(() => {
  const edge = new Edge();

  const fn = () => edge;

  fn.init = async () => {
    // getConfig().rootDir-based, not import.meta.dir — once view.ts lives inside
    // node_modules/njin, import.meta.dir would point at the package's own location, not
    // the consuming project's views.
    const viewsDir = join(getConfig().rootDir, "src/views");
    const pagesDir = join(viewsDir, "pages");

    await setupEdge(edge, viewsDir);

    // Pages cached by a previous run may be from older templates/content — start clean.
    if (!isDev) await purgeStatic(undefined, { warm: false });

    const controller = new Elysia();

    if (!isDev) {
      controller.get("/assets/*", async ({ params }) => {
        const file = Bun.file(join(publicDir(), "assets", params["*"]));
        if (!(await file.exists()))
          return new Response("Not Found", { status: 404 });
        return file;
      });
    }

    const staticRoutes = new Map(
      (getConfig().static ?? []).map((r) => [r.route, r]),
    );
    const { publicUrl, port } = getConfig();
    const configuredBase = publicUrl?.replace(/\/$/, "");

    let pages: Awaited<ReturnType<typeof scanPages>>;
    try {
      pages = await scanPages(pagesDir);
    } catch {
      elysia().use(controller);
      return {};
    }

    for (const { route, template } of pages) {
      controller.get(
        route,
        async ({ params, query, path, request, server }) => {
          try {
            // Static routes render on their first hit and are then served from the cache until
            // purged or revalidated (see core/static_cache.ts). Dev always renders live.
            const staticRoute = isDev ? undefined : staticRoutes.get(route);
            const key = staticRoute ? cacheKey(path) : null;

            let html: string;
            let cacheHeaders: Record<string, string> = {};
            let shared: { revalidate?: number } | undefined;
            if (staticRoute && key !== null) {
              // Same HTML for every visitor: no query, and a url built from publicUrl when set.
              const base = configuredBase ?? new URL(request.url).origin;
              const result = await getOrRenderStatic(
                key,
                () =>
                  renderPage(edge, template, {
                    params,
                    query: {},
                    request: { path: key, url: `${base}${key}` },
                  }),
                staticRoute.revalidate,
              );
              html = result.html;
              cacheHeaders = { "X-Njin-Cache": result.state };
              shared = { revalidate: staticRoute.revalidate };
            } else {
              html = await renderPage(edge, template, {
                params,
                query,
                request: { path, url: request.url },
              });
              if (staticRoute) cacheHeaders = { "X-Njin-Cache": "BYPASS" };
            }

            trackVisit(path, request, server);

            return htmlResponse(request, html, 200, cacheHeaders, shared);
          } catch (err) {
            if (err instanceof HttpError) {
              return htmlResponse(
                request,
                await renderHttpError(edge, viewsDir, err),
                err.statusCode,
              );
            }
            if (!isDev) {
              // Render the project's own errors/500.edge instead of the generic JSON 500.
              logger().error(err);
              return htmlResponse(
                request,
                await renderHttpError(edge, viewsDir, new HttpError(500)),
                500,
              );
            }
            return htmlResponse(
              request,
              renderErrorPage(err as Error, template, path),
              500,
            );
          }
        },
      );
    }

    // Plain static routes are rendered ahead of the first visitor (and again after each purge).
    if (!isDev) {
      const base = configuredBase ?? `http://localhost:${port}`;
      for (const { route, template } of pages) {
        const staticRoute = staticRoutes.get(route);
        if (!staticRoute || route.includes(":")) continue;
        registerStaticRoute(route, {
          revalidate: staticRoute.revalidate,
          render: () =>
            renderPage(edge, template, {
              params: {},
              query: {},
              request: { path: route, url: `${base}${route}` },
            }),
        });
      }
    }

    // Catch-all — must be registered last so specific routes take priority
    controller.get("/*", async ({ path, request }) => {
      if (!isDev) {
        const staticFile = Bun.file(join(publicDir(), path));
        if (await staticFile.exists()) return staticFile;
      }

      return htmlResponse(
        request,
        await renderHttpError(edge, viewsDir, new HttpError(404)),
        404,
      );
    });

    elysia().use(controller);

    return {
      // Warming queries the database, whose tables only exist once the db module's spin() has run —
      // so it can't happen in init(). Fire-and-forget: it must not delay the server coming up.
      spin: () => {
        if (!isDev) void warmStatic();
      },
    };
  };

  return fn;
});

export async function renderHttpError(
  edge: Edge,
  viewsDir: string,
  error: HttpError,
): Promise<string> {
  const templateFile = Bun.file(
    join(viewsDir, `errors/${error.statusCode}.edge`),
  );
  if (await templateFile.exists()) {
    try {
      return await edge.render(`errors/${error.statusCode}`, {
        statusCode: error.statusCode,
        message: error.message,
      });
    } catch (e) {
      logger().error(
        e,
        `[view] failed to render errors/${error.statusCode}.edge`,
      );
    }
  }
  const code = error.statusCode;
  // abort() messages often embed user input — never emit them raw.
  const message = escapeHtml(error.message);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${code} — ${message}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{text-align:center}.n{font-size:6rem;font-weight:700;color:#1e293b;line-height:1}.m{color:#64748b;margin-top:.5rem}a{color:#818cf8;text-decoration:none;margin-top:1.5rem;display:inline-block}</style>
</head><body><div class="c"><div class="n">${code}</div><p class="m">${message}</p><a href="/">← Back to home</a></div></body></html>`;
}

export function renderErrorPage(
  error: Error,
  template: string,
  path: string,
): string {
  const stack = escapeHtml(error.stack ?? "");
  const message = escapeHtml(error.message);
  path = escapeHtml(path);
  template = escapeHtml(template);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Error — ${path}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f172a; color: #e2e8f0; font-family: ui-monospace, monospace; padding: 2rem; min-height: 100vh; }
    .badge { display: inline-block; background: #ef4444; color: #fff; font-size: .7rem; font-weight: 700; padding: .2rem .5rem; border-radius: .25rem; letter-spacing: .05em; margin-bottom: 1.5rem; }
    h1 { font-size: 1.25rem; color: #f87171; margin-bottom: .5rem; word-break: break-word; }
    .meta { font-size: .8rem; color: #64748b; margin-bottom: 2rem; }
    .meta span { color: #94a3b8; }
    pre { background: #1e293b; border: 1px solid #334155; border-radius: .5rem; padding: 1.5rem; font-size: .8rem; line-height: 1.7; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
    .label { font-size: .7rem; color: #64748b; text-transform: uppercase; letter-spacing: .1em; margin-bottom: .5rem; }
  </style>
</head>
<body>
  <div class="badge">500 — DEV MODE</div>
  <h1>${message}</h1>
  <p class="meta">Template: <span>${template}</span> &nbsp;·&nbsp; Route: <span>${path}</span></p>
  <p class="label">Stack trace</p>
  <pre>${stack}</pre>
</body>
</html>`;
}

export function fileToRoute(file: string): string {
  let route = file.replace(/\\/g, "/").replace(/\.edge$/, "");
  route = route.replace(/\[([^\]]+)\]/g, ":$1");
  route = route.replace(/\/index$|^index$/, "");
  return `/${route}`;
}

export default view;
