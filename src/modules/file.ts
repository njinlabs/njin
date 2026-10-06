import { resolve } from "node:path";
import Elysia, { status } from "elysia";
import { RecordId } from "surrealdb";
import z from "zod";
import { getConfig } from "../core/config";
import type { makeModel } from "../core/model";
import { makeModule } from "../core/module";
import { resolveSafePath } from "../core/path_guard";
import auth from "./auth";
import elysia from "./elysia";
import surreal from "./surreal";

export type FileUpload<Meta> = {
  id: RecordId;
  name: string;
  size: number;
  type: string;
  meta: z.infer<Meta>;
  url: string;
  createdAt: string;
  updatedAt: string;
};

export interface FileAdapter<Meta> {
  write: (
    file: File,
  ) => Promise<Omit<FileUpload<Meta>, "id" | "createdAt" | "updatedAt">>;
  unlink: (file: FileUpload<Meta>) => Promise<void>;
  meta: Meta;
  // Only set by filesystem-backed adapters — tells this module where to serve
  // /uploads/* from. Adapters like S3 serve files from their own public URL instead,
  // so they omit this and the static route below never gets mounted.
  dir?: string;
}

// Extensions a browser would execute or render as a document when served from the site's own
// origin. Filesystem adapters serve /uploads/* by extension from that origin, so these are refused
// on upload (same stance as the MCP upload allowlist) and, for files already on disk, served as
// inert downloads below.
const ACTIVE_CONTENT_EXT = new Set([
  "html",
  "htm",
  "xhtml",
  "shtml",
  "js",
  "mjs",
  "xml",
]);

const extensionsOf = (name: string) => name.toLowerCase().split(".").slice(1);

const hasActiveExt = (name: string) =>
  extensionsOf(name).some((ext) => ACTIVE_CONTENT_EXT.has(ext));

const file = makeModule(() => {
  let model: ReturnType<typeof makeModel>;
  // Set in init() once the file model is loaded — shared by the REST routes below and any
  // other caller (e.g. the MCP upload flow) so every path goes through the same adapter.
  let upload: (file: File) => Promise<unknown>;
  let remove: (id: string) => Promise<unknown>;

  const fn = () => ({ model, upload, remove });

  fn.init = async () => {
    const { default: baseModel } = await import("../models/file");

    type FileUploadCurrent = Awaited<ReturnType<typeof baseModel.create>>;

    upload = async (file) =>
      surreal()
        .create<Omit<FileUploadCurrent, "id">>(baseModel.table)
        .content(await getConfig().adapters.file.write(file));

    remove = async (id) => {
      const data = await surreal().delete<FileUploadCurrent>(
        new RecordId(baseModel.table, id),
      );

      await getConfig().adapters.file.unlink(data);

      return data;
    };

    const controller = new Elysia({ prefix: "/api/file" })
      .use((await auth()).plugin)
      .get(
        "/",
        async ({ query: { search, page, limit, sort, order } }) => {
          return baseModel.read({ search, page, limit, sort, order });
        },
        {
          auth: true,
          query: z.object({
            search: z.coerce.string().optional(),
            page: z.coerce.number().int().positive().default(1),
            limit: z.coerce.number().int().positive().max(100).default(20),
            sort: z.coerce.string().optional(),
            order: z.enum(["asc", "desc"]).default("asc"),
          }),
        },
      )
      .delete(
        "/:id",
        async ({ params }) => {
          return { data: await remove(params.id) };
        },
        {
          params: z.object({
            id: z.coerce.string(),
          }),
          auth: true,
        },
      )
      .post(
        "/",
        async ({ body }) => {
          // Only filesystem-backed adapters (dir set) serve uploads from this origin.
          if (getConfig().adapters.file.dir && hasActiveExt(body.file.name)) {
            return status(422, {
              message:
                "This file type can't be uploaded (HTML, JavaScript and XML run on the site's origin).",
            });
          }

          return { data: await upload(body.file) };
        },
        {
          auth: true,
          body: z.object({
            file: z.file(),
          }),
        },
      );

    const adapterDir = getConfig().adapters.file.dir;

    if (adapterDir) {
      // resolve(), not join() — adapterDir is normally project-relative, but an
      // already-absolute dir must win outright rather than get nested under rootDir.
      const uploadsDir = resolve(getConfig().rootDir, adapterDir);

      const uploadsController = new Elysia().get(
        "/uploads/*",
        async ({ params }) => {
          // Elysia leaves wildcard params percent-encoded — decode before touching the filesystem.
          let decoded: string;
          try {
            decoded = decodeURIComponent(params["*"]);
          } catch {
            return new Response("Not Found", { status: 404 });
          }

          const requested = resolveSafePath(uploadsDir, decoded);
          if (!requested) return new Response("Not Found", { status: 404 });

          const file = Bun.file(requested);
          if (!(await file.exists()))
            return new Response("Not Found", { status: 404 });

          const headers: Record<string, string> = {
            "X-Content-Type-Options": "nosniff",
            // Anything that does render (SVG, legacy files) runs in an opaque origin without scripts.
            "Content-Security-Policy": "sandbox; default-src 'none'",
          };

          if (hasActiveExt(requested)) {
            headers["Content-Type"] = "application/octet-stream";
            headers["Content-Disposition"] = "attachment";
          }

          return new Response(file, { headers });
        },
      );

      elysia().use(controller).use(uploadsController);
    } else {
      elysia().use(controller);
    }

    model = baseModel;

    return {};
  };

  return fn;
});

export default file;
