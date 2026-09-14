import pino from "pino";
import pretty from "pino-pretty";
import { makeModule } from "../core/module";

const logger = makeModule(() => {
  let p: pino.Logger;

  const fn = () => p;

  fn.init = () => {
    p = pino({}, pretty({ colorize: true }));
    return {};
  };

  return fn;
});

export default logger;
