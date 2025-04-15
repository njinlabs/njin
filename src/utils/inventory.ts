import Product from "@njin-entities/product";
import ProfitLedger from "@njin-entities/profit-ledger";
import StockBatch from "@njin-entities/stock-batch";
import StockLedger from "@njin-entities/stock-ledger";
import { type Dinero } from "dinero.js";
import { DateTime } from "luxon";
import { EntityManager } from "typeorm";
import { currency } from "./currency";

export const plus = async (
  em: EntityManager,
  records: {
    product: Product;
    quantity: number;
    receivedAt?: DateTime;
    price?: Dinero;
  }[],
  {
    batchMode,
  }: {
    batchMode?: "update" | "create";
  }
) => {
  let oldBatches =
    batchMode === "update"
      ? await em
          .getRepository(StockBatch)
          .createQueryBuilder("batch")
          .where("batch.productId IN (:...ids)", {
            ids: records.map((item) => item.product.id),
          })
          .andWhere("batch.quantity > 0")
          .orderBy("batch.productId", "ASC")
          .addOrderBy("batch.receivedAt", "DESC")
          .setLock("pessimistic_write")
          .getMany()
      : [];

  const batches = records.map(
    ({ product, quantity, receivedAt, price = currency(0) }) => {
      let batch =
        oldBatches.find((el) => el.productId === product.id) ||
        new StockBatch();

      batch.quantity = (batch.quantity || 0) + quantity;
      batch.product = product;
      batch.price = price || batch.price || 0;
      if (!batch.receivedAt) batch.receivedAt = receivedAt || DateTime.now();

      return batch;
    }
  );

  const ledgers = records.map(({ quantity, product }) => {
    const ledger = new StockLedger();
    ledger.add = quantity;
    ledger.current = product.stock;
    ledger.product = product;

    return ledger;
  });

  const products = records.map(({ product, quantity }) => {
    product.stock = product.stock + quantity;

    return product;
  });

  await em.getRepository(StockLedger).save(ledgers);
  await em.getRepository(StockBatch).upsert(batches, ["id"]);
  await em.getRepository(Product).upsert(products, ["id"]);

  return [ledgers, batches] as [StockLedger[], StockBatch[]];
};

export const minus = async (
  em: EntityManager,
  records: {
    product: Product;
    quantity: number;
  }[],
  {
    mode,
    profitLedgerRecord = true,
  }: {
    mode: "FIFO" | "LIFO";
    profitLedgerRecord?: boolean;
  }
): Promise<[StockLedger[], StockBatch[], ProfitLedger | null]> => {
  const oldBatchesQuery = em
    .getRepository(StockBatch)
    .createQueryBuilder("batch")
    .where("batch.productId IN (:...productIds)", {
      productIds: records.map((item) => item.product.id),
    })
    .andWhere("batch.quantity > 0")
    .setLock("pessimistic_write")
    .orderBy("batch.productId", "ASC");

  if (mode === "FIFO") {
    oldBatchesQuery.addOrderBy("batch.receivedAt", "ASC");
  } else {
    oldBatchesQuery.addOrderBy("batch.receivedAt", "DESC");
  }

  const oldBatches = await oldBatchesQuery.getMany();

  const batches = records.reduce(
    (carry, { product, quantity }) => {
      const filteredOldBatches = oldBatches.filter(
        (el) => el.productId === product.id && el.quantity > 0
      );

      let diffs = quantity;
      while (diffs > 0) {
        const batch = filteredOldBatches.shift();
        if (!batch) throw new Error("Out of batch");

        const amountAfter = batch.quantity - diffs;

        if (amountAfter >= 0) {
          carry.cost = carry.cost.add(batch.price.multiply(diffs));
          batch.quantity = amountAfter;

          diffs = 0;
        } else {
          carry.cost = carry.cost.add(batch.price.multiply(batch.quantity));
          batch.quantity = 0;

          diffs = Math.abs(amountAfter);
        }

        carry.data.push(batch);
      }

      return carry;
    },
    {
      data: [] as StockBatch[],
      cost: currency(0),
    }
  );

  const ledgers = records.map(({ quantity, product }) => {
    const ledger = new StockLedger();
    ledger.add = 0 - quantity;
    ledger.current = product.stock;
    ledger.product = product;

    return ledger;
  });

  const products = records.map(({ product, quantity }) => {
    product.stock = product.stock - quantity;

    return product;
  });

  await em.getRepository(StockLedger).save(ledgers);
  await em.getRepository(StockBatch).upsert(batches.data, ["id"]);
  await em.getRepository(Product).upsert(products, ["id"]);

  if (profitLedgerRecord) {
    const oldProfitRecord = await em
      .getRepository(ProfitLedger)
      .createQueryBuilder("profit")
      .orderBy("profit.createdAt", "DESC")
      .setLock("pessimistic_write")
      .getOne();

    const profit = new ProfitLedger();
    profit.add = currency(0).subtract(batches.cost);
    profit.current = oldProfitRecord?.result || currency(0);

    await em.getRepository(ProfitLedger).save(profit);

    return [ledgers, batches.data, profit];
  }

  return [ledgers, batches.data, null];
};
