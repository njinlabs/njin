import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { installLatestAdmin } from "./admin_install";
import { adminPackageVersion } from "./admin_version";
import { packageFiles, pluginName } from "./plugin_scaffold";

// `njin create --plugin <dir>`: a package to publish a plugin from, with a small project (dev/)
// to try it in.
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
};

const target = process.argv.slice(3).find((arg) => !arg.startsWith("-"));

if (!target) {
  console.error("✖ Usage: njin create --plugin <dir>");
  process.exit(1);
}

const targetDir = resolve(process.cwd(), target);
const packageName = basename(targetDir);

let name: string;
try {
  name = pluginName(packageName);
} catch (error) {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
  console.error(`✖ Directory "${target}" already exists and is not empty.`);
  process.exit(1);
}

// This CLI's own package.json: the njin the plugin is written against.
const pkg = await Bun.file(join(import.meta.dir, "../../package.json")).json();

const admin = await adminPackageVersion();
if (!admin.found) {
  console.warn(
    `• Could not look up @njinlabs/njin-admin on npm (${admin.reason}); package.json asks for the "beta" tag.`,
  );
}

const files = packageFiles(packageName, name, {
  njin: `^${pkg.version}`,
  admin: admin.found ? `^${admin.version}` : admin.version,
});

for (const [file, content] of Object.entries(files)) {
  const path = join(targetDir, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

console.log(`✓ Wrote ${Object.keys(files).length} files -> ${target}\n`);

// dev/ runs njin with the admin panel, which is downloaded once, as `njin create` does.
console.log("Downloading admin panel...\n");
await installLatestAdmin(join(targetDir, "dev"), pkg.version.includes("-"));

console.log("\nInstalling dependencies...\n");

const install = Bun.spawn(["bun", "install"], {
  cwd: targetDir,
  stdout: "inherit",
  stderr: "inherit",
});

const installExitCode = await install.exited;

if (installExitCode !== 0) {
  console.error(`\n✖ "bun install" failed (exit code ${installExitCode}).`);
  console.error(
    `  The plugin was scaffolded at ${targetDir}, but dependencies are not installed.`,
  );
  console.error(`  Run "cd ${target} && bun install" manually to retry.\n`);
  process.exit(installExitCode);
}

console.log(`
  ${c.bold}${c.cyan}njin create --plugin${c.reset} ${c.dim}done${c.reset}

  ${c.green}➜${c.reset}  cd ${target}
  ${c.green}➜${c.reset}  bun run dev
`);
