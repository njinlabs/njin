import Product from "@njin-entities/product";
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
import { composeProductValidation } from "@njin-validations/product";
import { Hono } from "hono";
import { ILike } from "typeorm";

const product = new Hono<Njin>()
  .use(auth("user"))
  .delete(
    "/:id",
    acl("product", "write"),
    validator("param", uuidParamValidation),
    async (c) => {
      const { id } = c.req.valid("param");
      const product = await Product.findOneByOrFail({ id });
      await product.remove();

      return c.json(response("Product deleted", product.serialize()));
    }
  )
  .put(
    "/:id",
    acl("product", "write"),
    validator("param", uuidParamValidation),
    validator("json", composeProductValidation),
    async (c) => {
      const product = await Product.findOneAndAssign(
        await c.req.valid("param"),
        await c.req.valid("json")
      );
      await product.save();

      return c.json(response("Product updated", product.serialize()));
    }
  )
  .get(
    "/:id",
    acl("product", "read"),
    validator("param", uuidParamValidation),
    async (c) => {
      const { id } = await c.req.valid("param");
      const product = await Product.findOneByOrFail({ id });

      return c.json(response("Product result", product.serialize()));
    }
  )
  .post(
    "/",
    acl("product", "write"),
    validator("json", composeProductValidation),
    async (c) => {
      const product = Product.fromPlain(await c.req.valid("json"));
      await product.save();

      return c.json(response("Product created", product.serialize()));
    }
  )
  .get(
    "/",
    acl("product", "read"),
    validator("query", metaDataValidation),
    async (c) => {
      const result = await withMeta(
        Product,
        await c.req.valid("query"),
        ({ search }) =>
          search
            ? {
                where: {
                  name: ILike(`%${search}%`),
                },
              }
            : {}
      );

      return c.json(response("Product result", result.data, result.meta));
    }
  );

export default product;
