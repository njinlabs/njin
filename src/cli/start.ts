// See dev.ts for why these are dynamic imports — NODE_ENV must be set before
// view.ts (reached transitively) evaluates, and static imports would run first.
process.env.NODE_ENV = "production";

const { boot } = await import("../core/boot");
const { printBanner } = await import("../core/banner");

await boot();
printBanner({ mode: "production" });
