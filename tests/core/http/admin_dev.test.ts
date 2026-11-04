import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, searchForWorkspaceRoot, type ViteDevServer } from "vite";
import {
  adminManifest,
  adminPluginDev,
  hasPlugin,
  setAdminDevUrl,
} from "../../../src/core/http/admin_dev";

describe("adminManifest", () => {
  it("lists nothing while there is no dev server to serve the plugins", () => {
    setAdminDevUrl(undefined);

    expect(adminManifest(["/p/admin/index.tsx"])).toEqual({ plugins: [] });
  });

  it("points each plugin at the dev server, from a path or a file: URL", () => {
    setAdminDevUrl("http://localhost:5173/");

    expect(
      adminManifest([
        "D:\\p\\admin\\index.tsx",
        pathToFileURL(join(process.cwd(), "a", "index.tsx")).href,
      ]),
    ).toEqual({
      plugins: [
        { name: "p", entry: "http://localhost:5173/@fs/D:/p/admin/index.tsx" },
        {
          name: "a",
          entry: `http://localhost:5173/@fs/${process.cwd().replace(/\\/g, "/")}/a/index.tsx`,
        },
      ],
    });
    setAdminDevUrl(undefined);
  });
});

// A real Vite server over a small project under the repo (so `zod` resolves from its
// node_modules): one plugin made of two files, and a file of the site's own that imports a module the admin also shares.
describe("adminPluginDev", () => {
  const root = mkdtempSync(join(process.cwd(), "tests", ".tmp-admin-dev-"));
  const at = (name: string) => join(root, name).replace(/\\/g, "/");
  let server: ViteDevServer;

  beforeAll(async () => {
    mkdirSync(join(root, "admin"));
    writeFileSync(
      join(root, "admin", "index.tsx"),
      `import { useState } from "react";
import { icon } from "fake-icons";
import { other } from "./other";
export default () => <p>{useState(other)[0]}{icon}</p>;
`,
    );
    writeFileSync(
      join(root, "admin", "other.ts"),
      `import { createElement } from "react";
export const other = typeof createElement;
`,
    );
    // A package built on React, as an icon set is.
    mkdirSync(join(root, "node_modules", "fake-icons"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "fake-icons", "package.json"),
      JSON.stringify({
        name: "fake-icons",
        version: "1.0.0",
        type: "module",
        module: "index.mjs",
        exports: "./index.mjs",
        peerDependencies: { react: "*" },
      }),
    );
    writeFileSync(
      join(root, "node_modules", "fake-icons", "index.mjs"),
      `import { createElement } from "react";
export const icon = createElement("svg");
`,
    );
    writeFileSync(
      join(root, "site.ts"),
      `import z from "zod";
export default z;
`,
    );

    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { middlewareMode: true },
      appType: "custom",
      // The dependency scan needs an html page to start from; what is tested here is that Vite is
      // told not to bundle the package, which holds whether it would have found it or not.
      optimizeDeps: { noDiscovery: true },
      plugins: [
        adminPluginDev({
          entries: [pathToFileURL(join(root, "admin", "index.tsx")).href],
          shared: ["react", "react/jsx-runtime", "zod"],
          exportsOf: async (name) =>
            name === "react" ? ["useState", "createElement"] : [],
          searchForWorkspaceRoot,
        }),
      ],
    });
  }, 30_000);

  afterAll(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const compiled = async (name: string) =>
    (await server.transformRequest(at(name)))?.code ?? "";

  it("reads the admin's copy of a shared module in the plugin's entry", async () => {
    const code = await compiled("admin/index.tsx");

    expect(code).toContain("njin-shared:react");
    expect(code).not.toMatch(/from "\/node_modules\/[^"]*react/);
  });

  it("does the same in a file the entry imports", async () => {
    expect(await compiled("admin/other.ts")).toContain("njin-shared:react");
  });

  it("keeps a package built on React from taking its own copy of React", async () => {
    const plugin = await compiled("admin/index.tsx");
    const icons = await compiled("node_modules/fake-icons/index.mjs");

    expect(plugin).not.toContain(".vite/deps");
    expect(icons).toContain("njin-shared:react");
    expect(server.config.optimizeDeps.exclude).toContain("fake-icons");
  });

  it("compiles JSX against the admin's runtime, not a second one", async () => {
    const code = await compiled("admin/index.tsx");

    expect(code).toContain("njin-shared:react/jsx-dev-runtime");
  });

  it("leaves the site's own files alone", async () => {
    expect(await compiled("site.ts")).not.toContain("njin-shared");
  });

  it("makes the shared module out of what the admin put on globalThis", async () => {
    const loaded = await server.pluginContainer.load("\0njin-shared:react");
    const source = typeof loaded === "string" ? loaded : loaded?.code;

    expect(source).toContain('globalThis.__njin["react"]');
    expect(source).toContain("export const useState = m.useState;");
    expect(source).toContain("export default m.default ?? m;");

    const jsx = await server.pluginContainer.load(
      "\0njin-shared:react/jsx-dev-runtime",
    );
    expect(typeof jsx === "string" ? jsx : jsx?.code).toContain(
      'globalThis.__njin["react/jsx-runtime"]',
    );
  });

  it("lets the server read the plugin's folder", () => {
    expect(server.config.server.fs.allow).toContain(at("admin"));
  });
});

describe("hasPlugin", () => {
  it("finds a Vite plugin by name in a nested, partly async list", async () => {
    const list = [
      { name: "a" },
      [Promise.resolve([{ name: "@tailwindcss/vite:scan" }])],
    ];

    expect(await hasPlugin(list, "@tailwindcss/vite")).toBe(true);
  });

  it("is false for a list without it, and for no list at all", async () => {
    expect(
      await hasPlugin([{ name: "a" }, [false, null]], "@tailwindcss/vite"),
    ).toBe(false);
    expect(await hasPlugin(undefined, "@tailwindcss/vite")).toBe(false);
  });
});
