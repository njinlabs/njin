import { describe, expect, it } from "bun:test";
import { resolveSafePath, sanitizeFileName } from "../../src/core/path_guard";
import { join } from "node:path";

const baseDir = join("d:/njin", "uploads");

describe("resolveSafePath", () => {
  it("resolves a normal nested path", () => {
    expect(resolveSafePath(baseDir, "photo.png")).toBe(join(baseDir, "photo.png"));
  });

  it("rejects path traversal that escapes baseDir", () => {
    expect(resolveSafePath(baseDir, "../../etc/passwd")).toBeNull();
  });

  it("rejects an absolute path that resolves outside baseDir", () => {
    expect(resolveSafePath(baseDir, "../../../secrets.env")).toBeNull();
  });

  it("allows a path that merely starts similarly but stays inside baseDir", () => {
    expect(resolveSafePath(baseDir, "sub/dir/file.txt")).toBe(join(baseDir, "sub/dir/file.txt"));
  });

  it("rejects a sibling directory that merely shares baseDir as a string prefix", () => {
    // baseDir = ".../uploads" — a naive `startsWith(baseDir)` check would let this through
    // because ".../uploads-secret" also starts with ".../uploads".
    expect(resolveSafePath(baseDir, "../uploads-secret/file.txt")).toBeNull();
  });

  it("allows baseDir itself", () => {
    expect(resolveSafePath(baseDir, ".")).toBe(join(baseDir));
  });
});

describe("sanitizeFileName", () => {
  it("passes through a normal filename", () => {
    expect(sanitizeFileName("photo.png")).toBe("photo.png");
  });

  it("strips directory traversal down to the final segment", () => {
    expect(sanitizeFileName("../../../etc/config.ts")).toBe("config.ts");
  });

  it("strips a leading absolute path", () => {
    expect(sanitizeFileName("/etc/passwd")).toBe("passwd");
  });

  it("falls back to a safe default for a name with no usable segment", () => {
    expect(sanitizeFileName("..")).toBe("file");
    expect(sanitizeFileName(".")).toBe("file");
    expect(sanitizeFileName("")).toBe("file");
  });
});
