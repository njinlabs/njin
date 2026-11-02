// Static imports are hoisted and evaluated before this file's own body runs, so setting
// NODE_ENV here would be too late if "../core/runtime/boot" were a static import — view.ts
// (reached transitively) reads NODE_ENV at module-load time. Dynamic imports execute in
// normal program order, so they run after the line below.
process.env.NODE_ENV ??= "development";

const { boot } = await import("../core/runtime/boot");
const { printBanner } = await import("../core/runtime/banner");

await boot();
printBanner({ mode: "development" });
