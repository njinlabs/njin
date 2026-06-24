#!/usr/bin/env bun
const [command] = process.argv.slice(2);

switch (command) {
  case "dev":
    await import("./dev");
    break;
  case "start":
    await import("./start");
    break;
  case "build":
    await import("./build");
    break;
  default:
    console.log(`Usage: njin <dev|build|start>

  dev    Run the dev server (Vite HMR + live reload)
  build  Build for production -> ./out (public/, _admin/, views/, server)
  start  Run from source in production mode (no compile)`);
    process.exit(command ? 1 : 0);
}
