import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";
import type { AdapterBuild, AdapterBuildContext } from "../db/contract";

// What `njin build` / `njin build:worker` need to know about SurrealDB, kept here so the build
// commands never mention it. Loaded on demand by surrealAdapter().build() — nothing at runtime
// reaches this file.

// @surrealdb/node's loader resolves the platform .node file via `const require =
// createRequire(import.meta.url); require("./surrealdb-node.<platform>.node")` — using a local
// `require` value rather than the literal CJS keyword means Bun's bundler never statically
// recognizes that call as an import to resolve/embed, so when the package IS bundled it survives
// untouched and then fails at runtime in a compiled binary (no real filesystem path next to
// `import.meta.url` to load it from). So for an embedded build, instead of embedding it, the
// matching platform binary is copied next to the executable as a plain file, and a build plugin
// patches the loader's source to read from there (via `process.execPath`'s directory) at runtime.
// For a remote build, or a worker bundle that runs from inside the project tree, the package is
// kept out of the bundle entirely (`external`) and resolved from node_modules.
const NATIVE_FILE: Record<string, string> = {
  "win32-x64": "surrealdb-node.win32-x64-msvc.node",
  "win32-arm64": "surrealdb-node.win32-arm64-msvc.node",
  "darwin-x64": "surrealdb-node.darwin-x64.node",
  "darwin-arm64": "surrealdb-node.darwin-arm64.node",
  // musl isn't detected here (njin build doesn't cross-compile); glibc is assumed on Linux.
  "linux-x64": "surrealdb-node.linux-x64-gnu.node",
  "linux-arm64": "surrealdb-node.linux-arm64-gnu.node",
};

export const surrealBuild = async (
  remote: boolean,
  ctx: AdapterBuildContext,
): Promise<AdapterBuild> => {
  // The worker bundle runs from inside a real project tree, so the real node_modules package
  // just resolves — no copy or patch needed, it only must not be bundled.
  if (ctx.target === "worker") return { external: ["@surrealdb/node"] };

  // The dynamic import of @surrealdb/node in the adapter is unreachable for a remote path, so
  // it's safe to leave unresolved.
  if (remote) {
    ctx.log(
      "• Remote db.path detected — skipping @surrealdb/node native binding",
    );
    return {
      external: ["@surrealdb/node"],
      notes: ["No native SurrealDB binding was bundled (remote db.path)."],
    };
  }

  const platform = `${process.platform}-${process.arch}`;
  const nativeFile = NATIVE_FILE[platform];
  if (!nativeFile) {
    throw new Error(`Unsupported platform for @surrealdb/node: ${platform}`);
  }

  const distDir = dirname(
    fileURLToPath(import.meta.resolve("@surrealdb/node")),
  );
  const bindingsDir = join(ctx.outDir, "bindings");
  await mkdir(bindingsDir, { recursive: true });
  await cp(join(distDir, nativeFile), join(bindingsDir, nativeFile));
  ctx.log(`✓ Copied native binding -> out/bindings/${nativeFile}`);

  const plugin: BunPlugin = {
    name: "surrealdb-native-binding",
    setup(build) {
      build.onLoad({ filter: /surrealdb-node\.mjs$/ }, async (args) => {
        const original = await Bun.file(args.path).text();
        const marker = "const require = createRequire(import.meta.url);";
        if (!original.includes(marker)) {
          throw new Error(
            "@surrealdb/node's loader shape changed — expected createRequire marker not found",
          );
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

  return {
    plugins: [plugin],
    notes: [
      "out/bindings/ holds the native SurrealDB binding loaded at runtime.",
    ],
  };
};
