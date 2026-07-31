import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const outDir = join(root, "out");

console.log("Building for production...\n");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Vite build — outDir is forced here regardless of what the project's own
// vite.config.ts says, so `njin build` always lands in a predictable place.
const { build } = await import("vite");
await build({
  configFile: join(root, "vite.config.ts"),
  build: { outDir: join(outDir, "public"), emptyOutDir: true },
});
console.log("✓ Built client assets -> out/public");

// view.ts resolves views from process.cwd()/src/views at runtime, so the build
// output preserves that same relative layout instead of flattening it.
const viewsDir = join(root, "src/views");
if (existsSync(viewsDir)) {
  await cp(viewsDir, join(outDir, "src/views"), { recursive: true });
  console.log("✓ Copied views -> out/src/views");
} else {
  console.log("• No src/views found — skipped");
}

const adminDir = join(root, "_admin");
if (existsSync(adminDir)) {
  await cp(adminDir, join(outDir, "_admin"), { recursive: true });
  console.log("✓ Copied admin panel -> out/_admin");
} else {
  console.log("• No _admin found — skipped");
}

// surreal.ts only imports @surrealdb/node dynamically, on the embedded-db.path branch — so a
// project whose resolved db.path is remote (ws/wss/http/https) never needs its native binding
// at all. We resolve the project's own config here (same file loadConfig() reads from
// process.cwd() at runtime) to decide, at build time, whether to bundle it.
const { loadConfig, getConfig } = await import("../core/config");
const { isRemotePath } = await import("../modules/surreal");

// If the project's config.ts can't be resolved here (missing, throws, or its db.path depends
// on an env var not set at build time), default to embedded — the binding just goes unused in
// a genuinely remote deployment, same as today, rather than risking a binary that can't do
// embedded mode if the env var resolves differently at runtime than it did at build time.
let isRemoteBuild = false;
try {
  await loadConfig();
  isRemoteBuild = isRemotePath(getConfig().db.path);
} catch {
  isRemoteBuild = false;
}

// surreal.ts's dynamic import() of @surrealdb/node is still literal-specifier, so Bun's
// bundler would otherwise trace and embed it regardless of which branch runs at runtime. Its
// loader resolves the platform .node file via `const require = createRequire(import.meta.url);
// require("./surrealdb-node.<platform>.node")` — using a local `require` value rather than the
// literal CJS keyword means Bun's bundler never statically recognizes that call as an import to
// resolve/embed, so when the package IS bundled it survives untouched and then fails at runtime
// in a compiled binary (no real filesystem path next to `import.meta.url` to load it from). So
// for an embedded build, instead of embedding it, the matching platform binary is copied next
// to the executable as a plain file, and a build plugin patches the loader's source to read
// from there (via `process.execPath`'s directory) at runtime. For a remote build, the package
// is excluded from the bundle entirely (see `external` below) since that branch is unreachable.
const NATIVE_FILE: Record<string, string> = {
  "win32-x64": "surrealdb-node.win32-x64-msvc.node",
  "win32-arm64": "surrealdb-node.win32-arm64-msvc.node",
  "darwin-x64": "surrealdb-node.darwin-x64.node",
  "darwin-arm64": "surrealdb-node.darwin-arm64.node",
  // musl isn't detected here (njin build doesn't cross-compile); glibc is assumed on Linux.
  "linux-x64": "surrealdb-node.linux-x64-gnu.node",
  "linux-arm64": "surrealdb-node.linux-arm64-gnu.node",
};

let surrealNativePlugin: BunPlugin | undefined;
if (isRemoteBuild) {
  console.log("• Remote db.path detected — skipping @surrealdb/node native binding");
} else {
  const nativeFile = NATIVE_FILE[`${process.platform}-${process.arch}`];
  if (!nativeFile) {
    console.error(`\n✗ Unsupported platform for @surrealdb/node: ${process.platform}-${process.arch}`);
    process.exit(1);
  }

  const surrealNodeDistDir = dirname(fileURLToPath(import.meta.resolve("@surrealdb/node")));
  const bindingsDir = join(outDir, "bindings");
  await mkdir(bindingsDir, { recursive: true });
  await cp(join(surrealNodeDistDir, nativeFile), join(bindingsDir, nativeFile));
  console.log(`✓ Copied native binding -> out/bindings/${nativeFile}`);

  surrealNativePlugin = {
    name: "surrealdb-native-binding",
    setup(build) {
      build.onLoad({ filter: /surrealdb-node\.mjs$/ }, async (args) => {
        const original = await Bun.file(args.path).text();
        const marker = "const require = createRequire(import.meta.url);";
        if (!original.includes(marker)) {
          throw new Error("@surrealdb/node's loader shape changed — expected createRequire marker not found");
        }
        // Wrap `require` so the host platform's own .node lookup is redirected to the copy in
        // out/bindings/; every other platform's file and the optional sibling npm packages fall
        // through to the real require() and fail exactly as they would unpatched (still recorded
        // in the loader's own loadErrors, so a genuinely missing binding still throws clearly).
        const patched = original.replace(
          marker,
          `const __realRequire = createRequire(import.meta.url);
const require = (specifier) => {
  if (specifier === ${JSON.stringify(`./${nativeFile}`)}) {
    const path = __realRequire("node:path");
    return __realRequire(path.join(path.dirname(process.execPath), "bindings", ${JSON.stringify(nativeFile)}));
  }
  return __realRequire(specifier);
};`,
        );
        return { contents: patched, loader: "js" };
      });
    },
  };
}

