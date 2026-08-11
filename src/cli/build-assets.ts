import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Shared staging steps between `njin build` (compiled binary) and `njin build:worker`
// (bundled JS entry) — both produce the same `out/public`, `out/src/views`, `out/_admin`
// layout; only the server artifact itself differs.
export const stageBuildAssets = async (root: string, outDir: string): Promise<void> => {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Vite build — outDir is forced here regardless of what the project's own
  // vite.config.ts says, so the build always lands in a predictable place.
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
};
