import { Module } from "@njin-types/module";
import { AppDataSource } from "../database/source";
import cli from "./cli";

class Database implements Module {
  async boot() {
    await AppDataSource.initialize().catch((e) => {
      cli.ui.logger.error(e);
      process.exit();
    });
  }
}

export default new Database();
