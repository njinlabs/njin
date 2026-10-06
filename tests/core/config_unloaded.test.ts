import { describe, expect, it } from "bun:test";
import { getConfig } from "../../src/core/config";

// Own file: config.test.ts calls loadConfig(), and the resolved config is module state —
// this needs a registry where it was never loaded.
describe("getConfig before loadConfig", () => {
  it("throws a clear error", () => {
    expect(() => getConfig()).toThrow("Config not loaded yet");
  });
});
