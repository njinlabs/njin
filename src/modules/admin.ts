import { makeModule } from "@njin/core/module";
import Elysia from "elysia";
import { join, normalize } from "node:path";
import elysia from "./elysia";

const adminDir = join(process.cwd(), "_admin");
const indexFile = () => Bun.file(join(adminDir, "index.html"));

const admin = makeModule(() => {
  const fn = () => {};

  fn.init = () => {
    const controller = new Elysia()
      .get("/_admin", () => indexFile())
      .get("/_admin/*", async ({ params }) => {
        // Elysia leaves wildcard params percent-encoded — decode before touching the filesystem.
        let decoded: string;
        try {
          decoded = decodeURIComponent(params["*"]);
        } catch {
          return indexFile();
        }

        const requested = normalize(join(adminDir, decoded));

        // Stay inside adminDir — block path traversal via "..".
        if (!requested.startsWith(adminDir)) {
          return indexFile();
        }

        const file = Bun.file(requested);
        if (await file.exists()) return file;

        // SPA fallback — let the admin panel's client-side router handle unknown paths.
        return indexFile();
      });

    elysia().use(controller);

    return {};
  };

  return fn;
});

export default admin;
