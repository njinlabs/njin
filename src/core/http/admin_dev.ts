import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin, PluginOption } from "vite";

// The dev server's address, once it is listening: the manifest points the admin's plugins at it.
let devUrl: string | undefined;

export const setAdminDevUrl = (url: string | undefined) => {
  devUrl = url?.replace(/\/$/, "");
};

// The contract version of the installed admin. A plugin served from source is built against it by
// definition, and the admin refuses a plugin that does not say which contract it is for.
let devContract: number | undefined;

// Vite names files with forward slashes, on Windows too.
const slashes = (path: string) => path.replace(/\\/g, "/");

// A name for messages: the folder the plugin's admin side sits in ("reports/admin/index.tsx").
export const pluginName = (entry: string) => {
  const parts = toPath(entry).split("/").slice(0, -1);
  // "admin/dist/index.js" of a package that ships built, "admin/index.tsx" of source.
  if (parts.at(-1) === "dist") parts.pop();
  if (parts.at(-1) === "admin") parts.pop();
  return parts.at(-1) ?? "plugin";
};

// `import.meta.resolve("./admin/index.tsx")` gives a file: URL; a plain path is fine too.
export const toPath = (entry: string) =>
  slashes(entry.startsWith("file:") ? fileURLToPath(entry) : entry);

// What the admin loads of a plugin (GET /api/admin/manifest).
export type ManifestPlugin = {
  name: string;
  entry: string;
  styles?: string[];
  contract?: number;
};

// A plugin that ships built (an npm package carries `admin/dist`) has a `contract.json` beside
// its script, written by the admin's build. Anything else is a source file.
const contractFile = (entry: string) =>
  join(dirname(toPath(entry)), "contract.json");

export const isBuiltPlugin = (entry: string) => existsSync(contractFile(entry));

export const builtContract = (entry: string): number | undefined => {
  if (!isBuiltPlugin(entry)) return;
  return (
    JSON.parse(readFileSync(contractFile(entry), "utf8")) as {
      version?: number;
    }
  ).version;
};

// Where `njin build` puts the built plugins, and the list the manifest is made from in production.
export const PLUGINS_LIST = "_admin/plugins/plugins.json";

const builtManifest = (rootDir?: string): ManifestPlugin[] => {
  if (!rootDir) return [];
  const file = join(rootDir, PLUGINS_LIST);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ManifestPlugin[];
  } catch {
    return [];
  }
};

// In development a plugin is its source file, served by the dev server (Vite transforms it as it
// is asked for); one that ships built is served as it is, with its stylesheet beside it. In
// production the plugins are what `njin build` left in `_admin/plugins`.
export const adminManifest = (
  entries: string[],
  rootDir?: string,
): { plugins: ManifestPlugin[] } => {
  if (!devUrl) return { plugins: builtManifest(rootDir) };

  return {
    plugins: entries.map((entry) => {
      const path = toPath(entry);
      const base = { name: pluginName(entry), entry: `${devUrl}/@fs/${path}` };

      if (isBuiltPlugin(entry)) {
        const css = `${path.slice(0, path.lastIndexOf("/"))}/index.css`;
        return {
          ...base,
          ...(existsSync(css) ? { styles: [`${devUrl}/@fs/${css}`] } : {}),
          contract: builtContract(entry),
        };
      }

      return {
        ...base,
        ...(devContract === undefined ? {} : { contract: devContract }),
      };
    }),
  };
};

const SHARED = "\0njin-shared:";
const GLOBAL = "__njin";
const JSX_DEV = "react/jsx-dev-runtime";

const clean = (id: string) => slashes(id.split("?")[0] ?? id);

const isName = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name);

// A module that reads the admin's copy of `name` from where the admin put it (see the admin's
// `exposeShared`). Named exports are listed from the real module so `import { useState }` works.
const sharedSource = (name: string, keys: string[]) => {
  const read = `globalThis.${GLOBAL}[${JSON.stringify(name)}]`;
  const names = keys.filter((key) => key !== "default" && isName(key));

  return [
    `const m = ${read};`,
    "export default m.default ?? m;",
    ...names.map((key) => `export const ${key} = m.${key};`),
  ].join("\n");
};

// The admin shares only the production JSX runtime, but Vite compiles JSX for development.
const jsxDevSource = () =>
  [
    `const m = globalThis.${GLOBAL}["react/jsx-runtime"];`,
    "export const Fragment = m.Fragment;",
    "export const jsx = m.jsx;",
    "export const jsxs = m.jsxs;",
    "export const jsxDEV = (type, props, key, isStatic) =>",
    "  (isStatic ? m.jsxs : m.jsx)(type, props, key);",
  ].join("\n");

// "react-icons/pi" -> "react-icons", "@scope/pkg/sub" -> "@scope/pkg".
const packageOf = (id: string) =>
  id
    .split("/")
    .slice(0, id.startsWith("@") ? 2 : 1)
    .join("/");

type Options = {
  // The plugins' entry files (as in `Plugin.admin`).
  entries: string[];
  // The modules the admin shares with its plugins (`sharedModules` of the admin package).
  shared: readonly string[];
  // The names a shared module exports.
  exportsOf: (name: string) => Promise<string[]>;
  // Vite's, passed in so this file does not import it when nothing is in development.
  searchForWorkspaceRoot: (root: string) => string;
};

