import User from "@njin-entities/user";
import validator from "@njin-middlewares/validator";
import { createTokenValidation } from "@njin-validations/auth";
import { verify } from "argon2";
import { Hono } from "hono";
import authLib from "@njin-modules/auth";
import { response } from "@njin-utils/response";
import { Njin } from "@njin-types/njin";

const auth = new Hono<Njin>();

auth.post("/", validator("json", createTokenValidation), async (c) => {
  const { email, password } = await c.req.valid("json");

  try {
    const user = await User.findOneByOrFail({ email });

    if (!(await verify(user.password, password))) {
      throw new Error();
    }

    const token = await authLib.use().generate(user);

    return c.json(response("Token created", { ...user.serialize(), token }));
  } catch (e) {
    console.log(e);
    return c.json(response("Unauthorized"), 401);
  }
});

export default auth;
