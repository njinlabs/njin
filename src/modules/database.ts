import { Module } from "@njin-types/module";
import { AppDataSource } from "../database/source";
import cli from "./cli";
import { DataSource } from "typeorm";

class Database implements Module {
  public source!: DataSource;

  async boot() {
    this.source = await AppDataSource()
      .initialize()
      .catch((e) => {
        cli.ui.logger.error(e);
        process.exit();
      });
  }
}

export default new Database();
