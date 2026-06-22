import env from "@njin/config/env";
import cors from "@elysia/cors";
import { UniqueConstraintError } from "@njin/core/model";
import { makeModule } from "@njin/core/module";
import Elysia, { status, ValidationError, type AnyElysia } from "elysia";
import logger from "./logger";

// Elysia's query parser only understands object/record-shaped query schemas as a single
// JSON-encoded string — not the conventional bracket notation (`field[key]=value`,
// `field[key][op]=value`) that Axios/qs/jQuery produce by default. Parsed here, globally,
// before validation runs, so every route's Zod query schema "just works" with that notation
// without any per-route setup.
const BRACKET_KEY_RE = /^([^[\]]+)\[([^\]]+)\](?:\[([^\]]+)\])?$/;

export const injectBracketQuery = ({ query, request }: { query: Record<string, unknown>; request: Request }) => {
  const params = new URL(request.url).searchParams;

  for (const [key, value] of params) {
    const match = BRACKET_KEY_RE.exec(key);
    if (!match) continue;

    const [, root, sub1, sub2] = match as unknown as [string, string, string, string | undefined];
    const existingRoot = query[root];
    const rootObj = typeof existingRoot === "object" && existingRoot !== null ? (existingRoot as Record<string, unknown>) : {};

    if (sub2) {
      const existingSub = rootObj[sub1];
      rootObj[sub1] = {
        ...(typeof existingSub === "object" && existingSub !== null ? (existingSub as Record<string, unknown>) : {}),
        [sub2]: value,
      };
    } else {
      rootObj[sub1] = value;
    }

    query[root] = rootObj;
  }
};

const elysia = makeModule(() => {
  let app: AnyElysia;

  const fn = () => {
    return app;
  };

  fn.init = () => {
    app = new Elysia()
      .use(cors())
      .onTransform({ as: "global" }, injectBracketQuery)
      .onError(({ error }) => {
      if (error instanceof ValidationError) {
        return status(422, {
          message: "Validation error",
          errors: (error.detail("") as { errors: { value: {}; summary: string }[] }).errors.map(({ value, summary, ...err }) => err),
        });
      }

      if (error instanceof UniqueConstraintError) {
        return status(409, {
          message: error.message,
          field: error.field,
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
