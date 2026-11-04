import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inlineFiles, inlineHints, pluginName } from "./plugin_scaffold";

// `njin plugin:create <name>`: a plugin that lives in this project, in src/plugins/<name>.
// It only writes that folder; registering the plugin in config.ts is left to the person, and
// said how.
const input = process.argv[3];

if (!input || input.startsWith("-")) {
  console.error("✖ Usage: njin plugin:create <name>");
  process.exit(1);
}

let name: string;
try {
  name = pluginName(input);
} catch (error) {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const root = process.cwd();
const pkgPath = join(root, "package.json");

if (!existsSync(pkgPath)) {
  console.error(
    `✖ No package.json found in ${root} — run this from an njin project root.`,
  );
  process.exit(1);
}

const dir = `src/plugins/${name}`;

if (existsSync(join(root, dir))) {
  console.error(`✖ ${dir} already exists.`);
  process.exit(1);
}

for (const [file, content] of Object.entries(inlineFiles(name))) {
  const path = join(root, dir, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const pkg = await Bun.file(pkgPath).json();
const adminInstalled = Boolean(
  pkg.dependencies?.["@njinlabs/njin-admin"] ??
    pkg.devDependencies?.["@njinlabs/njin-admin"],
);

console.log(`✓ Created ${dir}\n\n${inlineHints(name, dir, adminInstalled)}\n`);
