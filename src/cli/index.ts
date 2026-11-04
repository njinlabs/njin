#!/usr/bin/env bun
const [command] = process.argv.slice(2);

switch (command) {
  case "create":
    // `njin create --plugin <dir>` scaffolds a package for a plugin, not a project.
    await import(
      process.argv.includes("--plugin") ? "./create-plugin-package" : "./create"
    );
    break;
  case "plugin:create":
    await import("./plugin-create");
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
    console.log(`Usage: njin <create|plugin:create|dev|build|build:worker|start|update>

  create <dir>  Scaffold a new project (defaults to current directory)
                (--plugin scaffolds a package to publish a plugin from instead)
  plugin:create <name>
                Add a plugin to this project, in src/plugins/<name>
  dev           Run the dev server (Vite HMR + live reload)
  build         Build for production -> ./out (public/, _admin/, views/, server)
  build:worker  Build a headless worker for production -> ./out (public/, _admin/, views/, worker.js)
  start         Run from source in production mode (no compile)
  update        Update @njinlabs/njin and the admin panel (_admin/) to their latest versions
                (--beta, or --tag <name>, follows a prerelease channel instead;
                 --admin updates only the admin panel)`);
    process.exit(command ? 1 : 0);
}
