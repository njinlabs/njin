import { join } from "node:path";
import type { AnyElysia } from "elysia";
import type { DestinationStream, Level } from "pino";
import type { FileAdapter } from "../modules/file";
import bunFilesystemAdapter from "./adapters/bun_filesystem";
import surrealAdapter from "./adapters/surreal";
import type { DbAdapter } from "./db/contract";
import type { Helper } from "./helper";
import type { McpTool } from "./mcp_tool";
import type { makeModel } from "./model";
import type { Plugin } from "./plugin";
import type { makeVars } from "./vars";

export type ModelFactory = () => Promise<{
  default: ReturnType<typeof makeModel>;
}>;

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
export type VarsFactory = () => Promise<{
  default: ReturnType<typeof makeVars>;
}>;

// A helper file's default export is one defineHelper() — a stateless function
// registered as an Edge global by its own name, unlike models/vars which are
// DB-backed objects registered by prefix.
export type HelperFactory = () => Promise<{ default: Helper }>;

// An MCP tool file's default export is one defineTool() — registered on the /mcp server next
// to the built-in content tools, by its own name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type McpToolFactory = () => Promise<{ default: McpTool<any> }>;

// An extra place logs are written to, on top of the console. `stream` is anything pino accepts
// as a destination — a Writable, or any object with `write(line: string)` — so ready-made
// pino streams (pino-loki, pino-datadog, ...) plug in directly. Runs in-process, no worker thread.
export type LoggerStream = {
  stream: DestinationStream;
  // Minimum level this stream receives (default: the logger's own level).
  level?: Level;
};

// A static route is a page route cached after its first render: a plain path ("/", "/about") or a
// dynamic one with `:param` / `[param]` segments ("/blog/:slug"), each URL cached on its own.
// `revalidate` (seconds) makes a cached page stale after that long: the next request still gets
// the old HTML, and a fresh render replaces it in the background.
export type StaticRoute = string | { route: string; revalidate?: number };
export type ResolvedStaticRoute = { route: string; revalidate?: number };

export const normalizeStaticRoute = (route: string): string => {
  const normalized = route.replace(/\[([^\]/]+)\]/g, ":$1");
  if (
    !normalized.startsWith("/") ||
    /[[\]*]|\.\.|\/\//.test(normalized) ||
    /:(?![A-Za-z_]\w*(\/|$))/.test(normalized)
  ) {
    throw new Error(
      `Invalid static route "${route}" — expected a page path such as "/", "/about" or "/blog/:slug" (no wildcard or ".." segments).`,
    );
  }
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
};

export const resolveStaticRoute = (entry: StaticRoute): ResolvedStaticRoute => {
  const { route, revalidate } =
    typeof entry === "string" ? { route: entry, revalidate: undefined } : entry;
  if (
    revalidate !== undefined &&
    !(Number.isFinite(revalidate) && revalidate > 0)
  ) {
    throw new Error(
      `Invalid revalidate ${revalidate} for static route "${route}" — expected a positive number of seconds.`,
    );
  }
  return { route: normalizeStaticRoute(route), revalidate };
};

export type NjinConfig = {
  port?: number;
  // Public base URL of the site as clients reach it (e.g. "https://example.com") — used for
  // the OAuth/MCP discovery documents, which must name the exact host an agent connects to.
  // Optional: falls back to the request's own origin (see core/public_url.ts), which is
  // enough for a single-host setup without a proxy rewriting Host.
  publicUrl?: string;
  mcp?: {
    // Extra OAuth callback URLs an MCP client may register, on top of the built-in ones (Claude,
    // ChatGPT, Cursor, VS Code, and any loopback address). An entry is matched exactly, or as a
    // path prefix when it ends in "*" ("https://app.example.com/oauth/*"). Only add callbacks of
    // clients you trust: it is where the authorization code is sent after a user signs in.
    redirectUris?: string[];
    // Custom tools offered to agents on top of the built-in ones.
    tools?: McpToolFactory[];
  };
  logger?: {
    // Minimum level logged at all (default "info"). A stream's own level can only be stricter.
    level?: Level;
    // Pretty-printed console output (default true). Turn off to log only to `streams`.
    console?: boolean;
    // Extra destinations, written as JSON lines.
    streams?: LoggerStream[];
  };
  // Base directory every project-relative path (src/views, _admin, public, upload dirs)
  // resolves against. Defaults to process.cwd() — only needs overriding by a build step
  // (see build-worker.ts) that bakes in an absolute path for a runtime whose cwd isn't
  // reliably the project root, e.g. multiple `new Worker(...)` instances sharing one
  // supervisor process's cwd.
  rootDir?: string;
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
    // The database. Defaults to a SurrealDB adapter built from `db` above; set this to use
    // another adapter instead (then `db` is ignored).
    db?: DbAdapter;
  };
  models?: ModelFactory[];
  hooks?: HookFactory[];
  events?: EventFactory[];
  routes?: RouteFactory[];
  vars?: VarsFactory[];
  helpers?: HelperFactory[];
  plugins?: Plugin[];
  // Page routes rendered on their first request in production and then served from a cached HTML
  // file until purged with purgeStatic() (from "@njinlabs/njin/static") or, with `revalidate`,
  // until it is that many seconds old. `njin dev` ignores this and always renders live.
  static?: StaticRoute[];
  // A shared cache (Varnish…) in front of njin. purgeStatic() sends each URL here as an HTTP
  // `BAN` request, so the cache drops its copy together with njin's own. Omit it when nothing
  // caches in front of njin.
  edgeCache?: {
    // Base URL(s) of the cache to notify, e.g. "http://127.0.0.1:6081".
    ban: string | string[];
    // Extra headers on every BAN request (e.g. an auth token the VCL checks).
    headers?: Record<string, string>;
  };
  // The languages the site is written in. Models made with `i18n: true` keep their `localized`
  // fields once per locale listed here.
  i18n?: {
    // Locale codes such as "id", "en", "pt-BR".
    locales: string[];
    // The locale a missing translation falls back to. Defaults to the first of `locales`.
    defaultLocale?: string;
  };
};

