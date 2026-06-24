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

// surreal.ts statically imports @surrealdb/node unconditionally, and module.ts always wires
// up the surreal module, so every compiled binary needs this native binding to boot — even
// for projects using a remote SurrealDB instance. Its loader resolves the platform .node file
// via `const require = createRequire(import.meta.url); require("./surrealdb-node.<platform>.node")`
// — using a local `require` value rather than the literal CJS keyword means Bun's bundler never
// statically recognizes that call as an import to resolve/embed, so it survives bundling
// untouched and then fails at runtime in a compiled binary (no real filesystem path next to
// `import.meta.url` to load it from). So instead of embedding it, the matching platform binary
// is copied next to the executable as a plain file, and a build plugin patches the loader's
// source to read from there (via `process.execPath`'s directory) at runtime.
const NATIVE_FILE: Record<string, string> = {
  "win32-x64": "surrealdb-node.win32-x64-msvc.node",
  "win32-arm64": "surrealdb-node.win32-arm64-msvc.node",
  "darwin-x64": "surrealdb-node.darwin-x64.node",
  "darwin-arm64": "surrealdb-node.darwin-arm64.node",
  // musl isn't detected here (njin build doesn't cross-compile); glibc is assumed on Linux.
  "linux-x64": "surrealdb-node.linux-x64-gnu.node",
  "linux-arm64": "surrealdb-node.linux-arm64-gnu.node",
};
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

const surrealNativePlugin: BunPlugin = {
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
    // it would also drag in its own internal (not-installed) lazy `import("esbuild")`.
    external: ["vite"],
    plugins: [surrealNativePlugin],
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
    "\nNote: out/bindings/ must ship alongside the executable — it holds the native SurrealDB " +
      "binding loaded at runtime.",
  );
  console.log(`\nRun it with:\n  cd out && ./${exeName}`);
} finally {
  await rm(entryPath, { force: true });
}
