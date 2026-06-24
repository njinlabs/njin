import { getConfig } from "../core/config";
import type { makeModel } from "../core/model";
import { makeModule } from "../core/module";
import { resolveSafePath } from "../core/path_guard";
import Elysia from "elysia";
import { join } from "node:path";
import { RecordId } from "surrealdb";
import z from "zod";
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
  write: (file: File) => Promise<Omit<FileUpload<Meta>, "id" | "createdAt" | "updatedAt">>;
  unlink: (file: FileUpload<Meta>) => Promise<void>;
  meta: Meta;
  // Only set by filesystem-backed adapters — tells this module where to serve
  // /uploads/* from. Adapters like S3 serve files from their own public URL instead,
  // so they omit this and the static route below never gets mounted.
  dir?: string;
}

const file = makeModule(() => {
  let model: ReturnType<typeof makeModel>;

  const fn = () => ({ model });

  fn.init = async () => {
    const { default: baseModel } = await import("../models/file");

    type FileUploadCurrent = Awaited<ReturnType<typeof baseModel.create>>;

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
          const data = await surreal().delete<FileUploadCurrent>(new RecordId(baseModel.table, params.id));

          await getConfig().adapters.file.unlink(data);

          return { data };
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
          const data = await surreal()
            .create<Omit<FileUploadCurrent, "id">>(baseModel.table)
            .content(await getConfig().adapters.file.write(body.file));

          return { data };
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
      const uploadsDir = join(process.cwd(), adapterDir);

      const uploadsController = new Elysia().get("/uploads/*", async ({ params }) => {
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
        if (!(await file.exists())) return new Response("Not Found", { status: 404 });

        return file;
      });

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
