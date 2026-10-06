#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
};

const root = process.cwd();
const pkgPath = join(root, "package.json");

if (!existsSync(pkgPath)) {
  console.error(
    `✖ No package.json found in ${root} — run this from an njin project root.`,
  );
  process.exit(1);
}

const pkg = await Bun.file(pkgPath).json();
const depKey = pkg.dependencies?.["@njinlabs/njin"]
  ? "dependencies"
  : pkg.devDependencies?.["@njinlabs/njin"]
    ? "devDependencies"
    : undefined;

if (!depKey) {
  console.error(
    `✖ "@njinlabs/njin" is not listed in this project's package.json — run this from an njin project root.`,
  );
  process.exit(1);
}

const currentPinned = String(pkg[depKey]["@njinlabs/njin"]).replace(
  /^[\^~]/,
  "",
);

// `--beta` is shorthand for `--tag beta`. Without either, only the stable channel (`latest`)
// is followed — a prerelease is published under its own dist-tag and never becomes `latest`.
const args = process.argv.slice(3);
const tagIndex = args.indexOf("--tag");
const requestedTag = args.includes("--beta")
  ? "beta"
  : tagIndex !== -1
    ? args[tagIndex + 1]
    : undefined;

if (tagIndex !== -1 && (!requestedTag || requestedTag.startsWith("-"))) {
  console.error(`✖ --tag needs a dist-tag name, e.g. "--tag beta".`);
  process.exit(1);
}

const distTag = requestedTag ?? "latest";

console.log(
  `Checking ${distTag === "latest" ? "latest" : `"${distTag}"`} njin version...\n`,
);

const registryRes = await fetch(
  `https://registry.npmjs.org/@njinlabs/njin/${encodeURIComponent(distTag)}`,
);
if (!registryRes.ok) {
  console.error(
    registryRes.status === 404
      ? `✖ There is no "${distTag}" release of njin on npm.`
      : `✖ Could not reach the npm registry (HTTP ${registryRes.status}).`,
  );
  process.exit(1);
}

const { version: latest } = (await registryRes.json()) as { version: string };
const adminDir = join(root, "_admin");

// A project already on a prerelease would otherwise be moved *back* to the older stable
// version by a plain `njin update` — only an explicit --beta/--tag may change channel.
const isBehindCurrent = (() => {
  try {
    return Bun.semver.order(latest, currentPinned) === -1;
  } catch {
    return false;
  }
})();

if (!requestedTag && isBehindCurrent) {
  console.log(
    `${c.green}✓${c.reset} This project is on ${currentPinned}, ahead of the latest stable (${latest}) — nothing to update. Use "--beta" to follow the beta channel.`,
  );
  process.exit(0);
}

if (currentPinned === latest && existsSync(adminDir)) {
  console.log(
    `${c.green}✓${c.reset} Already on the latest version (${latest}) — nothing to update.`,
  );
  process.exit(0);
}

console.log(`Updating njin ${currentPinned} -> ${latest}...\n`);

// A prerelease is pinned exactly: "^0.11.0-beta.1" would also accept later stable 0.x releases
// on the next install, silently leaving the beta channel the user chose.
pkg[depKey]["@njinlabs/njin"] = distTag === "latest" ? `^${latest}` : latest;
await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log("Installing dependencies...\n");

const install = Bun.spawn(["bun", "install"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
const installExitCode = await install.exited;

if (installExitCode !== 0) {
  console.error(`\n✖ "bun install" failed (exit code ${installExitCode}).`);
  console.error(
    `  package.json now points at njin ${latest}; run "bun install" manually to retry.`,
  );
  process.exit(installExitCode);
}

console.log("\nSyncing admin panel...\n");

// _admin/ is a prebuilt SPA baked into the tagged release tarball, not something published to
// npm (package.json's "files" excludes template/) — so bumping the dependency above never
// touches it. It's rebuilt with content-hashed asset filenames on every release, so the old
// directory is removed first rather than merged, to avoid accumulating stale hashed files.
const tag = `v${latest}`;
const tarballUrl = `https://codeload.github.com/njinlabs/njin/tar.gz/refs/tags/${tag}`;

const res = await fetch(tarballUrl);
if (!res.ok || !res.body) {
  console.error(
    `✖ Could not download the admin panel for njin ${tag} (HTTP ${res.status}).\n` +
      `  The dependency was updated to ${latest}, but _admin/ was not refreshed. Re-run "bunx njin update" to retry.`,
  );
  process.exit(1);
}

await rm(adminDir, { recursive: true, force: true });
await mkdir(adminDir, { recursive: true });

// --strip-components=3 drops the `njin-<version>/template/_admin/` prefix baked into GitHub's
// tag-tarball layout, so _admin/'s own contents land directly in adminDir.
const tar = Bun.spawn(
  [
    "tar",
    "-xz",
    "-f",
    "-",
    "--strip-components=3",
    "-C",
    adminDir,
    `njin-${latest}/template/_admin`,
  ],
  {
    stdin: res.body,
    stdout: "inherit",
    stderr: "inherit",
  },
);

const tarExitCode = await tar.exited;

if (tarExitCode !== 0) {
  console.error(
    `✖ Failed to extract the admin panel (tar exited with code ${tarExitCode}).\n` +
      `  The dependency was updated to ${latest}, but _admin/ was not refreshed.`,
  );
  process.exit(tarExitCode);
}

console.log(`
  ${c.bold}${c.cyan}njin update${c.reset} ${c.dim}done${c.reset}

  ${c.green}➜${c.reset}  njin ${currentPinned} -> ${latest}
  ${c.green}➜${c.reset}  _admin/ refreshed
`);
