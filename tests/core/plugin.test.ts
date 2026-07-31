import { describe, expect, it } from "bun:test";
import { definePlugin } from "../../src/core/plugin";

describe("definePlugin", () => {
  it("returns the plugin object unchanged", () => {
    const plugin = definePlugin({ init: () => {} });
    expect(definePlugin(plugin)).toBe(plugin);
  });

  it("passes an empty plugin through as-is", () => {
    const plugin = definePlugin({});
    expect(plugin).toEqual({});
  });
});
