import { describe, expect, it } from "bun:test";
import { getConfig, loadConfig } from "../../src/core/config";
import { definePlugin } from "../../src/core/plugin";

// Thunks are never actually invoked in these tests — loadConfig()/getConfig() only
// carry the array references around, they don't resolve them. Identity is all that
// matters for the assertions below, so `as any` for the return shape is fine here.
const thunk = (name: string) => (() => Promise.resolve({ default: { name } })) as any;

describe("loadConfig — plugin merging", () => {
  it("merges a plugin's models/vars/hooks/events/routes, plugin-first then the project's own", async () => {
    const pluginModel = thunk("plugin-model");
    const projectModel = thunk("project-model");
    const pluginRoute = thunk("plugin-route");
    const projectRoute = thunk("project-route");

    const plugin = definePlugin({ models: [pluginModel], routes: [pluginRoute] });

    await loadConfig({ plugins: [plugin], models: [projectModel], routes: [projectRoute] });

    expect(getConfig().models).toEqual([pluginModel, projectModel]);
    expect(getConfig().routes).toEqual([pluginRoute, projectRoute]);
  });

  it("preserves registration order across multiple plugins", async () => {
    const a = thunk("a");
    const b = thunk("b");
    const project = thunk("project");

    const pluginA = definePlugin({ hooks: [a] });
    const pluginB = definePlugin({ hooks: [b] });

    await loadConfig({ plugins: [pluginA, pluginB], hooks: [project] });

    expect(getConfig().hooks).toEqual([a, b, project]);
  });

  it("collects init() only from plugins that define one, preserving order", async () => {
    const calls: string[] = [];
    const pluginA = definePlugin({ init: () => { calls.push("a"); } });
    const pluginB = definePlugin({}); // no init
    const pluginC = definePlugin({ init: async () => { calls.push("c"); } });

    await loadConfig({ plugins: [pluginA, pluginB, pluginC] });

    expect(getConfig().pluginInits).toHaveLength(2);
    for (const init of getConfig().pluginInits) await init();
    expect(calls).toEqual(["a", "c"]);
  });

  it("merges a plugin's helpers, plugin-first then the project's own", async () => {
    const pluginHelper = thunk("plugin-helper");
    const projectHelper = thunk("project-helper");

    const plugin = definePlugin({ helpers: [pluginHelper] });

    await loadConfig({ plugins: [plugin], helpers: [projectHelper] });

    expect(getConfig().helpers).toEqual([pluginHelper, projectHelper]);
  });

  it("behaves exactly as before when no plugins are configured", async () => {
    const model = thunk("solo-model");

    await loadConfig({ models: [model] });

    expect(getConfig().models).toEqual([model]);
    expect(getConfig().pluginInits).toEqual([]);
  });
});
