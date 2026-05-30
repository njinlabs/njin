import bunFilesystemAdapter from "@njin/core/adapters/bun_filesystem";
import env from "./env";

const adapters = {
  file: bunFilesystemAdapter({ dir: env.file.dir }),
};

export default adapters;
