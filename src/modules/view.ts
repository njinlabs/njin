import { getConfig } from "../core/config";
import { HttpError } from "../core/http_error";
import { makeModule } from "../core/module";
import { Edge } from "edge.js";
import Elysia from "elysia";
import { join } from "path";
import elysia from "./elysia";

const isDev = process.env.NODE_ENV !== "production";
const publicDir = join(process.cwd(), "public");

type ViteManifestChunk = {
  file: string;
  css?: string[];
  isEntry?: boolean;
};

type ViteGlobal = {
  asset: (entry: string) => string;
  static: (path: string) => string;
};

const buildViteGlobal = async (): Promise<ViteGlobal> => {
  if (isDev) {
    const { createServer } = await import("vite");
    const server = await createServer();
    await server.listen();
    server.printUrls();

    const url = server.resolvedUrls?.local[0]?.replace(/\/$/, "") ?? "http://localhost:5173";

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

  const manifestFile = Bun.file(join(publicDir, "manifest.json"));

  if (!(await manifestFile.exists())) {
    return {
      asset: () => "<!-- vite manifest not found, run: bun run build -->",
      static: (path) => `/${path.replace(/^\//, "")}`,
    };
  }

  const manifest = (await manifestFile.json()) as Record<string, ViteManifestChunk>;

  return {
    asset: (entry) => {
      const chunk = manifest[entry];
      if (!chunk) return `<!-- vite entry "${entry}" not found in manifest -->`;
      if (entry.endsWith(".css")) {
        return `<link rel="stylesheet" href="/${chunk.file}">`;
      }
      const styles = chunk.css?.map((f) => `<link rel="stylesheet" href="/${f}">`).join("\n") ?? "";
      const script = `<script type="module" src="/${chunk.file}"></script>`;
      return [styles, script].filter(Boolean).join("\n");
    },
    static: (path) => `/${path.replace(/^\//, "")}`,
  };
};

const view = makeModule(() => {
  const edge = new Edge();

  const fn = () => edge;

  fn.init = async () => {
    // process.cwd()-based, not import.meta.dir — once view.ts lives inside node_modules/njin,
    // import.meta.dir would point at the package's own location, not the consuming project's views.
    const viewsDir = join(process.cwd(), "src/views");
    const pagesDir = join(viewsDir, "pages");

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

    const controller = new Elysia();

    if (!isDev) {
      controller.get("/assets/*", async ({ params }) => {
        const file = Bun.file(join(publicDir, "assets", params["*"]));
        if (!(await file.exists())) return new Response("Not Found", { status: 404 });
        return file;
      });
    }

    const files: string[] = [];

    try {
      const glob = new Bun.Glob("**/*.edge");
      for await (const file of glob.scan({ cwd: pagesDir })) {
        files.push(file);
      }
    } catch {
      elysia().use(controller);
      return {};
    }

    for (const file of files) {
      const route = fileToRoute(file);
      const template = `pages/${file.replace(/\\/g, "/").replace(/\.edge$/, "")}`;

      controller.get(route, async ({ params, query, path, request, server }) => {
        // Object property — avoids TypeScript's overly-aggressive narrowing of
        // closure-assigned variables to `never`.
        const ctx: { abortErr: HttpError | null } = { abortErr: null };

        try {
          const html = await edge.render(template, {
            params,
            query,
            request: { path, url: request.url },
            abort: (statusCode: number, message?: string) => {
              ctx.abortErr = new HttpError(statusCode, message);
              throw ctx.abortErr;
            },
          });

          // Fire-and-forget — never awaited, so it can't add latency to the response.
          import("./analytics").then(({ default: analytics, resolveClientIp }) =>
            analytics().track({
              path,
              referrer: request.headers.get("referer"),
              userAgent: request.headers.get("user-agent"),
              ip: resolveClientIp(request, server),
              requestUrl: request.url,
            }),
          );

          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch (err) {
          if (ctx.abortErr) {
            return new Response(await renderHttpError(edge, viewsDir, ctx.abortErr), {
              status: ctx.abortErr.statusCode,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          if (!isDev) throw err;
          return new Response(renderErrorPage(err as Error, template, path), {
            status: 500,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      });
    }

    // Catch-all — must be registered last so specific routes take priority
    controller.get("/*", async ({ path }) => {
      if (!isDev) {
        const staticFile = Bun.file(join(publicDir, path));
        if (await staticFile.exists()) return staticFile;
      }

      return new Response(await renderHttpError(edge, viewsDir, new HttpError(404)), {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });

    elysia().use(controller);

    return {};
  };

  return fn;
});

async function renderHttpError(edge: Edge, viewsDir: string, error: HttpError): Promise<string> {
  const templateFile = Bun.file(join(viewsDir, `errors/${error.statusCode}.edge`));
  if (await templateFile.exists()) {
    try {
      return await edge.render(`errors/${error.statusCode}`, {
        statusCode: error.statusCode,
        message: error.message,
      });
    } catch (e) {
      console.error(`[view] failed to render errors/${error.statusCode}.edge:`, e);
    }
  }
  const code = error.statusCode;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${code} — ${error.message}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{text-align:center}.n{font-size:6rem;font-weight:700;color:#1e293b;line-height:1}.m{color:#64748b;margin-top:.5rem}a{color:#818cf8;text-decoration:none;margin-top:1.5rem;display:inline-block}</style>
</head><body><div class="c"><div class="n">${code}</div><p class="m">${error.message}</p><a href="/">← Back to home</a></div></body></html>`;
}

function renderErrorPage(error: Error, template: string, path: string): string {
  const stack = (error.stack ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const message = error.message.replace(/</g, "&lt;").replace(/>/g, "&gt;");

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

function fileToRoute(file: string): string {
  let route = file.replace(/\\/g, "/").replace(/\.edge$/, "");
  route = route.replace(/\[([^\]]+)\]/g, ":$1");
  route = route.replace(/\/index$|^index$/, "");
  return "/" + route;
}

export default view;
