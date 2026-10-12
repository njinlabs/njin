// Spawned by stageBuildAssets (see build-assets.ts) as `bun build-static.ts` with NODE_ENV=production
// and NJIN_STATIC_OUT set — a separate process because view.ts reads NODE_ENV once at load time.
// No module is booted (no database), and imports are dynamic for the same reason as
// dev.ts/start.ts: loadConfig() has to run first.
import { relative } from "node:path";

const outDir = process.env.NJIN_STATIC_OUT;
if (!outDir) {
  console.error("✗ NJIN_STATIC_OUT is not set");
  process.exit(1);
}

const { loadConfig, getConfig } = await import("../core/config");
await loadConfig();

if (getConfig().static.length === 0) process.exit(0);

try {
  const { renderStaticSite } = await import("../modules/view");

  for (const file of await renderStaticSite(outDir)) {
    console.log(`✓ Rendered static page -> ${relative(process.cwd(), file)}`);
  }
  process.exit(0);
} catch (err) {
  console.error(
    `\n✗ ${err instanceof Error ? err.message : String(err)}`,
    ...(err instanceof Error && err.cause ? [err.cause] : []),
  );
  process.exit(1);
}
