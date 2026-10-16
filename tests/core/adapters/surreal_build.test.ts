import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BunPlugin } from "bun";
import { surrealAdapter } from "../../../src/core/adapters/surreal";
import type { AdapterBuildContext } from "../../../src/core/db/contract";

// What `njin build` / `njin build:worker` learn from the SurrealDB adapter — the build commands
// themselves know nothing about it.
let outDir: string;
const logs: string[] = [];

const ctx = (target: AdapterBuildContext["target"]): AdapterBuildContext => ({
  target,
  outDir,
  log: (message) => logs.push(message),
});

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "njin-surreal-build-"));
  logs.length = 0;
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

const embedded = () => surrealAdapter({ path: "rocksdb://data" });
const remote = () => surrealAdapter({ path: "wss://db.example.com" });

describe("surrealAdapter().build()", () => {
  it("keeps the native package out of a worker bundle and ships nothing", async () => {
    const result = await embedded().build!(ctx("worker"));

    expect(result).toEqual({ external: ["@surrealdb/node"] });
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("leaves the native package out of a remote build, with a note, and copies nothing", async () => {
    const result = await remote().build!(ctx("compile"));

    expect(result?.external).toEqual(["@surrealdb/node"]);
    expect(result?.plugins).toBeUndefined();
    expect(result?.notes?.join(" ")).toContain("remote");
    expect(logs.join("\n")).toContain("Remote db.path");
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("ships the host platform's native binding next to an embedded build and patches its loader", async () => {
    const result = await embedded().build!(ctx("compile"));

    // Bundled (not external), so the plugin has to redirect the .node lookup.
    expect(result?.external).toBeUndefined();
    expect(result?.plugins).toHaveLength(1);
    expect(result?.notes?.join(" ")).toContain("out/bindings/");

    const shipped = readdirSync(join(outDir, "bindings"));
    expect(shipped).toHaveLength(1);
    expect(shipped[0]).toMatch(/^surrealdb-node\..+\.node$/);
    expect(logs.join("\n")).toContain("Copied native binding");
  });

  it("the loader patch redirects only the host platform's binding", async () => {
    const result = await embedded().build!(ctx("compile"));
    const plugin = result!.plugins![0] as BunPlugin;

    let onLoad:
      | ((args: { path: string }) => Promise<{ contents: string }>)
      | undefined;
    plugin.setup({
      onLoad: (_filter: unknown, cb: any) => (onLoad = cb),
    } as any);

    const loader = join(outDir, "surrealdb-node.mjs");
    writeFileSync(
      loader,
      "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nrequire('./x.node');\n",
    );

    const { contents } = await onLoad!({ path: loader });
    const nativeFile = readdirSync(join(outDir, "bindings"))[0]!;

    expect(contents).toContain("__realRequire");
    expect(contents).toContain(nativeFile);
    expect(contents).toContain("process.execPath");
  });

  it("fails loudly when the loader's shape changed, instead of shipping a broken binary", async () => {
    const result = await embedded().build!(ctx("compile"));
    const plugin = result!.plugins![0] as BunPlugin;

    let onLoad: ((args: { path: string }) => Promise<unknown>) | undefined;
    plugin.setup({
      onLoad: (_filter: unknown, cb: any) => (onLoad = cb),
    } as any);

    const loader = join(outDir, "surrealdb-node.mjs");
    writeFileSync(loader, "export default {};\n");

    await expect(onLoad!({ path: loader })).rejects.toThrow(
      /loader shape changed/,
    );
  });

  it("refuses a platform it has no binding for", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "freebsd" });
    try {
      await expect(embedded().build!(ctx("compile"))).rejects.toThrow(
        /Unsupported platform/,
      );
    } finally {
      Object.defineProperty(process, "platform", original);
    }
    expect(existsSync(join(outDir, "bindings"))).toBe(false);
  });
});