export type ResolvedConfig = {
  port: number;
  publicUrl?: string;
  mcp: { redirectUris: string[]; tools: McpToolFactory[] };
  logger: { level: Level; console: boolean; streams: LoggerStream[] };
  rootDir: string;
  db: {
    path: string;
    namespace: string;
    database: string;
    auth?: { username: string; password: string } | string;
  };
  img: { hosts: string[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapters: { file: FileAdapter<any>; db: DbAdapter };
  models: ModelFactory[];
  hooks: HookFactory[];
  events: EventFactory[];
  routes: RouteFactory[];
  vars: VarsFactory[];
  helpers: HelperFactory[];
  static: ResolvedStaticRoute[];
  edgeCache?: { ban: string[]; headers: Record<string, string> };
  i18n?: { locales: readonly string[]; defaultLocale: string };
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

  const db = {
    path: userConfig.db?.path ?? "rocksdb://data",
    namespace: userConfig.db?.namespace ?? "general",
    database: userConfig.db?.database ?? "general",
    auth: userConfig.db?.auth,
  };

  // Plugin-contributed models/vars/hooks/events/routes come first, then the project's
  // own — a plugin is the foundation being extended, so its registrations run first and
  // the project's own can build on top of (or follow) whatever the plugin set up. No
  // collision detection: two plugins (or a plugin and the project) registering the same
  // prefix fails the same way it already does today — naturally, at runtime.
  resolved = {
    port: userConfig.port ?? 3000,
    publicUrl: userConfig.publicUrl,
    mcp: {
      redirectUris: userConfig.mcp?.redirectUris ?? [],
      tools: [
        ...plugins.flatMap((p) => p.mcp?.tools ?? []),
        ...(userConfig.mcp?.tools ?? []),
      ],
    },
    logger: {
      level: userConfig.logger?.level ?? ("info" as Level),
      console: userConfig.logger?.console ?? true,
      streams: [
        ...plugins.flatMap((p) => p.logger?.streams ?? []),
        ...(userConfig.logger?.streams ?? []),
      ],
    },
    rootDir: userConfig.rootDir ?? process.cwd(),
    db,
    img: { hosts: userConfig.img?.hosts ?? [] },
    adapters: {
      file: userConfig.adapters?.file ?? bunFilesystemAdapter(),
      db: userConfig.adapters?.db ?? surrealAdapter(db),
    },
    models: [
      ...plugins.flatMap((p) => p.models ?? []),
      ...(userConfig.models ?? []),
    ],
    hooks: [
      ...plugins.flatMap((p) => p.hooks ?? []),
      ...(userConfig.hooks ?? []),
    ],
    events: [
      ...plugins.flatMap((p) => p.events ?? []),
      ...(userConfig.events ?? []),
    ],
    routes: [
      ...plugins.flatMap((p) => p.routes ?? []),
      ...(userConfig.routes ?? []),
    ],
    vars: [...plugins.flatMap((p) => p.vars ?? []), ...(userConfig.vars ?? [])],
    helpers: [
      ...plugins.flatMap((p) => p.helpers ?? []),
      ...(userConfig.helpers ?? []),
    ],
    static: [
      ...new Map(
        [
          ...plugins.flatMap((p) => p.static ?? []),
          ...(userConfig.static ?? []),
        ]
          .map(resolveStaticRoute)
          .map((r) => [r.route, r] as const),
      ).values(),
    ],
    edgeCache: userConfig.edgeCache && {
      ban: [userConfig.edgeCache.ban].flat().map((u) => u.replace(/\/$/, "")),
      headers: userConfig.edgeCache.headers ?? {},
    },
    i18n: resolveI18n(userConfig.i18n),
    pluginInits: plugins
      .map((p) => p.init)
      .filter(
        (fn): fn is () => Promise<void> | void => typeof fn === "function",
      ),
  };
};

const LOCALE_CODE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const resolveI18n = (input: NjinConfig["i18n"]): ResolvedConfig["i18n"] => {
  if (!input) return undefined;

  const locales = input.locales.map((l) => l.trim());
  if (locales.length === 0) {
    throw new Error("config.i18n.locales needs at least one locale.");
  }
  for (const locale of locales) {
    if (!LOCALE_CODE.test(locale)) {
      throw new Error(
        `config.i18n.locales: "${locale}" is not a locale code (expected something like "en" or "pt-BR").`,
      );
    }
  }
  if (new Set(locales).size !== locales.length) {
    throw new Error("config.i18n.locales lists a locale twice.");
  }

  const defaultLocale = input.defaultLocale ?? locales[0]!;
  if (!locales.includes(defaultLocale)) {
    throw new Error(
      `config.i18n.defaultLocale "${defaultLocale}" is not in config.i18n.locales.`,
    );
  }

  return { locales, defaultLocale };
};

export const getConfig = (): ResolvedConfig => {
  if (!resolved)
    throw new Error(
      "Config not loaded yet — loadConfig() must run before getConfig() is called.",
    );
  return resolved;
};
