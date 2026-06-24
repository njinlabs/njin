import type { FileAdapter } from "../modules/file";
import { join } from "node:path";
import bunFilesystemAdapter from "./adapters/bun_filesystem";
import type { makeModel } from "./model";

export type ModelFactory = () => Promise<{ default: ReturnType<typeof makeModel> }>;

export type NjinConfig = {
  port?: number;
  db?: {
    path?: string;
    namespace?: string;
    database?: string;
  };
  img?: {
    hosts?: string[];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapters?: {
    file?: FileAdapter<any>;
  };
  models?: ModelFactory[];
};

export type ResolvedConfig = {
  port: number;
  db: { path: string; namespace: string; database: string };
  img: { hosts: string[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapters: { file: FileAdapter<any> };
  models: ModelFactory[];
};

// Identity function — purely for DX (autocomplete/type-checking on the config
// object literal), same purpose as Vite's own `defineConfig`.
export const defineConfig = (config: NjinConfig): NjinConfig => config;

let resolved: ResolvedConfig | null = null;

// Reads `config.ts` from the consuming project's root (process.cwd()) — never
// from this package's own location, since that would break once this module
// lives inside node_modules/njin instead of the project itself.
//
// `preloaded` lets `njin build` skip the dynamic file read entirely: its generated
// entry imports the project's config.ts with a static, literal import, which
// `bun build --compile` can trace and embed directly into the binary. A dynamic
// import() of a runtime-computed path can't be bundled that way.
export const loadConfig = async (preloaded?: NjinConfig): Promise<void> => {
  // Idempotent unless explicitly given a preloaded config: module.ts's own no-arg call is
  // just a safety net ("ensure config is loaded before any module reads getConfig()") for
  // njin dev/start, where nothing else loads it first. In a compiled binary, the generated
  // entry calls loadConfig(config) itself with the real config — without this guard, module.ts's
  // no-arg call (reached as a side effect of importing it) would otherwise silently clobber that
  // back to empty defaults.
  if (!preloaded && resolved) return;

  let userConfig: NjinConfig;

  if (preloaded) {
    userConfig = preloaded;
  } else {
    const path = join(process.cwd(), "config.ts");

    userConfig = {};
    try {
      const mod = await import(path);
      userConfig = mod.default ?? {};
    } catch {
      // No config.ts at the project root — run on defaults only.
    }
  }

  resolved = {
    port: userConfig.port ?? 3000,
    db: {
      path: userConfig.db?.path ?? "rocksdb://data",
      namespace: userConfig.db?.namespace ?? "general",
      database: userConfig.db?.database ?? "general",
    },
    img: { hosts: userConfig.img?.hosts ?? [] },
    adapters: { file: userConfig.adapters?.file ?? bunFilesystemAdapter() },
    models: userConfig.models ?? [],
  };
};

export const getConfig = (): ResolvedConfig => {
  if (!resolved) throw new Error("Config not loaded yet — loadConfig() must run before getConfig() is called.");
  return resolved;
};
