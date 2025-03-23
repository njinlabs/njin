import Product from "@njin-entities/product";
import StockAdjustment from "@njin-entities/stock-adjustment";
import StockBatch from "@njin-entities/stock-batch";
import StockLedger from "@njin-entities/stock-ledger";
import acl from "@njin-middlewares/acl";
import auth from "@njin-middlewares/auth";
import validator from "@njin-middlewares/validator";
import database from "@njin-modules/database";
import { Njin } from "@njin-types/njin";
import { response } from "@njin-utils/response";
import { makeAdjustmentValidation } from "@njin-validations/transaction";
import { Hono } from "hono";

const transaction = new Hono<Njin>();

transaction.use(auth("user"));

transaction.post(
  "/adjustment",
  acl("transaction", "makeAdjustment"),
  validator("json", makeAdjustmentValidation),
  async (c) => {
    const { adjustments } = await c.req.valid("json");

    const result = await database.source.transaction(async (em) => {
      const products = await em
        .getRepository(Product)
        .createQueryBuilder("product")
        .where("product.id IN (:...ids)", {
          ids: adjustments.map((adj) => adj.productId),
        })
        .setLock("pessimistic_write")
        .getMany();

      const pairRecords: {
        adjustment: StockAdjustment;
        ledger: StockLedger;
      }[] = [];

      for (const { productId, quantity } of adjustments) {
        const product = products.find((el) => el.id === productId);
        if (!product) continue;

        const adjustment = new StockAdjustment();
        adjustment.product = product;
        adjustment.quantity = quantity;
        adjustment.user = c.var.auth.user;

        const ledger = new StockLedger();
        ledger.add = quantity - product.stock;
        ledger.adjustment = adjustment;
        ledger.current = product.stock;
        ledger.product = product;
        ledger.result = quantity;

        product.stock = quantity;

        pairRecords.push({ adjustment, ledger });
      }

      await em
        .getRepository(StockAdjustment)
        .save(pairRecords.map((item) => item.adjustment));
      await em
        .getRepository(StockLedger)
        .save(pairRecords.map((item) => item.ledger));
      await em.getRepository(Product).upsert(products, ["id"]);

      const addBatches = pairRecords
        .map((item) => item.ledger)
        .filter((item) => item.add >= 0)
        .map((item) => ({
          product: item.product,
          quantity: item.add,
        }));
      const subBatches = pairRecords
        .map((item) => item.ledger)
        .filter((item) => item.add < 0)
        .map((item) => ({
          product: item.product,
          quantity: Math.abs(item.add),
        }));

      if (addBatches.length) await StockBatch.add(addBatches, em, true);
      if (subBatches.length) await StockBatch.sub(subBatches, "FIFO", em);

      return pairRecords.map((item) => item.adjustment);
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
