import modules from "./modules";

(async () => {
  for (const module of modules) {
    await module.boot();
  }
})();
