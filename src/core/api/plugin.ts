import type {
  EventFactory,
  HelperFactory,
  HookFactory,
  LoggerStream,
  McpToolFactory,
  ModelFactory,
  RouteFactory,
  StaticRoute,
  VarsFactory,
} from "../runtime/config";

// One thing a plugin can be granted on: a resource of the access catalog, next to the models and
// settings groups. The plugin's routes guard themselves with `auth: { can: [resource, action] }`,
// and a group can then be given `<resource>:<action>` like any other grant.
export type PluginPermission = {
  resource: string;
  actions: string[];
  // Whether "own" means anything for it: the resource has rows with an owner.
  scoped?: boolean;
};

export type Plugin = {
  models?: ModelFactory[];
  vars?: VarsFactory[];
  helpers?: HelperFactory[];
  hooks?: HookFactory[];
  events?: EventFactory[];
  routes?: RouteFactory[];
  static?: StaticRoute[];
  permissions?: PluginPermission[];
  // Where the plugin's admin side is: the file `defineAdminPlugin` is default-exported from,
  // as `import.meta.resolve("./admin/index.tsx")` (or a path). In development the dev server
  // serves it; the admin reads the plugin's name from the module itself.
  admin?: string[];
  mcp?: { tools?: McpToolFactory[] };
  logger?: { streams?: LoggerStream[] };
  init?: () => Promise<void> | void;
};

// Identity function — DX/typing only, same purpose as defineConfig/route().
export const definePlugin = (plugin: Plugin): Plugin => plugin;
