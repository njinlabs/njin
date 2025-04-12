import { cliui } from "@poppinss/cliui";
import { Module } from "@njin-types/module";
import { Command } from "commander";
import { version } from "../../package.json";
import commands from "../commands";

class CLI implements Module {
  public ui = cliui();
  public program = new Command();

  boot() {
    this.program.name("njin").description("CLI for Njin").version(version);

    commands.forEach((command) => {
      command();
    });
  }
}

export default new CLI();
