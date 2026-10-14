import type {
  EventFactory,
  HelperFactory,
  HookFactory,
  LoggerStream,
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
  static?: string[];
  mcp?: { tools?: McpToolFactory[] };
  logger?: { streams?: LoggerStream[] };
  init?: () => Promise<void> | void;
};

// Identity function — DX/typing only, same purpose as defineConfig/route().
export const definePlugin = (plugin: Plugin): Plugin => plugin;
