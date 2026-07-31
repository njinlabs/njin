import { describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realConfig from "../../src/core/config";

const fakeConfig = {
  port: 4321,
  db: { path: "rocksdb://data", namespace: "ns", database: "db" },
  models: [async () => ({ default: {} }), async () => ({ default: {} })],
};

// Spread the real module's other exports (loadConfig, defineConfig, ...) — without
// --isolate, mock.module() replaces the module in a registry shared across every test
// file in the run, so a partial mock here would otherwise break any other file (e.g.
// tests/core/config.test.ts) that imports loadConfig from this same specifier later.
mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => fakeConfig,
}));

const { printBanner } = await import("../../src/core/banner");

describe("printBanner", () => {
  it("prints connection info and marks admin as not found when _admin/index.html is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "njin-banner-"));
    const cwd = process.cwd();
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(dir);
      printBanner({ mode: "development" });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain("http://localhost:4321");
      expect(output).toContain("rocksdb://data");
      expect(output).toContain("ns/db");
      expect(output).toContain("2 registered");
      expect(output).toContain("not found");
      expect(output).toContain("development");
    } finally {
      logSpy.mockRestore();
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints the admin URL when _admin/index.html exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "njin-banner-"));
    const cwd = process.cwd();
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      mkdirSync(join(dir, "_admin"));
      writeFileSync(join(dir, "_admin", "index.html"), "<html></html>");
      process.chdir(dir);
      printBanner({ mode: "production" });

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain("http://localhost:4321/_admin");
      expect(output).toContain("production");
    } finally {
      logSpy.mockRestore();
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
