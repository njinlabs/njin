import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bunFilesystemAdapter from "../../../src/core/adapters/bun_filesystem";
import { loadConfig } from "../../../src/core/config";

// write()/unlink() resolve their configured dir against getConfig().rootDir — every test
// below passes an already-absolute dir (mkdtempSync), which resolve() lets win outright,
// but getConfig() still needs a loaded config to call at all.
await loadConfig();

describe("bunFilesystemAdapter", () => {
  it("defaults dir to ./uploads", () => {
    const adapter = bunFilesystemAdapter();
    expect(adapter.dir).toBe("./uploads");
  });

  it("writes a file, deriving a unique name from the original name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "njin-bunfs-"));
    try {
      const adapter = bunFilesystemAdapter({ dir });
      const file = new File(["hello world"], "myphoto.png", { type: "image/png" });

      const result = await adapter.write(file);

      expect(result.name).toMatch(/^myphoto_[a-z0-9]{10}\.png$/);
      expect(result.size).toBe(file.size);
      expect(result.type).toBe("image/png");
      expect(result.meta).toBeNull();
      expect(result.url).toBe(`/uploads/${result.name}`);
      expect(existsSync(join(dir, result.name))).toBe(true);

      const written = await Bun.file(join(dir, result.name)).text();
      expect(written).toBe("hello world");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles filenames with multiple extensions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "njin-bunfs-"));
    try {
      const adapter = bunFilesystemAdapter({ dir });
      const file = new File(["data"], "archive.tar.gz", { type: "application/gzip" });

      const result = await adapter.write(file);

      expect(result.name).toMatch(/^archive_[a-z0-9]{10}\.tar\.gz$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unlinks a previously written file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "njin-bunfs-"));
    try {
      const adapter = bunFilesystemAdapter({ dir });
      const file = new File(["bye"], "note.txt", { type: "text/plain" });
      const written = await adapter.write(file);

      expect(existsSync(join(dir, written.name))).toBe(true);

      await adapter.unlink({ ...written, id: undefined as never, createdAt: "", updatedAt: "" });

      expect(existsSync(join(dir, written.name))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
