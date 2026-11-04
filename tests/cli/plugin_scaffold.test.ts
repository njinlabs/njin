import { describe, expect, it } from "bun:test";
import {
  adminPackageVersion,
  highestVersion,
} from "../../src/cli/admin_version";
import {
  adminFiles,
  camelCase,
  inlineFiles,
  inlineHints,
  packageFiles,
  pluginName,
} from "../../src/cli/plugin_scaffold";

describe("pluginName", () => {
  it("takes the last part of a package name", () => {
    expect(pluginName("reports")).toBe("reports");
    expect(pluginName("@acme/njin-reports")).toBe("njin-reports");
  });

  it("refuses what cannot prefix a renderer or name a route", () => {
    for (const bad of ["", "Reports", "my_plugin", "1st", "-x", "a b"]) {
      expect(() => pluginName(bad)).toThrow("is not a usable plugin name");
    }
  });
});

describe("camelCase", () => {
  it("makes an identifier out of a dashed name", () => {
    expect(camelCase("hello-world-2")).toBe("helloWorld2");
  });
});

describe("the files of a plugin in the project", () => {
  const files = inlineFiles("hello-world");

  it("is an index and an admin side that names itself", () => {
    expect(Object.keys(files).sort()).toEqual([
      "admin/index.css",
      "admin/index.tsx",
      "index.ts",
    ]);
    expect(files["admin/index.tsx"]).toContain('name: "hello-world"');
    expect(files["admin/index.tsx"]).toContain('to: "/hello-world"');
    expect(files["admin/index.tsx"]).toContain("Hello World");
  });

  it("points the server side at the admin side's source", () => {
    expect(files["index.ts"]).toContain(
      'import.meta.resolve("./admin/index.tsx")',
    );
  });

  it("keeps the plugin's stylesheet from scanning the project it runs in", () => {
    expect(adminFiles("x")["admin/index.css"]).toContain('@source "./";');
  });
});

describe("inlineHints", () => {
  it("says how to register the plugin, and changes nothing", () => {
    const text = inlineHints("hello-world", "src/plugins/hello-world", true);

    expect(text).toContain(
      'import helloWorld from "./src/plugins/hello-world";',
    );
    expect(text).toContain("plugins: [helloWorld()],");
    expect(text).not.toContain("bun add");
  });

  it("asks for the admin package only when it is missing", () => {
    expect(inlineHints("x", "src/plugins/x", false)).toContain(
      "bun add @njinlabs/njin-admin",
    );
  });
});

describe("the files of a plugin package", () => {
  const files = packageFiles("@acme/hello", "hello", {
    njin: "^0.17.0",
    admin: "^0.1.0-beta.2",
  });
  const pkg = JSON.parse(files["package.json"] as string);

  it("publishes the source and the built admin side, and builds before publishing", () => {
    expect(pkg.name).toBe("@acme/hello");
    expect(pkg.files).toEqual(["src", "admin/dist"]);
    expect(pkg.scripts.prepublishOnly).toBe("bun run build");
  });

  it("asks njin and the admin package as peers, and has them to develop against", () => {
    expect(pkg.peerDependencies).toEqual({
      "@njinlabs/njin": "^0.17.0",
      "@njinlabs/njin-admin": "^0.1.0-beta.2",
    });
    expect(pkg.devDependencies["@njinlabs/njin"]).toBe("^0.17.0");
    expect(pkg.devDependencies["@njinlabs/njin-admin"]).toBe("^0.1.0-beta.2");
  });

  it("points the plugin at the build, and dev/ at the source", () => {
    expect(files["src/index.ts"]).toContain("../admin/dist/index.js");
    expect(files["dev/config.ts"]).toContain(
      'import.meta.resolve("../admin/index.tsx")',
    );
    expect(files["admin/vite.config.ts"]).toContain('outDir: "admin/dist"');
  });

  it("keeps the build out of git, where npm would otherwise leave it out too", () => {
    expect(files[".gitignore"]).toContain("admin/dist");
  });

  it("writes the guide to styling the admin side", () => {
    expect(files["README.md"]).toContain('@source "./";');
    expect(files["README.md"]).toContain("hello-card");
  });
});

describe("the admin package's version", () => {
  it("is the highest any dist-tag points to, not what latest says", () => {
    expect(highestVersion(["0.1.0-beta.1", "0.1.0-beta.2"])).toBe(
      "0.1.0-beta.2",
    );
    expect(highestVersion(["0.1.0-beta.2", "0.1.0"])).toBe("0.1.0");
    expect(highestVersion([])).toBeUndefined();
  });

  it("is read from the registry", async () => {
    const fetchFn = (async () =>
      Response.json({
        "dist-tags": { latest: "0.1.0-beta.1", beta: "0.1.0-beta.2" },
      })) as unknown as typeof fetch;

    expect(await adminPackageVersion(fetchFn)).toEqual({
      found: true,
      version: "0.1.0-beta.2",
    });
  });

  it("falls back to the beta tag, and says why, when the registry cannot be read", async () => {
    const down = (async () =>
      new Response("", { status: 503 })) as unknown as typeof fetch;

    expect(await adminPackageVersion(down)).toEqual({
      found: false,
      version: "beta",
      reason: "HTTP 503",
    });
  });
});
