// See dev.ts for why these are dynamic imports — NODE_ENV must be set before
// view.ts (reached transitively) evaluates, and static imports would run first.
process.env.NODE_ENV = "production";

const { boot } = await import("../core/runtime/boot");
const { printBanner } = await import("../core/runtime/banner");

await boot();
printBanner({ mode: "production" });
