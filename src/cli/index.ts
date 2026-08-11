#!/usr/bin/env bun
const [command] = process.argv.slice(2);

switch (command) {
  case "create":
    await import("./create");
    break;
  case "dev":
    await import("./dev");
    break;
  case "start":
    await import("./start");
    break;
  case "build":
    await import("./build");
    break;
  case "build:worker":
    await import("./build-worker");
    break;
  case "update":
    await import("./update");
    break;
  default:
    console.log(`Usage: njin <create|dev|build|build:worker|start|update>

  create <dir>  Scaffold a new project (defaults to current directory)
  dev           Run the dev server (Vite HMR + live reload)
  build         Build for production -> ./out (public/, _admin/, views/, server)
  build:worker  Build a headless worker for production -> ./out (public/, _admin/, views/, worker.js)
  start         Run from source in production mode (no compile)
  update        Update @njinlabs/njin to the latest version and refresh _admin/`);
    process.exit(command ? 1 : 0);
}
