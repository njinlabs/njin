import Customer from "@njin-entities/customer";
import acl from "@njin-middlewares/acl";
import auth from "@njin-middlewares/auth";
import validator from "@njin-middlewares/validator";
import { Njin } from "@njin-types/njin";
import { response } from "@njin-utils/response";
import { withMeta } from "@njin-utils/with-meta";
import { composeCustomerValidation } from "@njin-validations/customer";
import {
  metaDataValidation,
  uuidParamValidation,
} from "@njin-validations/general";
import { Hono } from "hono";
import { ILike } from "typeorm";

const customer = new Hono<Njin>();

customer.use(auth("user"));

customer.delete(
  "/:id",
  acl("customer", "write"),
  validator("param", uuidParamValidation),
  async (c) => {
    const { id } = await c.req.valid("param");
    const customer = await Customer.findOneByOrFail({ id });
    await customer.remove();

    return c.json(response("Customer deleted", customer.serialize()));
  }
);

customer.put(
  "/:id",
  acl("customer", "write"),
  validator("param", uuidParamValidation),
  validator("json", composeCustomerValidation),
  async (c) => {
    const { id } = await c.req.valid("param");
    const { fullname, email = null, phone = null } = await c.req.valid("json");

    const customer = await Customer.findOneByOrFail({ id });
    customer.fullname = fullname;
    customer.email = email;
    customer.phone = phone;
    await customer.save();

    return c.json(response("Customer updated", customer.serialize()));
  }
);

customer.get(
  "/:id",
  acl("customer", "read"),
  validator("param", uuidParamValidation),
  async (c) => {
    const { id } = await c.req.valid("param");
    const customer = await Customer.findOneByOrFail({ id });

    return c.json(response("Customer result", customer.serialize()));
  }
);

customer.post(
  "/",
  acl("customer", "write"),
  validator("json", composeCustomerValidation),
  async (c) => {
    const customer = Customer.fromPlain(await c.req.valid("json"));
    await customer.save();

    return c.json(response("Customer created", customer.serialize()));
  }
);

customer.get(
  "/",
  acl("customer", "read"),
  validator("query", metaDataValidation),
  async (c) => {
    const result = await withMeta(
      Customer,
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

    return c.json(response("Customer result", result.data, result.meta));
  }
);

export default customer;
