import { Hono } from "hono";
import validator from "../middlewares/validator";
import { createUserValidation } from "../validations/user";
import User from "../database/entities/user";
import { successResponse } from "../utils/response";

const user = new Hono();

user.post("/", validator("json", createUserValidation), async (c) => {
  const { password, ...data } = await c.req.valid("json");

  const user = User.fromPlain(data);
  user.plainPassword = password;

  await user.save();

  return c.json(successResponse("User created", user.serialize()));
});

export default user;
