import env from "@njin/config/env";
import cors from "@elysia/cors";
import { makeModule } from "@njin/core/module";
import Elysia, { status, ValidationError, type AnyElysia } from "elysia";
import logger from "./logger";

const elysia = makeModule(() => {
  let app: AnyElysia;

  const fn = () => {
    return app;
  };

  fn.init = () => {
    app = new Elysia().use(cors()).onError(({ error }) => {
      if (error instanceof ValidationError) {
        return status(422, {
          message: "Validation error",
          errors: (error.detail("") as { errors: { value: {}; summary: string }[] }).errors.map(({ value, summary, ...err }) => err),
        });
      }

      logger().error(error);

      return status(500, {
        message: "Internal Server Error",
      });
    });

    return {
      spin: () => {
        app.listen(env.port);
        logger().info(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
      },
    };
  };

  return fn;
});

export default elysia;
