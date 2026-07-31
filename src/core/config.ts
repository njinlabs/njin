import type { AnyElysia } from "elysia";
import type { FileAdapter } from "../modules/file";
import { join } from "node:path";
import bunFilesystemAdapter from "./adapters/bun_filesystem";
import type { makeModel } from "./model";
import type { Plugin } from "./plugin";
import type { makeVars } from "./vars";

export type ModelFactory = () => Promise<{ default: ReturnType<typeof makeModel> }>;

// A hook file's only job is the side effect of calling afterCreate()/etc. at import
// time — its module's exports (if any) are irrelevant, unlike ModelFactory.
export type HookFactory = () => Promise<unknown>;

// An event listener file's only job is the side effect of calling `<event>.listen(...)`
// at import time — it imports a canonical makeEvent() instance from its own file
// (src/core/event.ts) and registers a handler. Same shape/reasoning as HookFactory.
export type EventFactory = () => Promise<unknown>;

// A route file exports a full Elysia instance (built via the `route()` helper) —
// its default export is mounted as-is, same as ModelFactory but for arbitrary endpoints.
// AnyElysia (not a bare `Elysia`) because each route file's instance carries its own
// concrete generics (prefix literal, schemas, ...) that a fixed default-generic
// `Elysia` type can't structurally match — same reasoning as elysia.ts's shared app.
export type RouteFactory = () => Promise<{ default: AnyElysia }>;

// A vars file's default export is one makeVars() group (e.g. "general", "seo") —
// a singleton settings object, not a list of records like a model.
export type VarsFactory = () => Promise<{ default: ReturnType<typeof makeVars> }>;

export type NjinConfig = {
  port?: number;
  db?: {
    path?: string;
    namespace?: string;
    database?: string;
    // Root/system auth ({ username, password }) or a bearer token (string). Omit for an
    // anonymous connection — the only mode embedded (rocksdb/mem/surrealkv) engines support.
    auth?: { username: string; password: string } | string;
  };
  img?: {
    hosts?: string[];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapters?: {
    file?: FileAdapter<any>;
  };
  models?: ModelFactory[];
  hooks?: HookFactory[];
  events?: EventFactory[];
  routes?: RouteFactory[];
  vars?: VarsFactory[];
  plugins?: Plugin[];
};

export type ResolvedConfig = {
  port: number;
  db: { path: string; namespace: string; database: string; auth?: { username: string; password: string } | string };
  img: { hosts: string[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapters: { file: FileAdapter<any> };
  models: ModelFactory[];
  hooks: HookFactory[];
  events: EventFactory[];
  routes: RouteFactory[];
  vars: VarsFactory[];
  // Everything else a Plugin contributes (models/vars/hooks/events/routes) is already
  // flattened into the arrays above — init() is the only part that can't be merged away,
  // so it's the only piece of each Plugin that survives resolution on its own.
  pluginInits: Array<() => Promise<void> | void>;
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

  const plugins = userConfig.plugins ?? [];

  // Plugin-contributed models/vars/hooks/events/routes come first, then the project's
  // own — a plugin is the foundation being extended, so its registrations run first and
  // the project's own can build on top of (or follow) whatever the plugin set up. No
  // collision detection: two plugins (or a plugin and the project) registering the same
  // prefix fails the same way it already does today — naturally, at runtime.
  resolved = {
    port: userConfig.port ?? 3000,
    db: {
      path: userConfig.db?.path ?? "rocksdb://data",
      namespace: userConfig.db?.namespace ?? "general",
      database: userConfig.db?.database ?? "general",
      auth: userConfig.db?.auth,
    },
    img: { hosts: userConfig.img?.hosts ?? [] },
    adapters: { file: userConfig.adapters?.file ?? bunFilesystemAdapter() },
    models: [...plugins.flatMap((p) => p.models ?? []), ...(userConfig.models ?? [])],
    hooks: [...plugins.flatMap((p) => p.hooks ?? []), ...(userConfig.hooks ?? [])],
    events: [...plugins.flatMap((p) => p.events ?? []), ...(userConfig.events ?? [])],
    routes: [...plugins.flatMap((p) => p.routes ?? []), ...(userConfig.routes ?? [])],
    vars: [...plugins.flatMap((p) => p.vars ?? []), ...(userConfig.vars ?? [])],
    pluginInits: plugins.map((p) => p.init).filter((fn): fn is () => Promise<void> | void => typeof fn === "function"),
  };
};

export const getConfig = (): ResolvedConfig => {
  if (!resolved) throw new Error("Config not loaded yet — loadConfig() must run before getConfig() is called.");
  return resolved;
};
