import { Hono } from "hono";
import validator from "../middlewares/validator";
import { createUserValidation } from "../validations/user";
import User from "../database/entities/user";
import { successResponse } from "../utils/response";
import { metaDataValidation } from "../validations/general";

const user = new Hono();

user.post("/", validator("json", createUserValidation), async (c) => {
  const { password, ...data } = await c.req.valid("json");

  const user = User.fromPlain(data);
  user.plainPassword = password;

  await user.save();

  return c.json(successResponse("User created", user.serialize()));
});

user.get("/", validator("query", metaDataValidation), async (c) => {
  const { perPage, page } = await c.req.valid("query");

  const users = await User.find({
    take: page,
    skip: (page - 1) * perPage,
  });
  const usersCount = await User.count();

  return c.json(
    successResponse(
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
