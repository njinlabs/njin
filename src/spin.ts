import modules from "@njin/config/module";
import type { ModuleReturn } from "./core/module";

for (const module of modules) {
  if ((module as ModuleReturn).spin) await (module as ModuleReturn).spin!();
}
