import { colors, Instructions } from "@poppinss/cliui";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { TypeORMError } from "typeorm";
import handlers from "../handlers";
import cli from "./cli";
import { Module } from "@njin-types/module";
import { response } from "@njin-utils/response";
import { HTTPException } from "hono/http-exception";

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

    this.hono.notFound((c) => {
      return c.json(response("Route not found"), 404);
    });

    this.hono.onError(async (err, c) => {
      if (err instanceof HTTPException)
        return c.json(
          response((await err.res?.text()) || err.message),
          err.status
        );

      cli.ui.logger.error(err);
      if (err instanceof TypeORMError) {
        return c.json(
          response(err.message),
          err.name === "EntityNotFoundError" ? 404 : 500
        );
      }

      return c.json(response("Internal server error"), 500);
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
