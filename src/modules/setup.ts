import { makeModule } from "../core/module";
import Elysia, { status } from "elysia";
import moment from "moment";
import { RecordId, Table, Uuid } from "surrealdb";
import z from "zod";
import elysia from "./elysia";
import surreal from "./surreal";

const tokenTable = new Table("token");

const setup = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const { default: user } = await import("../models/user");

    type Token = {
      hash: string;
      createdAt: string;
      updatedAt: string;
      user: RecordId;
    };

    const hasUsers = async () => {
      const [[row]] = await surreal().query<[{ count: number }[]]>(
        `SELECT count() as count FROM ${user.prefix} GROUP ALL`,
      );
      return (row?.count ?? 0) > 0;
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

          const plainToken = Uuid.v7().toString();
          const [token] = await surreal()
            .create<Token>(tokenTable)
            .content({
              hash: new Bun.CryptoHasher("sha256").update(plainToken).digest("utf8"),
              user: created.id,
              createdAt: moment().toISOString(),
              updatedAt: moment().toISOString(),
            });

          await surreal().relate(token!.id, new Table("user_token"), created.id);

          const { password: _, ...safeUser } = created as typeof created & { password: string };

          return {
            data: {
              token: `${tokenTable.toString()}:${token!.id.id}:${plainToken}`,
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
