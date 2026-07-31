import type { EventFactory, HookFactory, ModelFactory, RouteFactory, VarsFactory } from "./config";

export type Plugin = {
  models?: ModelFactory[];
  vars?: VarsFactory[];
  hooks?: HookFactory[];
  events?: EventFactory[];
  routes?: RouteFactory[];
  init?: () => Promise<void> | void;
};

// Identity function — DX/typing only, same purpose as defineConfig/route().
export const definePlugin = (plugin: Plugin): Plugin => plugin;
