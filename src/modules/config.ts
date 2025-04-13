import { Module } from "@njin-types/module";
import { type NjinConfig } from "@njin-types/njin";

class Config implements Module {
  public njin: NjinConfig = {};

  async boot() {
    const config = Bun.file(process.env.CONFIG_FILE || "./njin.config.json");

    if (await config.exists()) {
      this.njin = await config.json();
    }
  }
}

export default new Config();
