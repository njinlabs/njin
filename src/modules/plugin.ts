import { getConfig } from "../core/config";
import { makeModule } from "../core/module";

const plugin = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    // Sequential, awaited, and never caught — a plugin whose init() throws must fail
    // boot loudly, same contract as hook/event side-effect imports in api.ts.
    for (const init of getConfig().pluginInits) await init();
    return {};
  };

  return fn;
});

export default plugin;
