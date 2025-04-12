import User from "@njin-entities/user";
import acl from "@njin-middlewares/acl";
import auth from "@njin-middlewares/auth";
import validator from "@njin-middlewares/validator";
import { Njin } from "@njin-types/njin";
import { response } from "@njin-utils/response";
import { withMeta } from "@njin-utils/with-meta";
import {
  metaDataValidation,
  uuidParamValidation,
} from "@njin-validations/general";
import {
  createUserValidation,
  updateUserValidation,
} from "@njin-validations/user";
import { Hono } from "hono";
import { ILike } from "typeorm";

const user = new Hono<Njin>()
  .use(auth("user"))
  .delete(
    "/:id",
    acl("user", "write"),
    validator("param", uuidParamValidation),
    async (c) => {
      const user = await User.findOneByOrFail({ id: c.req.param("id") });
      await user.remove();

      return c.json(response("User deleted", user.serialize()));
    }
  )
  .put(
    "/:id",
    acl("user", "write"),
    validator("param", uuidParamValidation),
    validator("json", updateUserValidation),
    async (c) => {
      const { password, ...data } = await c.req.valid("json");
      const user = await User.findOneAndAssign(
        await c.req.valid("param"),
        data
      );
      if (password) user.password = password;

      await user.save();

      return c.json(response("User updated", user.serialize()));
    }
  )
  .get(
    "/:id",
    acl("user", "read"),
    validator("param", uuidParamValidation),
    async (c) => {
      const user = await User.findOneByOrFail({ id: c.req.param("id") });

      return c.json(response("User result", user.serialize()));
    }
  )
  .post(
    "/",
    acl("user", "write"),
    validator("json", createUserValidation),
    async (c) => {
      const { password, ...data } = await c.req.valid("json");

      const user = User.fromPlain(data);
      user.plainPassword = password;

      await user.save();

      return c.json(response("User created", user.serialize()));
    }
  )
  .get(
    "/",
    acl("user", "read"),
    validator("query", metaDataValidation),
    async (c) => {
      const result = await withMeta(
        User,
        await c.req.valid("query"),
        ({ search }) =>
          search
            ? {
                where: {
                  fullname: ILike(`%${search}%`),
                },
              }
            : {}
      );

      return c.json(response("User result", result.data, result.meta));
    }
  );

export default user;
