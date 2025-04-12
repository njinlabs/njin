import PaymentMethod from "@njin-entities/payment-method";
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
import { composePaymentMethod } from "@njin-validations/payment-method";
import { Hono } from "hono";
import { Like } from "typeorm";

const paymentMethod = new Hono<Njin>()
  .use(auth("user"))
  .delete(
    "/:id",
    acl("paymentMethod", "write"),
    validator("param", uuidParamValidation),
    async (c) => {
      const paymentMethod = await PaymentMethod.findOneByOrFail(
        await c.req.valid("param")
      );
      await paymentMethod.remove();

      return c.json(
        response("Payment method deleted", paymentMethod.serialize())
      );
    }
  )
  .get(
    "/:id",
    acl("paymentMethod", "read"),
    validator("param", uuidParamValidation),
    async (c) => {
      const paymentMethod = await PaymentMethod.findOneByOrFail(
        await c.req.valid("param")
      );

      return c.json(
        response("Payment method result", paymentMethod.serialize())
      );
    }
  )
  .put(
    "/:id",
    acl("paymentMethod", "write"),
    validator("param", uuidParamValidation),
    validator("json", composePaymentMethod),
    async (c) => {
      const paymentMethod = await PaymentMethod.findOneAndAssign(
        await c.req.valid("param"),
        await c.req.valid("json")
      );
      await paymentMethod.save();

      return c.json(
        response("Payment method updated", paymentMethod.serialize())
      );
    }
  )
  .post(
    "/",
    acl("paymentMethod", "write"),
    validator("json", composePaymentMethod),
    async (c) => {
      const paymentMethod = await PaymentMethod.fromPlain(
        await c.req.valid("json")
      );
      await paymentMethod.save();

      return c.json(
        response("Payment method created", paymentMethod.serialize())
      );
    }
  )
  .get(
    "/",
    acl("paymentMethod", "read"),
    validator("query", metaDataValidation),
    async (c) => {
      const result = await withMeta(
        PaymentMethod,
        await c.req.valid("query"),
        ({ search }) =>
          search
            ? {
                where: [
                  {
                    name: Like(`%${search}%`),
                  },
                  {
                    accountName: Like(`%${search}%`),
                  },
                  {
                    accountNumber: Like(`%${search}%`),
                  },
                ],
              }
            : {}
      );

      return c.json(
        response("Payment method result", result.data, result.meta)
      );
    }
  );

export default paymentMethod;
