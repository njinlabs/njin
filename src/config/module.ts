import { loadConfig } from "../core/config";
import admin from "../modules/admin";
import analytics from "../modules/analytics";
import api from "../modules/api";
import auth from "../modules/auth";
import elysia from "../modules/elysia";
import file from "../modules/file";
import img from "../modules/img";
import logger from "../modules/logger";
import plugin from "../modules/plugin";
import setup from "../modules/setup";
import surreal from "../modules/surreal";
import users from "../modules/users";
import vars from "../modules/vars";
import view from "../modules/view";

// Must resolve before anything below reads getConfig() — db path, port, file
// adapter, and the model registry all come from the consuming project's config.ts.
await loadConfig();

const modules = [
  logger.init(),
  // Awaited — surreal's init() now performs the actual DB connect (see surreal.ts),
  // so plugin.init() below (which may query the DB, e.g. reading its own vars group)
  // never runs against an unconnected instance.
  await surreal.init(),
  elysia.init(),
  // Early — after elysia/surreal singletons exist (and surreal is connected), but well
  // before api.init() (which drains hooks/events and mounts models/routes) — so a
  // plugin's own setup always finishes before its own contributed routes/hooks/events go live.
  await plugin.init(),
  await file.init(),
  await auth.init(),
  await setup.init(),
  await api.init(),
  await vars.init(),
  await img.init(),
  await analytics.init(),
  await users.init(),
  await admin.init(),
  await view.init(),
] as const;

export default modules;
