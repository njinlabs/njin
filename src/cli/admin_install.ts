import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The admin panel is a separate project (github.com/njinlabs/njin-admin) whose releases carry a
// prebuilt SPA as `njin-admin-v<version>.tar.gz` (index.html and assets/ at the archive root)
// next to a `.sha256` file. `njin create` and `njin update` put the newest release in `_admin/`.
export const ADMIN_REPO = "njinlabs/njin-admin";

// Records which release `_admin/` holds. Without it the folder is not ours (an older
// scaffold's panel, or a hand-made build), and it is replaced.
export const ADMIN_MARKER = ".njin-admin-version";

export const adminAssetUrls = (version: string) => {
  const name = `njin-admin-v${version}.tar.gz`;
  const base = `https://github.com/${ADMIN_REPO}/releases/download/v${version}`;
  return { tarball: `${base}/${name}`, checksum: `${base}/${name}.sha256` };
};

const download = async (
  url: string,
  fetchFn: typeof fetch,
): Promise<ArrayBuffer> => {
  const res = await fetchFn(url);
  if (!res.ok)
    throw new Error(`could not download ${url} (HTTP ${res.status})`);
  return res.arrayBuffer();
};

// Makes `<root>/_admin` hold admin panel `version`. Downloads nothing when it already does.
// Throws when the release cannot be fetched, fails its checksum or cannot be unpacked; the
// existing `_admin/` is only replaced once the new one is fully extracted.
export const ensureAdmin = async (
  root: string,
  version: string,
  fetchFn: typeof fetch = fetch,
): Promise<"current" | "installed"> => {
  const adminDir = join(root, "_admin");
  const markerPath = join(adminDir, ADMIN_MARKER);

  if (existsSync(join(adminDir, "index.html")) && existsSync(markerPath)) {
    if ((await readFile(markerPath, "utf8")).trim() === version)
      return "current";
  }

  const urls = adminAssetUrls(version);
  const [tarball, checksum] = await Promise.all([
    download(urls.tarball, fetchFn),
    download(urls.checksum, fetchFn),
  ]);

  const expected = new TextDecoder().decode(checksum).trim().split(/\s+/)[0];
  const actual = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
  if (expected?.toLowerCase() !== actual) {
    throw new Error(
      `checksum mismatch for admin panel ${version} (expected ${expected}, got ${actual})`,
    );
  }

  const stagingDir = join(root, ".njin-admin-staging");
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    // cwd instead of `-C <abs path>`: a GNU tar on Windows (Git Bash) misreads a "C:\..." path.
    const tar = Bun.spawn(["tar", "-xz", "-f", "-"], {
      cwd: stagingDir,
      stdin: new Response(tarball),
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await tar.exited;
    if (exitCode !== 0) {
      throw new Error(
        `tar exited with code ${exitCode} unpacking the admin panel`,
      );
    }
    if (!existsSync(join(stagingDir, "index.html"))) {
      throw new Error(`the admin panel ${version} archive has no index.html`);
    }

    await writeFile(join(stagingDir, ADMIN_MARKER), `${version}\n`);
    await rm(adminDir, { recursive: true, force: true });
    await rename(stagingDir, adminDir);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  return "installed";
};

type GithubRelease = { tag_name: string; prerelease: boolean; draft: boolean };

// The newest admin panel release. The stable channel takes the newest non-prerelease; the beta
// channel takes the newest of all. While no stable release exists yet, stable falls back to the
// newest prerelease rather than leaving a new project without a panel.
export const latestAdminVersion = async (
  beta: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<string> => {
  const res = await fetchFn(
    `https://api.github.com/repos/${ADMIN_REPO}/releases?per_page=30`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!res.ok) {
    throw new Error(`could not list admin panel releases (HTTP ${res.status})`);
  }

  const releases = ((await res.json()) as GithubRelease[]).filter(
    (r) => !r.draft,
  );
  const pick =
    (beta ? undefined : releases.find((r) => !r.prerelease)) ?? releases[0];
  if (!pick) throw new Error("the admin panel has no releases yet");
  return pick.tag_name.replace(/^v/, "");
};

// Brings `<root>/_admin` to the newest admin panel release, logging what happened. Never throws:
// a failed download leaves whatever `_admin/` holds and says how to retry. Returns whether
// `_admin/` is usable afterwards.
export const installLatestAdmin = async (
  root: string,
  beta: boolean,
): Promise<boolean> => {
  try {
    const version = await latestAdminVersion(beta);
    const result = await ensureAdmin(root, version);
    console.log(
      result === "installed"
        ? `✓ Admin panel ${version} -> _admin/`
        : `✓ Admin panel already on ${version}`,
    );
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const usable = existsSync(join(root, "_admin", "index.html"));
    console.warn(
      `• Could not install the admin panel: ${reason}
  ${
    usable
      ? "Keeping the _admin/ already there."
      : "The admin panel is not available."
  } Run "bunx njin update --admin" to retry.`,
    );
    return usable;
  }
};
