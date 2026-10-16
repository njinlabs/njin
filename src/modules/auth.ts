import bearer from "@elysia/bearer";
import Elysia, { status } from "elysia";
import moment from "moment";
import z from "zod";
import { tokenTable } from "../core/db/internal";
import { makeModule } from "../core/module";
import db from "./db";
import elysia from "./elysia";

// Session tokens look like "token:<id>:<secret>" — the prefix is part of the credential's
// format, not a table reference.
const TOKEN_PREFIX = "token";

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

            const token = (await db().find(tokenTable, tokenId, {
              populate: ["user"],
            })) as (Token & { id: string }) | null;

            // A token whose user was deleted is just a bad credential (the link is left as a
            // bare id then, not a record).
            if (!token || typeof token.user !== "object") {
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
          await db().remove(tokenTable, tokenId);

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

            const plainToken = Bun.randomUUIDv7();

            const token = await db().insert(tokenTable, {
              hash: new Bun.CryptoHasher("sha256")
                .update(plainToken)
                .digest("utf8"),
              user: data.id,
              createdAt: moment().toISOString(),
              updatedAt: moment().toISOString(),
            });

            const { password: _, ...safeData } = data as typeof data & {
              password: string;
            };

            return {
              data: {
                ...safeData,
                token: `${TOKEN_PREFIX}:${token.id}:${plainToken}`,
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
