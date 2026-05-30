import models from "@njin/config/api";
import { makeModule } from "@njin/core/module";
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
      asset: (entry) =>
        `<script type="module" src="${url}/@vite/client"></script>\n` +
        `<script type="module" src="${url}/${entry}"></script>`,
    };
  }

  const manifestFile = Bun.file(join(publicDir, "manifest.json"));

  if (!(await manifestFile.exists())) {
    return { asset: () => "<!-- vite manifest not found, run: bun run build -->" };
  }

  const manifest = (await manifestFile.json()) as Record<string, ViteManifestChunk>;

  return {
    asset: (entry) => {
      const chunk = manifest[entry];
      if (!chunk) return `<!-- vite entry "${entry}" not found in manifest -->`;
      const styles = chunk.css?.map((f) => `<link rel="stylesheet" href="/${f}">`).join("\n") ?? "";
      const script = `<script type="module" src="/${chunk.file}"></script>`;
      return [styles, script].filter(Boolean).join("\n");
    },
  };
};

const view = makeModule(() => {
  const edge = new Edge();

  const fn = () => edge;

  fn.init = async () => {
    const viewsDir = join(import.meta.dir, "../views");
    const pagesDir = join(viewsDir, "pages");

    edge.mount(viewsDir);

    edge.global("vite", await buildViteGlobal());

    for (const modelPromise of models) {
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

      controller.get(route, async ({ params, query, path, request }) => {
        return new Response(
          await edge.render(template, {
            params,
            query,
            request: {
              path,
              url: request.url,
            },
          }),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      });
    }

    elysia().use(controller);

    return {};
  };

  return fn;
});

function fileToRoute(file: string): string {
  let route = file.replace(/\\/g, "/").replace(/\.edge$/, "");
  route = route.replace(/\[([^\]]+)\]/g, ":$1");
  route = route.replace(/\/index$|^index$/, "");
  return "/" + route;
}

export default view;
