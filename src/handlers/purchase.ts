import Product from "@njin-entities/product";
import Purchase from "@njin-entities/purchase";
import PurchaseItem from "@njin-entities/purchase-item";
import acl from "@njin-middlewares/acl";
import auth from "@njin-middlewares/auth";
import validator from "@njin-middlewares/validator";
import database from "@njin-modules/database";
import { Njin } from "@njin-types/njin";
import { response } from "@njin-utils/response";
import { composePurchaseValidation } from "@njin-validations/purchase";
import { Hono } from "hono";

const purchase = new Hono<Njin>()
  .use(auth("user"))
  .post(
    "/",
    acl("purchase", "write"),
    validator("json", composePurchaseValidation),
    async (c) => {
      const { supplier, status, items, fees } = await c.req.valid("json");

      const purchase = await database.source.transaction(async (em) => {
        const products = await em
          .getRepository(Product)
          .createQueryBuilder("product")
          .where("product.id IN (:...ids)", {
            ids: items.map((item) => item.productId),
          })
          .setLock("pessimistic_write")
          .getMany();

        const purchaseItems = items
          .map((item) => {
            const product = products.find(
              (product) => item.productId === product.id
            );
            if (!product) return null;

            return PurchaseItem.fromPlain({
              name: product.name,
              price: product.price,
              total: product.price.multiply(item.quantity),
              quantity: item.quantity,
              product,
            });
          })
          .filter((item) => item) as PurchaseItem[];

        const purchase = Purchase.fromPlain({
          fees,
          status,
          supplier,
          user: c.var.auth.user,
          items: purchaseItems,
        });

        await em.getRepository(Purchase).save(purchase);

        return purchase;
      });

      return c.json(response("Purchase created", purchase.serialize()), 200);
    }
  );

export default purchase;