// Whether a Vite config's plugin list (nested, possibly promises) holds a plugin called `prefix…`.
export const hasPlugin = async (
  list: unknown,
  prefix: string,
): Promise<boolean> => {
  const item = await list;
  if (Array.isArray(item)) {
    for (const entry of item) if (await hasPlugin(entry, prefix)) return true;
    return false;
  }
  const name = (item as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && name.startsWith(prefix);
};

// The plugin's source runs in the admin's page, which is already running its own React, router,
// query client and kit. A second copy of any of them breaks hooks and context, so inside the
// plugin's files (the entry and what it imports) those imports read the admin's copy instead.
// A production build does the same with `externalGlobals`.
export const adminPluginDev = ({
  entries,
  shared,
  exportsOf,
  searchForWorkspaceRoot,
}: Options): Plugin => {
  const paths = entries.map(toPath);
  // Files that belong to a plugin: its entries, and whatever they import.
  const graph = new Set(paths);
  const names = new Set(shared);
  const sharedPackages = new Set([...shared].map(packageOf));
  // Packages the plugin imports that Vite must not pre-bundle (see `bundlesShared`).
  const raw = new Map<string, boolean>();
  let exclude: string[] = [];

  // Whether a package built on a shared module (an icon set on React) is imported from `from`.
  // Vite pre-bundles such a package with a copy of React inside, out of reach of the redirect
  // below; served as it is, its own imports of React are redirected like the plugin's.
  const bundlesShared = (pkg: string, from: string) => {
    const known = raw.get(pkg);
    if (known !== undefined) return known;

    let dir = dirname(from);
    for (;;) {
      const file = join(dir, "node_modules", pkg, "package.json");
      if (existsSync(file)) {
        const json = JSON.parse(readFileSync(file, "utf8")) as Record<
          string,
          Record<string, string> | undefined
        >;
        const uses = Object.keys({
          ...json.dependencies,
          ...json.peerDependencies,
        }).some((name) => sharedPackages.has(name));
        raw.set(pkg, uses);
        return uses;
      }
      const up = dirname(dir);
      if (up === dir) return false;
      dir = up;
    }
  };

  return {
    name: "njin:admin-plugin-dev",
    apply: "serve",
    enforce: "pre",

    configResolved(config) {
      config.optimizeDeps.exclude ??= [];
      exclude = config.optimizeDeps.exclude;
    },

    // Setting `allow` replaces Vite's default, so the project's own root stays in it.
    config: () => ({
      server: {
        fs: {
          allow: [
            searchForWorkspaceRoot(process.cwd()),
            ...paths.map((path) => path.slice(0, path.lastIndexOf("/"))),
          ],
        },
      },
    }),

    async resolveId(id, importer, options) {
      if (!importer || !graph.has(clean(importer))) return;

      if (id === JSX_DEV || names.has(id)) return `${SHARED}${id}`;

      if (!id.startsWith(".") && !id.startsWith("/")) {
        const pkg = packageOf(id);
        if (bundlesShared(pkg, clean(importer)) && !exclude.includes(pkg)) {
          exclude.push(pkg);
        }
      }

      const resolved = await this.resolve(id, importer, {
        ...options,
        skipSelf: true,
      });
      if (resolved && !resolved.external) graph.add(clean(resolved.id));

      return resolved;
    },

    async load(id) {
      if (!id.startsWith(SHARED)) return;

      const name = id.slice(SHARED.length);

      return name === JSX_DEV
        ? jsxDevSource()
        : sharedSource(name, await exportsOf(name));
    },
  };
};

// The plugin for the dev server, or nothing when there are no admin plugins to serve. The list of
// shared modules comes from the admin package the project installed, so it is always the list
// that admin's plugins were written against.
export const loadAdminPluginDev = async (
  entries: string[],
  searchForWorkspaceRoot: (root: string) => string,
  // Vite's, to read the project's own Vite config (see the Tailwind note below).
  projectPlugins: () => Promise<unknown> = async () => undefined,
): Promise<PluginOption[] | undefined> => {
  if (entries.length === 0) return;

  const here = (name: string) =>
    pathToFileURL(Bun.resolveSync(name, process.cwd())).href;

  let shared: readonly string[];
  try {
    const admin = await import(here("@njinlabs/njin-admin/shared"));
    shared = admin.sharedModules;
    devContract = admin.contract?.version;
  } catch {
    console.warn(
      "Plugins list an admin side, but @njinlabs/njin-admin is not installed: they are not served.",
    );
    return;
  }

  const dev = adminPluginDev({
    entries,
    shared,
    exportsOf: async (name) => Object.keys(await import(here(name))),
    searchForWorkspaceRoot,
  });

  // A plugin's stylesheet is Tailwind source, and without Tailwind in Vite the dev server serves
  // it as it is. A project that does not use Tailwind itself gets it for the plugins' sake, from
  // the admin package, which depends on it.
  if (await hasPlugin(await projectPlugins(), "@tailwindcss/vite"))
    return [dev];

  try {
    const fromAdmin = Bun.resolveSync(
      "@njinlabs/njin-admin/shared",
      process.cwd(),
    );
    const tailwind = Bun.resolveSync("@tailwindcss/vite", dirname(fromAdmin));
    return [dev, (await import(pathToFileURL(tailwind).href)).default()];
  } catch {
    console.warn(
      "Could not load @tailwindcss/vite: the stylesheets of plugins are not compiled.",
    );
    return [dev];
  }
};
