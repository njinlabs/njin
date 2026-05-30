import adapters from "@njin/config/adapter";
import type { makeModel } from "@njin/core/model";
import { makeModule } from "@njin/core/module";
import Elysia from "elysia";
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
}

const file = makeModule(() => {
  let model: ReturnType<typeof makeModel>;

  const fn = () => ({ model });

  fn.init = async () => {
    const { default: baseModel } = await import("@njin/models/file");

    type FileUploadCurrent = Awaited<ReturnType<typeof baseModel.create>>;

    const controller = new Elysia({ prefix: "/api/file" })
      .use((await auth()).plugin)
      .delete(
        "/:id",
        async ({ params }) => {
          const data = await surreal().delete<FileUploadCurrent>(new RecordId(baseModel.table, params.id));

          await adapters.file.unlink(data);

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
            .content(await adapters.file.write(body.file));

          return { data };
        },
        {
          auth: true,
          body: z.object({
            file: z.file(),
          }),
        },
      );

    elysia().use(controller);

    model = baseModel;

    return {};
  };

  return fn;
});

export default file;
