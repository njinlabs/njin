import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMIN_MARKER,
  adminAssetUrls,
  ensureAdmin,
  latestAdminVersion,
} from "../../src/cli/admin_install";

let root: string;
let tarball: Uint8Array;
let calls: string[];

const sha256 = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

// Serves a release the way GitHub does: the archive and its .sha256 file.
const makeFetch = (checksum?: string): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith(".sha256"))
      return new Response(`${checksum ?? sha256(tarball)}  admin.tar.gz\n`);
    if (url.endsWith(".tar.gz")) return new Response(tarball as BodyInit);
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "njin-admin-install-"));
  calls = [];

  const src = join(root, "..", `src-${Date.now()}-${Math.random()}`);
  mkdirSync(join(src, "assets"), { recursive: true });
  writeFileSync(join(src, "index.html"), "<html>new admin</html>");
  writeFileSync(join(src, "assets", "app.js"), "1");
  const tar = Bun.spawn(
    ["tar", "-czf", "-", "-C", src, "index.html", "assets"],
    { stdout: "pipe" },
  );
  tarball = new Uint8Array(await new Response(tar.stdout).arrayBuffer());
  await tar.exited;
  rmSync(src, { recursive: true, force: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ensureAdmin", () => {
  it("builds the release URLs from the version", () => {
    expect(adminAssetUrls("1.2.3")).toEqual({
      tarball:
        "https://github.com/njinlabs/njin-admin/releases/download/v1.2.3/njin-admin-v1.2.3.tar.gz",
      checksum:
        "https://github.com/njinlabs/njin-admin/releases/download/v1.2.3/njin-admin-v1.2.3.tar.gz.sha256",
    });
  });

  it("installs into _admin/ and records the version", async () => {
    expect(await ensureAdmin(root, "1.0.0", makeFetch())).toBe("installed");

    expect(readFileSync(join(root, "_admin", "index.html"), "utf8")).toBe(
      "<html>new admin</html>",
    );
    expect(existsSync(join(root, "_admin", "assets", "app.js"))).toBe(true);
    expect(
      readFileSync(join(root, "_admin", ADMIN_MARKER), "utf8").trim(),
    ).toBe("1.0.0");
    expect(existsSync(join(root, ".njin-admin-staging"))).toBe(false);
  });

  it("downloads nothing when _admin/ already holds that version", async () => {
    await ensureAdmin(root, "1.0.0", makeFetch());
    calls.length = 0;

    expect(await ensureAdmin(root, "1.0.0", makeFetch())).toBe("current");
    expect(calls).toEqual([]);
  });

  it("replaces another version and drops its stale files", async () => {
    await ensureAdmin(root, "1.0.0", makeFetch());
    writeFileSync(join(root, "_admin", "assets", "stale.js"), "x");

    expect(await ensureAdmin(root, "2.0.0", makeFetch())).toBe("installed");
    expect(existsSync(join(root, "_admin", "assets", "stale.js"))).toBe(false);
    expect(
      readFileSync(join(root, "_admin", ADMIN_MARKER), "utf8").trim(),
    ).toBe("2.0.0");
  });

  it("replaces a folder with no version marker (an older scaffold's panel)", async () => {
    mkdirSync(join(root, "_admin"));
    writeFileSync(join(root, "_admin", "index.html"), "<html>old</html>");

    await ensureAdmin(root, "1.0.0", makeFetch());
    expect(readFileSync(join(root, "_admin", "index.html"), "utf8")).toBe(
      "<html>new admin</html>",
    );
  });

  it("refuses an archive that fails its checksum and keeps the current _admin/", async () => {
    mkdirSync(join(root, "_admin"));
    writeFileSync(join(root, "_admin", "index.html"), "<html>old</html>");

    await expect(
      ensureAdmin(root, "1.0.0", makeFetch("0".repeat(64))),
    ).rejects.toThrow("checksum mismatch");
    expect(readFileSync(join(root, "_admin", "index.html"), "utf8")).toBe(
      "<html>old</html>",
    );
    expect(existsSync(join(root, ".njin-admin-staging"))).toBe(false);
  });

  it("throws on a release that does not exist", async () => {
    const missing = (async () =>
      new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(ensureAdmin(root, "9.9.9", missing)).rejects.toThrow(
      "HTTP 404",
    );
  });
});

describe("latestAdminVersion", () => {
  const releases = [
    { tag_name: "v0.2.0-beta.1", prerelease: true, draft: false },
    { tag_name: "v0.3.0", prerelease: false, draft: true },
    { tag_name: "v0.1.0", prerelease: false, draft: false },
  ];
  const list = (body: unknown, status = 200): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;

  it("takes the newest stable release on the stable channel, skipping drafts", async () => {
    expect(await latestAdminVersion(false, list(releases))).toBe("0.1.0");
  });

  it("takes the newest release of all on the beta channel", async () => {
    expect(await latestAdminVersion(true, list(releases))).toBe("0.2.0-beta.1");
  });

  it("falls back to a prerelease while no stable release exists", async () => {
    expect(await latestAdminVersion(false, list([releases[0]]))).toBe(
      "0.2.0-beta.1",
    );
  });

  it("throws when there are no releases or GitHub refuses", async () => {
    await expect(latestAdminVersion(false, list([]))).rejects.toThrow(
      "no releases",
    );
    await expect(latestAdminVersion(false, list({}, 403))).rejects.toThrow(
      "HTTP 403",
    );
  });
});
