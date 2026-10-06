import bearer from "@elysia/bearer";
import Elysia, { status } from "elysia";
import moment from "moment";
import { RecordId, Table, Uuid } from "surrealdb";
import z from "zod";
import { makeModule } from "../core/module";
import elysia from "./elysia";
import surreal from "./surreal";

const table = new Table("token");

const auth = makeModule(() => {
  const fn = async () => {
    const { default: user } = await import("../models/user");

    type Token = {
      hash: string;
      createdAt: string;
      updatedAt: string;
      user: Awaited<ReturnType<typeof user.create>>;
    };

    const plugin = new Elysia({ name: "auth" }).use(bearer()).macro({
      auth: {
        resolve: async ({ bearer }) => {
          try {
            if (!bearer) {
              throw new Error("Unauthorized");
            }

            const [_table, tokenId, plainToken] = bearer.split(":");

            // Anything that isn't "token:<id>:<secret>" is just a bad credential.
            if (!tokenId || !plainToken) {
              throw new Error("Unauthorized");
            }

            const token = await surreal()
              .select<Token>(new RecordId(table, tokenId))
              .fetch("user");

            if (!token) {
              throw new Error("Unauthorized");
            }

            const hash = new Bun.CryptoHasher("sha256")
              .update(plainToken)
              .digest("utf8");

            if (hash !== token.hash) {
              throw new Error("Unauthorized");
            }

            const { password: _, ...safeUser } =
              token.user as typeof token.user & {
                password: string;
              };

            return {
              user: { ...safeUser, tokenId: token.id },
            };
          } catch (e) {
            if (e instanceof Error && e.message === "Unauthorized") {
              return status(401, {
                message: e.message,
              });
            }

            throw e;
          }
        },
      },
    });

    return {
      plugin,
    };
  };

  fn.init = async () => {
    const {
      default: user,
      DUMMY_HASH,
      findUserByEmail,
    } = await import("../models/user");

    type Token = {
      hash: string;
      createdAt: string;
      updatedAt: string;
      user: Awaited<ReturnType<typeof user.create>>;
    };

    const controller = new Elysia({
      prefix: "/api/auth",
    })
      .use((await fn()).plugin)
      .get(
        "/check-token",
        ({ user: { tokenId: _, ...user } }) => ({ data: user }),
        { auth: true },
      )
      .delete(
        "/logout",
        async ({ user: { tokenId, ...user } }) => {
          await surreal().delete(tokenId);

          return { data: user };
        },
        { auth: true },
      )
      .post(
        "/login",
        async ({ body }) => {
          try {
            const data = await findUserByEmail<
              Token["user"] & { password: string }
            >(body.email);

            // Always run one verify, even for an unknown email, so timing doesn't reveal
            // whether the account exists.
            const passwordOk = await Bun.password.verify(
              body.password,
              data?.password ?? DUMMY_HASH,
            );

            if (!data || !passwordOk) {
              throw new Error("Unauthorized");
            }

            const plainToken = Uuid.v7().toString();

            const [token] = await surreal()
              .create<Token>(table)
              .content({
                hash: new Bun.CryptoHasher("sha256")
                  .update(plainToken)
                  .digest("utf8"),
                user: data.id as unknown as Token["user"],
                createdAt: moment().toISOString(),
                updatedAt: moment().toISOString(),
              });

            await surreal().relate(token!.id, new Table("user_token"), data.id);

            const { password: _, ...safeData } = data as typeof data & {
              password: string;
            };

            return {
              data: {
                ...safeData,
                token: `${table.toString()}:${token?.id.id}:${plainToken}`,
              },
            };
          } catch (e) {
            if (e instanceof Error && e.message === "Unauthorized") {
              return status(401, {
                message: "Unauthorized",
              });
            }

            throw e;
          }
        },
        {
          body: z.object({
            email: z.email(),
            password: z.string(),
          }),
        },
      );

    elysia().use(controller);

    return {};
  };

  return fn;
});

export default auth;
