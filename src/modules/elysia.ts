import cors from "@elysia/cors";
import { getConfig } from "../core/config";
import { UniqueConstraintError } from "../core/model";
import { makeModule } from "../core/module";
import { serveWorker } from "../core/worker";
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
      // No startup log here — the CLI prints one consolidated banner after every
      // module has finished booting (src/core/banner.ts), instead of one line per module.
      // Worker mode (NJIN_WORKER=1, set by the generated `njin build:worker` entry) skips
      // the real socket entirely — requests arrive via postMessage() from a supervisor-owned
      // Worker thread instead (see src/core/worker.ts).
      spin: () => {
        if (process.env.NJIN_WORKER === "1") {
          serveWorker(app);
        } else {
          app.listen(getConfig().port);
        }
      },
    };
  };

  return fn;
});

export default elysia;
