import type {
  EventFactory,
  HelperFactory,
  HookFactory,
  McpToolFactory,
  ModelFactory,
  RouteFactory,
  VarsFactory,
} from "./config";

export type Plugin = {
  models?: ModelFactory[];
  vars?: VarsFactory[];
  helpers?: HelperFactory[];
  hooks?: HookFactory[];
  events?: EventFactory[];
  routes?: RouteFactory[];
  mcp?: { tools?: McpToolFactory[] };
  init?: () => Promise<void> | void;
};

// Identity function — DX/typing only, same purpose as defineConfig/route().
export const definePlugin = (plugin: Plugin): Plugin => plugin;
