import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m" };

const targetArg = process.argv[3] ?? ".";
const targetDir = resolve(process.cwd(), targetArg);
const projectName = targetArg === "." ? "njin-app" : targetArg.split(/[\\/]/).filter(Boolean).pop()!;

if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
  console.error(`✖ Directory "${targetArg}" already exists and is not empty.`);
  process.exit(1);
}

// This CLI's own package.json — read at runtime (not a static JSON import) so it
// resolves correctly whether njin is a project-local dependency or fetched fresh
// by `bunx`. Doubles as the source of truth for which tagged template to fetch,
// and for the version pin written into the scaffolded project below.
const pkg = await Bun.file(join(import.meta.dir, "../../package.json")).json();
const tag = `v${pkg.version}`;
const tarballUrl = `https://codeload.github.com/njinlabs/njin/tar.gz/refs/tags/${tag}`;

console.log(`\nFetching template for njin ${tag}...\n`);

const res = await fetch(tarballUrl);
if (!res.ok || !res.body) {
  console.error(
    `✖ Could not download the project template for njin ${tag} (HTTP ${res.status}).\n` +
      `  Check your internet connection, or that tag "${tag}" exists at github.com/njinlabs/njin.`,
  );
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });

// `--strip-components=2` drops the `njin-<version>/template/` prefix baked into
// GitHub's tag-tarball layout, so template/ contents land directly in targetDir.
const tar = Bun.spawn(["tar", "-xz", "--strip-components=2", "-C", targetDir, `njin-${pkg.version}/template`], {
  stdin: res.body,
  stdout: "inherit",
  stderr: "inherit",
});

const tarExitCode = await tar.exited;

if (tarExitCode !== 0) {
  console.error(
    `✖ Failed to extract the template (tar exited with code ${tarExitCode}).\n` +
      `  Make sure "tar" is installed and available on your PATH.`,
  );
  process.exit(tarExitCode);
}

const pkgPath = join(targetDir, "package.json");
const scaffoldedPkg = await Bun.file(pkgPath).json();
scaffoldedPkg.name = projectName;
scaffoldedPkg.dependencies = { "@njinlabs/njin": `^${pkg.version}`, ...scaffoldedPkg.dependencies };
await Bun.write(pkgPath, JSON.stringify(scaffoldedPkg, null, 2) + "\n");

console.log("Installing dependencies...\n");

const install = Bun.spawn(["bun", "install"], {
  cwd: targetDir,
  stdout: "inherit",
  stderr: "inherit",
});

const installExitCode = await install.exited;

if (installExitCode !== 0) {
  console.error(`\n✖ "bun install" failed (exit code ${installExitCode}).`);
  console.error(`  The project was scaffolded at ${targetDir}, but dependencies are not installed.`);
  console.error(`  Run "cd ${targetArg} && bun install" manually to retry.\n`);
  process.exit(installExitCode);
}

console.log(`
  ${c.bold}${c.cyan}njin create${c.reset} ${c.dim}done${c.reset}

  ${c.green}➜${c.reset}  cd ${targetArg === "." ? "." : targetArg}
  ${c.green}➜${c.reset}  bunx njin dev
`);
