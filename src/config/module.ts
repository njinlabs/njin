import api from "../modules/api";
import auth from "../modules/auth";
import elysia from "../modules/elysia";
import file from "../modules/file";
import logger from "../modules/logger";
import setup from "../modules/setup";
import surreal from "../modules/surreal";
import view from "../modules/view";

const modules = [
  logger.init(),
  surreal.init(),
  elysia.init(),
  await file.init(),
  await auth.init(),
  await setup.init(),
  await api.init(),
  await view.init(),
] as const;

export default modules;
