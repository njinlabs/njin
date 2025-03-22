import aclConfig from "@njin-config/acl.config";
import User from "@njin-entities/user";
import validator from "@njin-middlewares/validator";
import { Njin } from "@njin-types/njin";
import { response } from "@njin-utils/response";
import { initialSetupValidation } from "@njin-validations/setup";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const setup = new Hono<Njin>();

setup.use(async (_c, next) => {
  const validator: (() => Promise<boolean>)[] = [];

  validator.push(async () => {
    return Boolean(await User.count());
  });

  const result = await Promise.all(validator.map((call) => call()));

  for (const status of result) {
    if (status) {
      throw new HTTPException(403, {
        message: "Initial setup is not allowed",
      });
    }
  }

  await next();
});

setup.get("/", (c) => c.json(response("Setup allowed")));

setup.post("/", validator("json", initialSetupValidation), async (c) => {
  const {
    superuser: { password, controls: _control, ...data },
  } = await c.req.valid("json");

  const user = User.fromPlain(data);
  user.plainPassword = password;
  user.controls = aclConfig;

  await user.save();

  return c.json(
    response("Initial setup succeed", {
      user: user.serialize(),
    })
  );
});

export default setup;
