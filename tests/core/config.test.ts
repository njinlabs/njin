import { describe, expect, it } from "bun:test";
import { getConfig, loadConfig } from "../../src/core/config";
import { definePlugin } from "../../src/core/plugin";

// Thunks are never actually invoked in these tests — loadConfig()/getConfig() only
// carry the array references around, they don't resolve them. Identity is all that
// matters for the assertions below, so `as any` for the return shape is fine here.
const thunk = (name: string) =>
  (() => Promise.resolve({ default: { name } })) as any;

describe("loadConfig — plugin merging", () => {
  it("merges a plugin's models/vars/hooks/events/routes, plugin-first then the project's own", async () => {
    const pluginModel = thunk("plugin-model");
    const projectModel = thunk("project-model");
    const pluginRoute = thunk("plugin-route");
    const projectRoute = thunk("project-route");

    const plugin = definePlugin({
      models: [pluginModel],
      routes: [pluginRoute],
    });

    await loadConfig({
      plugins: [plugin],
      models: [projectModel],
      routes: [projectRoute],
    });

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
    const pluginA = definePlugin({
      init: () => {
        calls.push("a");
      },
    });
    const pluginB = definePlugin({}); // no init
    const pluginC = definePlugin({
      init: async () => {
        calls.push("c");
      },
    });

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

  it("merges a plugin's MCP tools, plugin-first, keeping the project's redirectUris", async () => {
    const pluginTool = thunk("plugin-tool");
    const projectTool = thunk("project-tool");

    const plugin = definePlugin({ mcp: { tools: [pluginTool] } });

    await loadConfig({
      plugins: [plugin],
      mcp: { tools: [projectTool], redirectUris: ["https://a.example/cb"] },
    });

    expect(getConfig().mcp).toEqual({
      tools: [pluginTool, projectTool],
      redirectUris: ["https://a.example/cb"],
    });
  });

  it("behaves exactly as before when no plugins are configured", async () => {
    const model = thunk("solo-model");

    await loadConfig({ models: [model] });

    expect(getConfig().models).toEqual([model]);
    expect(getConfig().pluginInits).toEqual([]);
  });
});

describe("loadConfig — static routes", () => {
  it("defaults to none", async () => {
    await loadConfig({});
    expect(getConfig().static).toEqual([]);
  });

  it("merges plugin and project routes, normalizing and de-duplicating", async () => {
    await loadConfig({
      plugins: [definePlugin({ static: ["/about/"] })],
      static: ["/", "/about", "/contact"],
    });
    expect(getConfig().static.map((r) => r.route)).toEqual([
      "/about",
      "/",
      "/contact",
    ]);
  });

  it("accepts dynamic routes and per-route revalidate, later entries winning", async () => {
    await loadConfig({
      plugins: [definePlugin({ static: ["/blog/[slug]"] })],
      static: [{ route: "/blog/:slug", revalidate: 60 }, "/"],
    });
    expect(getConfig().static).toEqual([
      { route: "/blog/:slug", revalidate: 60 },
      { route: "/", revalidate: undefined },
    ]);
  });

  it.each(["about", "/a/*", "/a/../b", "/a//b", "/a/[b", "/a/:"])(
    "rejects %p",
    async (route) => {
      await expect(loadConfig({ static: [route] })).rejects.toThrow(
        /Invalid static route/,
      );
    },
  );

  it.each([0, -5, Number.NaN])("rejects revalidate %p", async (revalidate) => {
    await expect(
      loadConfig({ static: [{ route: "/", revalidate }] }),
    ).rejects.toThrow(/Invalid revalidate/);
  });
});

describe("loadConfig — i18n", () => {
  it("is absent unless configured", async () => {
    await loadConfig({});
    expect(getConfig().i18n).toBeUndefined();
  });

  it("defaults the default locale to the first one", async () => {
    await loadConfig({ i18n: { locales: ["id", "en"] } });
    expect(getConfig().i18n).toEqual({
      locales: ["id", "en"],
      defaultLocale: "id",
    });
  });

  it("keeps an explicit default locale and accepts regional codes", async () => {
    await loadConfig({
      i18n: { locales: ["en", "pt-BR"], defaultLocale: "pt-BR" },
    });
    expect(getConfig().i18n?.defaultLocale).toBe("pt-BR");
  });

  it("rejects an empty list, a bad code, a duplicate and an unknown default", async () => {
    await expect(loadConfig({ i18n: { locales: [] } })).rejects.toThrow(
      "at least one locale",
    );
    await expect(
      loadConfig({ i18n: { locales: ["en", "x y"] } }),
    ).rejects.toThrow("not a locale code");
    await expect(
      loadConfig({ i18n: { locales: ["en", "en"] } }),
    ).rejects.toThrow("twice");
    await expect(
      loadConfig({ i18n: { locales: ["en"], defaultLocale: "id" } }),
    ).rejects.toThrow("not in config.i18n.locales");
  });
});
