import Elysia, { status } from "elysia";
import moment from "moment";
import z from "zod";
import { tokenTable } from "../core/db/internal";
import { makeModule } from "../core/module";
import db from "./db";
import elysia from "./elysia";

const setup = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const { default: user } = await import("../models/user");

    const hasUsers = async () => {
      return (await db().count(user.def)) > 0;
    };

    const controller = new Elysia({ prefix: "/api/setup" })

      // Status — admin panel calls this on startup
      .get("/status", async () => {
        return { needsSetup: !(await hasUsers()) };
      })

      // Create first admin — locked once any user exists
      .post(
        "/",
        async ({ body }) => {
          if (await hasUsers()) {
            return status(403, { message: "Setup already completed" });
          }

          const created = await user.create({
            ...body,
            password: Bun.password.hashSync(body.password),
          });

          const plainToken = Bun.randomUUIDv7();
          const token = await db().insert(tokenTable, {
            hash: new Bun.CryptoHasher("sha256")
              .update(plainToken)
              .digest("utf8"),
            user: created.id,
            createdAt: moment().toISOString(),
            updatedAt: moment().toISOString(),
          });

          const { password: _, ...safeUser } = created as typeof created & {
            password: string;
          };

          return {
            data: {
              token: `token:${token.id}:${plainToken}`,
              user: safeUser,
            },
          };
        },
        {
          body: z.object({
            name: z.string().min(1),
            email: z.email(),
            password: z.string().min(8),
          }),
        },
      );

    elysia().use(controller);

    return {};
  };

  return fn;
});

export default setup;
