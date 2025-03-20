import User from "@njin-entities/user";
import validator from "@njin-middlewares/validator";
import { response } from "@njin-utils/response";
import {
  metaDataValidation,
  uuidParamValidation,
} from "@njin-validations/general";
import {
  createUserValidation,
  updateUserValidation,
} from "@njin-validations/user";
import { Hono } from "hono";

const user = new Hono();

user.delete("/:id", validator("param", uuidParamValidation), async (c) => {
  const user = await User.findOneByOrFail({ id: c.req.param("id") });
  await user.remove();

  return c.json(response("User deleted", user.serialize()));
});

user.put(
  "/:id",
  validator("param", uuidParamValidation),
  validator("json", updateUserValidation),
  async (c) => {
    const user = await User.findOneByOrFail({ id: c.req.param("id") });

    const { fullname, password, email } = await c.req.valid("json");

    user.fullname = fullname;
    user.plainPassword = password;
    if (user.email.toLowerCase() !== email.toLowerCase()) user.email = email;

    await user.save();

    return c.json(response("User updated", user.serialize()));
  }
);

user.get("/:id", validator("param", uuidParamValidation), async (c) => {
  const user = await User.findOneByOrFail({ id: c.req.param("id") });

  return c.json(response("User result", user.serialize()));
});

user.post("/", validator("json", createUserValidation), async (c) => {
  const { password, ...data } = await c.req.valid("json");

  const user = User.fromPlain(data);
  user.plainPassword = password;

  await user.save();

  return c.json(response("User created", user.serialize()));
});

user.get("/", validator("query", metaDataValidation), async (c) => {
  const { perPage, page } = await c.req.valid("query");

  const users = await User.find({
    take: perPage,
    skip: (page - 1) * perPage,
  });
  const usersCount = await User.count();

  return c.json(
    response(
      "User result",
      users.map((user) => user.serialize()),
      {
        pagination: {
          page,
          perPage,
          totalItems: usersCount,
          totalPages: Math.ceil(usersCount / perPage),
        },
      }
    )
  );
});

export default user;
