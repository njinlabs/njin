import AccessGroup from "@njin-entities/access-group";
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
import { controlValidation } from "@njin-validations/user";
import { Hono } from "hono";
import z from "zod";

const accessGroup = new Hono<Njin>();

accessGroup.use(auth("user"));

accessGroup.delete(
  "/:id",
  acl("accessGroup", "write"),
  validator("param", uuidParamValidation),
  async (c) => {
    const { id } = await c.req.valid("param");

    const group = await AccessGroup.findOneByOrFail({ id });
    await group.remove();

    return c.json(response("Access group deleted", group.serialize()));
  }
);

accessGroup.put(
  "/:id",
  acl("accessGroup", "write"),
  validator("param", uuidParamValidation),
  validator(
    "json",
    z.object({
      name: z.string(),
      controls: z.object(controlValidation),
    })
  ),
  async (c) => {
    const { id } = await c.req.valid("param");
    const { name, controls } = await c.req.valid("json");

    const group = await AccessGroup.findOneByOrFail({ id });
    group.name = name;
    group.controls = controls;
    await group.save();

    return c.json(response("Access group updated", group.serialize()));
  }
);

accessGroup.get(
  "/:id",
  acl("accessGroup", "read"),
  validator("param", uuidParamValidation),
  async (c) => {
    const { id } = await c.req.valid("param");

    const group = await AccessGroup.findOneByOrFail({ id });

    return c.json(response("Access group result", group.serialize()));
  }
);

accessGroup.post(
  "/",
  acl("accessGroup", "write"),
  validator(
    "json",
    z.object({
      name: z.string(),
      controls: z.object(controlValidation),
    })
  ),
  async (c) => {
    const data = await c.req.valid("json");

    const group = AccessGroup.fromPlain(data);
    await group.save();

    return c.json(response("Access group created", group.serialize()));
  }
);

accessGroup.get(
  "/",
  acl("accessGroup", "read"),
  validator("query", metaDataValidation),
  async (c) => {
    const result = await withMeta(AccessGroup, await c.req.valid("query"));

    return c.json(response("Access group result", result.data, result.meta));
  }
);

export default accessGroup;
