import { rm } from "node:fs/promises";
import { join } from "node:path";
import { stageBuildAssets } from "./build-assets";

const root = process.cwd();
const outDir = join(root, "out");

console.log("Building worker for production...\n");

await stageBuildAssets(root, outDir);

// Unlike `njin build`, this targets `bun out/worker.js` (or `new Worker("out/worker.js")`)
// running from inside the project tree (not a self-contained binary), so node_modules is
// always reachable via Bun's normal upward directory resolution — no need for build.ts's
// native-binding/geoip path patching for the two packages that do stay external below.
const entryPath = join(root, ".njin-worker-entry.ts");
const configPath = join(root, "config.ts").replace(/\\/g, "/");

try {
  await Bun.write(
    entryPath,
    `import config from ${JSON.stringify(configPath)};
import { loadConfig } from "@njinlabs/njin/config";

// Both env vars must be set for real, and before the dynamic import() of boot below: static
// imports are hoisted and evaluated before this file's own body runs, so view.ts (reached
// transitively through that import) would otherwise still see NODE_ENV unset. Same reasoning
// as dev.ts/start.ts.
//
// NODE_ENV in particular is also baked in at build time via the "define" option below —
// @njinlabs/njin's own source (view.ts's dev/production check included) is bundled directly
// into worker.js (see the explicit "external" list below), not left as a separate runtime
// import, specifically because a Bun Worker thread does not reliably propagate an in-script
// process.env mutation across a module resolved from a genuinely external package — this
// runtime assignment is belt-and-suspenders for anything that still reads it at runtime
// (e.g. NJIN_WORKER, now read from the same bundled scope elysia.ts lives in).
process.env.NODE_ENV = "production";
process.env.NJIN_WORKER = "1";

// Defaults rootDir to wherever this bundle itself physically ends up at runtime — not
// process.cwd() (a supervisor process's Worker threads all share its cwd, so a runtime cwd
// fallback would resolve src/views, _admin, public, and upload dirs against the wrong
// directory), and not a literal build-time path baked in as a string constant either (that
// would keep pointing at this build's own source tree even after out/worker.js — and the
// public/src/views/_admin siblings staged alongside it — get copied somewhere else
// entirely, e.g. into a supervisor's per-client clients/<host>/ directory). import.meta.dir
// inside a Bun-bundled file resolves to that file's own real location at runtime, so it
// stays correct no matter where the bundle is moved.
await loadConfig({ ...config, rootDir: config.rootDir ?? import.meta.dir });

const { boot } = await import("@njinlabs/njin/boot");

// No printBanner() here — headless has no port/admin URL to show. serveWorker()'s own
// "ready" postMessage() (src/core/worker.ts) is the supervisor's readiness signal instead.
await boot();
`,
  );

  const result = await Bun.build({
    entrypoints: [entryPath],
    outdir: outDir,
    naming: "worker.js",
    target: "bun",
    // @njinlabs/njin's own source bundles directly into worker.js (see the comment in the
    // generated entry above for why) — only the two packages that genuinely can't survive
    // bundling stay external, same reasoning build.ts already documents for its own build:
    // vite is dev-only (dead code once NODE_ENV is baked in as "production" below, but its own
    // internal lazy import("esbuild") isn't installed as a real dependency) and @surrealdb/node
    // is a native binding whose loader resolves its .node file relative to its own real
    // file location — bundled, that location would become worker.js's, breaking the lookup.
    // geoip-lite is external for a related reason: it resolves its .dat files via
    // path.resolve(__dirname, '../data/'), and Bun bakes __dirname into bundled output as the
    // literal build-time path (see build.ts) — fine on the exact machine that ran this build,
    // but not guaranteed if out/ is copied elsewhere before running. Staying external keeps
    // its own real file location intact.
    // Unlike build.ts's compiled-binary case, none of these three need a copy/patch step here:
    // worker.js still runs from inside a real project tree, so external resolution just finds
    // the real node_modules/{vite,@surrealdb/node,geoip-lite} (vite is dev only, never
    // actually reached).
    external: ["vite", "@surrealdb/node", "geoip-lite"],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  });

  if (!result.success) {
    console.error("\n✗ Build failed");
    for (const message of result.logs) console.error(message);
    process.exit(1);
  }

  console.log("\n✓ Bundled worker -> out/worker.js");
  console.log('\nRun it as a Worker thread:\n  new Worker("./out/worker.js")');
} finally {
  await rm(entryPath, { force: true });
}
