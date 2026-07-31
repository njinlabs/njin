import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Separate file so --isolate gives it a fresh module registry — view.ts's `isDev`
// constant AND its `publicDir` constant are both read once at module load time (from
// NODE_ENV and process.cwd() respectively), so both must be set/switched *before* this
// dynamic import, and can't vary across tests within a single already-imported module.
process.env.NODE_ENV = "production";

const dir = mkdtempSync(join(tmpdir(), "njin-view-prod-"));
mkdirSync(join(dir, "public"));
const cwd = process.cwd();
process.chdir(dir);
const { buildViteGlobal } = await import("../../src/modules/view");
process.chdir(cwd);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildViteGlobal — production mode", () => {
  it("returns a placeholder comment when no public/manifest.json exists yet", async () => {
    const vite = await buildViteGlobal();
    expect(vite.asset("src/main.ts")).toContain("manifest not found");
    expect(vite.static("/logo.png")).toBe("/logo.png");
  });

  it("resolves asset tags once public/manifest.json exists", async () => {
    writeFileSync(
      join(dir, "public", "manifest.json"),
      JSON.stringify({
        "src/main.ts": { file: "assets/main-abc123.js", css: ["assets/main-abc123.css"], isEntry: true },
        "src/main.css": { file: "assets/main-def456.css" },
      }),
    );

    const vite = await buildViteGlobal();

    const script = vite.asset("src/main.ts");
    expect(script).toContain('<link rel="stylesheet" href="/assets/main-abc123.css">');
    expect(script).toContain('<script type="module" src="/assets/main-abc123.js"></script>');

    expect(vite.asset("src/main.css")).toBe('<link rel="stylesheet" href="/assets/main-def456.css">');
    expect(vite.asset("src/unknown.ts")).toContain("not found in manifest");
    expect(vite.static("/logo.png")).toBe("/logo.png");
  });
});
