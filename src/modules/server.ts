import { Module } from "@njin-types/module";
import { Hono } from "hono";
import cli from "./cli";
import { colors, Instructions } from "@poppinss/cliui";
import handlers from "../handlers";
import { cors } from "hono/cors";
import { errorResponse } from "../utils/response";

class Server implements Module {
  public port = process.env.PORT || 8080;
  public hono = new Hono();
  public sticker!: Instructions;

  boot() {
    this.sticker = cli.ui.sticker();

    this.hono.use("/api/*", cors());

    handlers.forEach((handler) => {
      this.hono.route(handler.path, handler.action);
    });

    this.hono.onError((err, c) => {
      cli.ui.logger.error(err);
      return c.json(errorResponse(new Error("Internal server error")), 500);
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
