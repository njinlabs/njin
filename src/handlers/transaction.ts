import Product from "@njin-entities/product";
import StockAdjustment from "@njin-entities/stock-adjustment";
import StockBatch from "@njin-entities/stock-batch";
import StockLedger from "@njin-entities/stock-ledger";
import acl from "@njin-middlewares/acl";
import auth from "@njin-middlewares/auth";
import validator from "@njin-middlewares/validator";
import database from "@njin-modules/database";
import { Njin } from "@njin-types/njin";
import { minus, plus } from "@njin-utils/inventory";
import { response } from "@njin-utils/response";
import { makeAdjustmentValidation } from "@njin-validations/transaction";
import { Hono } from "hono";

const transaction = new Hono<Njin>()
  .use(auth("user"))
  .post(
    "/adjustment",
    acl("transaction", "makeAdjustment"),
    validator("json", makeAdjustmentValidation),
    async (c) => {
      const { adjustments, profitLedgerRecord } = await c.req.valid("json");

      const result = await database.source.transaction(async (em) => {
        const products = await em
          .getRepository(Product)
          .createQueryBuilder("product")
          .where("product.id IN (:...ids)", {
            ids: adjustments.map((adj) => adj.productId),
          })
          .setLock("pessimistic_write")
          .getMany();

        const records = adjustments.reduce(
          (carry, { productId, quantity, price }) => {
            const product = products.find((el) => el.id === productId);
            if (!product) return carry;

            const adjustment = new StockAdjustment();
            adjustment.product = product;
            adjustment.quantity = quantity;
            adjustment.user = c.var.auth.user;

            carry.push(Object.assign(adjustment, { price }));

            return carry;
          },
          [] as (StockAdjustment & { price?: number })[]
        );

        await em.getRepository(StockAdjustment).save(records);

        const rawRecords = records.map((item) => ({
          product: item.product,
          quantity: item.quantity - item.product.stock,
          price: item.price,
        }));

        const addBatches = rawRecords.filter((item) => item.quantity >= 0);

        const subBatches = rawRecords
          .filter((item) => item.quantity < 0)
          .map((item) => ({
            product: item.product,
            quantity: Math.abs(item.quantity),
          }));

        if (addBatches.length)
          await plus(em, addBatches, { batchMode: "update" });
        if (subBatches.length)
          await minus(em, subBatches, { mode: "FIFO", profitLedgerRecord });

        return records;
      });

      return c.json(
        response(
          "Stock adjustment created",
          result.map((item) => item.serialize())
        )
      );
    }
  );

export default transaction;
