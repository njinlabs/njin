import { Command } from "commander";
import bootstrap from "./utils/bootstrap";

bootstrap().then((modules) =>
  (
    modules.pop() as {
      program: Command;
    }
  ).program.parse()
);
