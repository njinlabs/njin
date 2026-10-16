import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";
import type { DbAdapter } from "../core/db/contract";
import { stageBuildAssets } from "./build-assets";

const root = process.cwd();
const outDir = join(root, "out");

console.log("Building for production...\n");

await stageBuildAssets(root, outDir);

// The database adapter says what the build needs from it (native bindings to copy, packages to
// keep out of the bundle, bundler patches) — this command doesn't know which database is in use.
// We resolve the project's own config here (same file loadConfig() reads from process.cwd() at
// runtime) to get at the adapter it configures.
const { loadConfig, getConfig } = await import("../core/config");
await loadConfig();

let dbBuild: Awaited<ReturnType<NonNullable<DbAdapter["build"]>>>;
try {
  dbBuild = await getConfig().adapters.db.build?.({
    target: "compile",
    outDir,
    log: console.log,
  });
} catch (error) {
  console.error(
    `\n✗ ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
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
// which won't exist wherever the binary is actually deployed. Same fix shape as a database
// adapter's native binding: ship the data dir next to the executable and patch the lookup.
// Only the country .dat files are shipped — analytics.ts only ever reads the `country` field,
// and geoip-lite falls back to country-only mode automatically when the (much larger, ~100MB)
// city .dat files are absent, keeping the buffers it preloads into memory at startup small.
const geoipLibDir = dirname(fileURLToPath(import.meta.resolve("geoip-lite")));
const geoipDataDir = join(geoipLibDir, "..", "data");
const outGeoipDataDir = join(outDir, "geoip-data");
await mkdir(outGeoipDataDir, { recursive: true });
await cp(
  join(geoipDataDir, "geoip-country.dat"),
  join(outGeoipDataDir, "geoip-country.dat"),
);
await cp(
  join(geoipDataDir, "geoip-country6.dat"),
  join(outGeoipDataDir, "geoip-country6.dat"),
);
console.log("✓ Copied geoip-lite country data -> out/geoip-data");

const geoipDataPlugin: BunPlugin = {
  name: "geoip-lite-data-dir",
  setup(build) {
    build.onLoad(
      { filter: /geoip-lite[\\/]lib[\\/]geoip\.js$/ },
      async (args) => {
        const original = await Bun.file(args.path).text();
        const marker =
          "global.geodatadir || process.env.GEODATADIR || '../data/'";
        if (!original.includes(marker)) {
          throw new Error(
            "geoip-lite's data dir resolution changed — expected marker not found",
          );
        }
        const patched = original.replace(
          `var geodatadir = path.resolve(\n\t__dirname,\n\t${marker}\n);`,
          "var geodatadir = require('path').join(require('path').dirname(process.execPath), 'geoip-data');",
        );
        if (patched === original) {
          throw new Error(
            "geoip-lite's geodatadir block didn't match expected shape — patch did not apply",
          );
        }
        return { contents: patched, loader: "js" };
      },
    );
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
    // Embedded in the binary; Bun remaps error.stack through it, so logs/Sentry show src/*.ts
    // paths instead of positions inside the bundle.
    sourcemap: "inline",
    // vite is dev-only (view.ts gates it behind `if (isDev)`, dead in production) — bundling
    // it would also drag in its own internal (not-installed) lazy `import("esbuild")`. The
    // database adapter adds whatever else it can't have bundled.
    external: ["vite", ...(dbBuild?.external ?? [])],
    plugins: [...(dbBuild?.plugins ?? []), geoipDataPlugin],
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
    [
      "\nNote: out/geoip-data/ must ship alongside the executable — it holds the geoip-lite " +
        "database loaded at runtime.",
      ...(dbBuild?.notes ?? []),
    ].join("\n"),
  );
  console.log(`\nRun it with:\n  cd out && ./${exeName}`);
} finally {
  await rm(entryPath, { force: true });
}
