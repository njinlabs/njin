import { describe, expect, it } from "bun:test";
import { resolveSafePath } from "../../src/core/path_guard";
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
});
