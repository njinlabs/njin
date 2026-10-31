import Elysia, { status } from "elysia";
import z from "zod";
import { makeModule } from "../core/module";
import db from "./db";
import elysia from "./elysia";
import { issueToken } from "./token";

const setup = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const { default: user } = await import("../models/user");
    const { ensureFullAccessGroup } = await import("../models/access_group");

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

          // The first admin can do everything, and has to be able to hand out narrower access.
          const created = await user.create({
            ...body,
            password: Bun.password.hashSync(body.password),
            groups: [await ensureFullAccessGroup()],
          });

          const { bearer } = await issueToken({
            user: created.id,
            kind: "session",
          });

          const { password: _, ...safeUser } = created as typeof created & {
            password: string;
          };

          return {
            data: {
              token: bearer,
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
