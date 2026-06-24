import type { FileAdapter } from "../../modules/file";
import { init } from "@paralleldrive/cuid2";
import { join } from "node:path";
import z from "zod";

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
      const [fileName, ...exts] = file.name.split(".");

      const name = `${fileName}_${createId()}.${exts.join(".")}`;

      await Bun.write(join(dir, name), await file.arrayBuffer());

      return {
        meta: null,
        name,
        size: file.size,
        type: file.type,
        url: `/uploads/${name}`,
      };
    },
    unlink: (file) => Bun.file(join(dir, file.name)).delete(),
  };
};

export default bunFilesystemAdapter;
