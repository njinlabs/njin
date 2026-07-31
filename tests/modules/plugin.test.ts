import { describe, expect, it } from "bun:test";
import { loadConfig } from "../../src/core/config";
import { definePlugin } from "../../src/core/plugin";
import plugin from "../../src/modules/plugin";

describe("plugin module", () => {
  it("calls every plugin's init(), in order, sequentially", async () => {
    const order: string[] = [];
    const pluginA = definePlugin({
      init: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("first");
      },
    });
    const pluginB = definePlugin({
      init: () => {
        order.push("second");
      },
    });

    await loadConfig({ plugins: [pluginA, pluginB] });
    await plugin.init();

    expect(order).toEqual(["first", "second"]);
  });

  it("is a no-op when no plugin defines init()", async () => {
    await loadConfig({ plugins: [definePlugin({})] });

    await expect(plugin.init()).resolves.toEqual({});
  });

  it("propagates a throwing init() instead of swallowing it", async () => {
    await loadConfig({ plugins: [definePlugin({ init: () => { throw new Error("boom"); } })] });

    await expect(plugin.init()).rejects.toThrow("boom");
  });
});