// Generated build entry — a static, literal import of the project's config.ts so
// `bun build --compile` can trace and embed it (and the model files it dynamically
// imports) straight into the binary. loadConfig()'s normal dynamic-file-read path
// only works when running from source (`njin dev`/`njin start`), not from a
// standalone compiled executable with no source files alongside it.
//
// boot/banner are imported dynamically, AFTER loadConfig(config) — static imports are
// hoisted and evaluated before this file's own body runs, so a static `import { boot }`
// would pull in config/module.ts (and every module's init(), which read getConfig()) before
// loadConfig(config) below ever executes. Same reasoning as dev.ts/start.ts.
// geoip-lite resolves its .dat files via path.resolve(__dirname, '../data/') at module-load
// time. Bun bakes __dirname into bundled output as the literal build-time path, so a compiled
// binary still points at node_modules/geoip-lite/data on the machine that ran `njin build` —
// which won't exist wherever the binary is actually deployed. Same fix shape as the SurrealDB
// native binding above: ship the data dir next to the executable and patch the lookup.
// Only the country .dat files are shipped — analytics.ts only ever reads the `country` field,
// and geoip-lite falls back to country-only mode automatically when the (much larger, ~100MB)
// city .dat files are absent, keeping the buffers it preloads into memory at startup small.
const geoipLibDir = dirname(fileURLToPath(import.meta.resolve("geoip-lite")));
const geoipDataDir = join(geoipLibDir, "..", "data");
const outGeoipDataDir = join(outDir, "geoip-data");
await mkdir(outGeoipDataDir, { recursive: true });
await cp(join(geoipDataDir, "geoip-country.dat"), join(outGeoipDataDir, "geoip-country.dat"));
await cp(join(geoipDataDir, "geoip-country6.dat"), join(outGeoipDataDir, "geoip-country6.dat"));
console.log("✓ Copied geoip-lite country data -> out/geoip-data");

const geoipDataPlugin: BunPlugin = {
  name: "geoip-lite-data-dir",
  setup(build) {
    build.onLoad({ filter: /geoip-lite[\\/]lib[\\/]geoip\.js$/ }, async (args) => {
      const original = await Bun.file(args.path).text();
      const marker = "global.geodatadir || process.env.GEODATADIR || '../data/'";
      if (!original.includes(marker)) {
        throw new Error("geoip-lite's data dir resolution changed — expected marker not found");
      }
      const patched = original.replace(
        "var geodatadir = path.resolve(\n\t__dirname,\n\t" + marker + "\n);",
        "var geodatadir = require('path').join(require('path').dirname(process.execPath), 'geoip-data');",
      );
      if (patched === original) {
        throw new Error("geoip-lite's geodatadir block didn't match expected shape — patch did not apply");
      }
      return { contents: patched, loader: "js" };
    });
  },
};

const entryPath = join(root, ".njin-build-entry.ts");
const configPath = join(root, "config.ts").replace(/\\/g, "/");

try {
  await Bun.write(
    entryPath,
    `import config from ${JSON.stringify(configPath)};
import { loadConfig } from "@njinlabs/njin/config";

await loadConfig(config);

const { boot } = await import("@njinlabs/njin/boot");
const { printBanner } = await import("@njinlabs/njin/banner");

await boot();
printBanner({ mode: "production" });
`,
  );

  const exeName = process.platform === "win32" ? "server.exe" : "server";

  const result = await Bun.build({
    entrypoints: [entryPath],
    compile: { outfile: join(outDir, exeName) },
    // vite is dev-only (view.ts gates it behind `if (isDev)`, dead in production) — bundling
    // it would also drag in its own internal (not-installed) lazy `import("esbuild")`. Same
    // reasoning for @surrealdb/node on a remote build — surreal.ts's dynamic import of it is
    // unreachable when db.path is remote, so it's safe to leave unresolved.
    external: isRemoteBuild ? ["vite", "@surrealdb/node"] : ["vite"],
    plugins: [surrealNativePlugin, geoipDataPlugin].filter((p): p is BunPlugin => p !== undefined),
    // The CLI's `bun build --compile` implicitly inlines process.env.NODE_ENV as "production";
    // the Bun.build() JS API doesn't, so view.ts's top-level `isDev` check would otherwise read
    // undefined and take the dev branch (importing the externalized, not-on-disk `vite`).
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });

  if (!result.success) {
    console.error("\n✗ Build failed");
    for (const message of result.logs) console.error(message);
    process.exit(1);
  }

  console.log(`\n✓ Compiled server -> out/${exeName}`);
  console.log(
    isRemoteBuild
      ? "\nNote: out/geoip-data/ must ship alongside the executable — it holds the geoip-lite " +
          "database loaded at runtime. No native SurrealDB binding was bundled (remote db.path)."
      : "\nNote: out/bindings/ and out/geoip-data/ must ship alongside the executable — they hold " +
          "the native SurrealDB binding and the geoip-lite database loaded at runtime.",
  );
  console.log(`\nRun it with:\n  cd out && ./${exeName}`);
} finally {
  await rm(entryPath, { force: true });
}
