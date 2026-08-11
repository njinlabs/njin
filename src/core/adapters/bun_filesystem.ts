import type { FileAdapter } from "../../modules/file";
import { init } from "@paralleldrive/cuid2";
import { join, resolve } from "node:path";
import z from "zod";
import { getConfig } from "../config";
import { sanitizeFileName } from "../path_guard";

const createId = init({
  random: Math.random,
  length: 10,
  fingerprint: "file",
});

const meta = z.null();

const bunFilesystemAdapter = ({ dir = "./uploads" }: { dir?: string } = {}): FileAdapter<typeof meta> => {
  return {
    meta,
    dir,
    write: async (file) => {
      const [fileName, ...exts] = sanitizeFileName(file.name).split(".");

      const name = `${fileName}_${createId()}.${exts.join(".")}`;

      // resolve(), not join() — dir is normally project-relative ("./uploads"), but an
      // already-absolute dir (as tests pass directly) must win outright rather than get
      // nested under rootDir.
      await Bun.write(join(resolve(getConfig().rootDir, dir), name), await file.arrayBuffer());

      return {
        meta: null,
        name,
        size: file.size,
        type: file.type,
        url: `/uploads/${name}`,
      };
    },
    unlink: (file) => Bun.file(join(resolve(getConfig().rootDir, dir), file.name)).delete(),
  };
};

export default bunFilesystemAdapter;
