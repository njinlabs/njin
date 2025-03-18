import { Module } from "@njin-types/module";
import { Hono } from "hono";
import cli from "./cli";
import { colors, Instructions } from "@poppinss/cliui";
import handlers from "../handlers";

class Server implements Module {
  public port = process.env.PORT || 8080;
  public hono = new Hono();
  public sticker!: Instructions;

  boot() {
    this.sticker = cli.ui.sticker();

    handlers.forEach((handler) => {
      this.hono.route(handler.path, handler.action);
    });
  }

  start() {
    Bun.serve({
      fetch: this.hono.fetch,
      port: this.port,
    });

    this.sticker
      .add("Started HTTP server")
      .add("")
      .add(`URL: ${colors.ansi().cyan(`http://localhost:${this.port}`)}`)
      .render();
  }
}

export default new Server();
