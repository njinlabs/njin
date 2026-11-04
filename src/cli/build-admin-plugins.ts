import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isBuiltPlugin,
  type ManifestPlugin,
  PLUGINS_LIST,
  pluginName,
  toPath,
} from "../core/http/admin_dev";

// What building a plugin takes from the admin and from Vite. Passed in so a test can stand in for
// them; `loadAdminTooling` finds the real ones in the project.
export type AdminTooling = {
  // `adminPluginConfig` of @njinlabs/njin-admin/vite.
  pluginConfig: (options: { entry: string; outDir: string }) => object;
  // Vite's build().
  build: (config: object) => Promise<unknown>;
};

export const loadAdminTooling = async (root: string): Promise<AdminTooling> => {
  let adminVite: string;
  try {
    adminVite = Bun.resolveSync("@njinlabs/njin-admin/vite", root);
  } catch {
    throw new Error(
      "Plugins list an admin side, but @njinlabs/njin-admin is not installed: it is needed to build them.",
    );
  }

  const { adminPluginConfig } = await import(pathToFileURL(adminVite).href);
  const { build } = await import("vite");

  return { pluginConfig: adminPluginConfig, build };
};

// Puts the plugins' admin sides in `<outDir>/_admin/plugins/<name>/` and lists them for the
// manifest. A plugin in source is built against the admin's contract; one that ships built (an
// npm package with `admin/dist`) is copied as it is. Returns what it listed.
export const buildAdminPlugins = async (
  entries: string[],
  outDir: string,
  tooling: () => Promise<AdminTooling> = () => loadAdminTooling(process.cwd()),
): Promise<ManifestPlugin[]> => {
  if (entries.length === 0) return [];

  const used = new Set<string>();
  const listed: ManifestPlugin[] = [];
  let built: AdminTooling | undefined;

  for (const entry of entries) {
    // Two plugins can sit in folders of the same name; each gets a folder of its own.
    const base = pluginName(entry);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);

    const path = toPath(entry);
    const target = join(outDir, "_admin", "plugins", name);

    if (isBuiltPlugin(entry)) {
      await cp(dirname(path), target, { recursive: true });
    } else {
      built ??= await tooling();
      await built.build({
        ...built.pluginConfig({ entry: path, outDir: target }),
        configFile: false,
        logLevel: "warn",
      });
    }

    const contractFile = join(target, "contract.json");
    if (!existsSync(join(target, "index.js")) || !existsSync(contractFile)) {
      throw new Error(
        `The admin side of plugin "${name}" (${path}) did not produce index.js and contract.json.`,
      );
    }

    const { version } = JSON.parse(await readFile(contractFile, "utf8")) as {
      version: number;
    };
    const url = `/_admin/plugins/${name}`;

    listed.push({
      name,
      entry: `${url}/index.js`,
      ...(existsSync(join(target, "index.css"))
        ? { styles: [`${url}/index.css`] }
        : {}),
      contract: version,
    });
    console.log(`✓ Built admin plugin ${name} -> out/_admin/plugins/${name}`);
  }

  const list = join(outDir, PLUGINS_LIST);
  await mkdir(dirname(list), { recursive: true });
  await writeFile(list, `${JSON.stringify(listed, null, 2)}\n`);

  return listed;
};
