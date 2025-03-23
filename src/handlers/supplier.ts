import Supplier from "@njin-entities/supplier";
import acl from "@njin-middlewares/acl";
import auth from "@njin-middlewares/auth";
import validator from "@njin-middlewares/validator";
import { Njin } from "@njin-types/njin";
import { response } from "@njin-utils/response";
import { withMeta } from "@njin-utils/with-meta";
import { composeSupplierValidation } from "@njin-validations/supplier";
import {
  metaDataValidation,
  uuidParamValidation,
} from "@njin-validations/general";
import { Hono } from "hono";
import { ILike } from "typeorm";

const supplier = new Hono<Njin>();

supplier.use(auth("user"));

supplier.delete(
  "/:id",
  acl("supplier", "write"),
  validator("param", uuidParamValidation),
  async (c) => {
    const { id } = await c.req.valid("param");
    const supplier = await Supplier.findOneByOrFail({ id });
    await supplier.remove();

    return c.json(response("Supplier deleted", supplier.serialize()));
  }
);

supplier.put(
  "/:id",
  acl("supplier", "write"),
  validator("param", uuidParamValidation),
  validator("json", composeSupplierValidation),
  async (c) => {
    const { id } = await c.req.valid("param");
    const { fullname, email = null, phone = null } = await c.req.valid("json");

    const supplier = await Supplier.findOneByOrFail({ id });
    supplier.fullname = fullname;
    supplier.email = email;
    supplier.phone = phone;
    await supplier.save();

    return c.json(response("Supplier updated", supplier.serialize()));
  }
);

supplier.get(
  "/:id",
  acl("supplier", "read"),
  validator("param", uuidParamValidation),
  async (c) => {
    const { id } = await c.req.valid("param");
    const supplier = await Supplier.findOneByOrFail({ id });

    return c.json(response("Supplier result", supplier.serialize()));
  }
);

supplier.post(
  "/",
  acl("supplier", "write"),
  validator("json", composeSupplierValidation),
  async (c) => {
    const supplier = Supplier.fromPlain(await c.req.valid("json"));
    await supplier.save();

    return c.json(response("Supplier created", supplier.serialize()));
  }
);

supplier.get(
  "/",
  acl("supplier", "read"),
  validator("query", metaDataValidation),
  async (c) => {
    const result = await withMeta(
      Supplier,
      await c.req.valid("query"),
      ({ search }) =>
        search
          ? {
              where: [
                {
                  fullname: ILike(`%${search}%`),
                },
                {
                  phone: ILike(`%${search}%`),
                },
                {
                  email: ILike(`%${search}%`),
                },
              ],
            }
          : {}
    );

    return c.json(response("Supplier result", result.data, result.meta));
  }
);

export default supplier;
