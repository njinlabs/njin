import modules from "../config/module";
import type { ModuleReturn } from "./module";

// Runs every module's spin() in the order config/module.ts defines — boot.ts is the
// shared implementation behind `njin dev`/`njin start` (and the legacy src/spin.ts entry).
export const boot = async (): Promise<void> => {
  for (const module of modules) {
    if ((module as ModuleReturn).spin) await (module as ModuleReturn).spin!();
  }
};
