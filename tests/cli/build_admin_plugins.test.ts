import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdminTooling,
  buildAdminPlugins,
} from "../../src/cli/build-admin-plugins";
import {
  adminManifest,
  PLUGINS_LIST,
  setAdminDevUrl,
} from "../../src/core/http/admin_dev";

// Stands in for the admin's build: writes what adminPluginConfig's build writes.
const fakeTooling: AdminTooling & { built: string[] } = {
  built: [],
  pluginConfig: ({ entry, outDir }) => ({ entry, outDir }),
  build: async (config) => {
    const { entry, outDir } = config as { entry: string; outDir: string };
    fakeTooling.built.push(entry);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "index.js"), "export default {}");
    writeFileSync(join(outDir, "contract.json"), '{"version":1}');
    if (entry.includes("styled")) writeFileSync(join(outDir, "index.css"), "");
  },
};

describe("buildAdminPlugins", () => {
  let root: string;
  let out: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "njin-admin-plugins-"));
    out = join(root, "out");

    // A plugin in source, one with a stylesheet, and a package that ships built.
    for (const dir of ["plain/admin", "styled/admin", "other/admin"]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "index.tsx"), "export default {}");
    }
    mkdirSync(join(root, "npm/admin/dist"), { recursive: true });
    writeFileSync(join(root, "npm/admin/dist/index.js"), "export default {}");
    writeFileSync(join(root, "npm/admin/dist/index.css"), "");
    writeFileSync(join(root, "npm/admin/dist/contract.json"), '{"version":1}');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("builds nothing, and asks for no tooling, when no plugin has an admin side", async () => {
    let asked = false;
    const listed = await buildAdminPlugins([], out, async () => {
      asked = true;
      return fakeTooling;
    });

    expect(listed).toEqual([]);
    expect(asked).toBe(false);
    expect(existsSync(join(out, PLUGINS_LIST))).toBe(false);
  });

  it("builds a source plugin, copies a built one, and lists both for the manifest", async () => {
    fakeTooling.built = [];
    const listed = await buildAdminPlugins(
      [
        join(root, "plain/admin/index.tsx"),
        join(root, "styled/admin/index.tsx"),
        join(root, "npm/admin/dist/index.js"),
      ],
      out,
      async () => fakeTooling,
    );

    // The built package is not built again.
    expect(fakeTooling.built.map((p) => p.replace(/\\/g, "/"))).toEqual([
      join(root, "plain/admin/index.tsx").replace(/\\/g, "/"),
      join(root, "styled/admin/index.tsx").replace(/\\/g, "/"),
    ]);
    expect(listed).toEqual([
      { name: "plain", entry: "/_admin/plugins/plain/index.js", contract: 1 },
      {
        name: "styled",
        entry: "/_admin/plugins/styled/index.js",
        styles: ["/_admin/plugins/styled/index.css"],
        contract: 1,
      },
      {
        name: "npm",
        entry: "/_admin/plugins/npm/index.js",
        styles: ["/_admin/plugins/npm/index.css"],
        contract: 1,
      },
    ]);
    expect(existsSync(join(out, "_admin/plugins/npm/index.js"))).toBe(true);
  });

  it("is what the production manifest answers with", () => {
    setAdminDevUrl(undefined);

    expect(adminManifest([], out).plugins.map((p) => p.name)).toEqual([
      "plain",
      "styled",
      "npm",
    ]);
    // Without a build, or without a root to look in, there is nothing to list.
    expect(adminManifest([], join(root, "nowhere"))).toEqual({ plugins: [] });
    expect(adminManifest([])).toEqual({ plugins: [] });
  });

  it("gives plugins that sit in folders of the same name a folder each", async () => {
    mkdirSync(join(root, "a/same/admin"), { recursive: true });
    mkdirSync(join(root, "b/same/admin"), { recursive: true });

    const listed = await buildAdminPlugins(
      [
        join(root, "a/same/admin/index.tsx"),
        join(root, "b/same/admin/index.tsx"),
      ],
      join(root, "out2"),
      async () => fakeTooling,
    );

    expect(listed.map((p) => p.name)).toEqual(["same", "same-2"]);
  });

  it("fails when a build leaves no script behind", async () => {
    await expect(
      buildAdminPlugins(
        [join(root, "other/admin/index.tsx")],
        join(root, "out3"),
        async () => ({
          ...fakeTooling,
          build: async () => {},
        }),
      ),
    ).rejects.toThrow(/did not produce index.js and contract.json/);
  });
});

describe("adminManifest in development", () => {
  it("serves a plugin that ships built as it is, with its stylesheet and contract", () => {
    const dir = mkdtempSync(join(tmpdir(), "njin-built-"));
    mkdirSync(join(dir, "admin/dist"), { recursive: true });
    writeFileSync(join(dir, "admin/dist/index.js"), "");
    writeFileSync(join(dir, "admin/dist/index.css"), "");
    writeFileSync(join(dir, "admin/dist/contract.json"), '{"version":3}');
    const path = join(dir, "admin/dist/index.js").replace(/\\/g, "/");

    setAdminDevUrl("http://localhost:5173");
    const [plugin] = adminManifest([path]).plugins;
    setAdminDevUrl(undefined);
    rmSync(dir, { recursive: true, force: true });

    expect(plugin).toEqual({
      name: dir.replace(/\\/g, "/").split("/").pop() as string,
      entry: `http://localhost:5173/@fs/${path}`,
      styles: [
        `http://localhost:5173/@fs/${path.replace("index.js", "index.css")}`,
      ],
      contract: 3,
    });
  });
});
