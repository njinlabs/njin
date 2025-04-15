import ProductCategory from "@njin-entities/product-category";
import { describe, expect, test } from "bun:test";

import { faker } from "@faker-js/faker";
import Product from "@njin-entities/product";
import StockBatch from "@njin-entities/stock-batch";
import database from "@njin-modules/database";
import { currency } from "@njin-utils/currency";
import { minus, plus } from "@njin-utils/inventory";
import { type Dinero } from "dinero.js";

type InventoryMovementTest = {
  product: Product;
  quantity: number;
  price?: Dinero;
};

function inventoryMovementTest(
  mode: "FIFO" | "LIFO",
  product: Product,
  firstRecord: InventoryMovementTest,
  plusRecord: InventoryMovementTest,
  minusRecord: InventoryMovementTest
) {
  return async () => {
    let currentStock = 0;

    const [[stock], [firstBatch]] = await database.source.transaction(
      async (em) => plus(em, [firstRecord], { batchMode: "update" })
    );

    currentStock += stock.result;

    expect(product.stock).toBe(currentStock);
    expect(stock.current).toBe(0);
    expect(stock.add).toBe(firstRecord.quantity);
    expect(stock.result).toBe(firstRecord.quantity);
    expect(firstBatch.price.equalsTo(firstRecord.price ?? currency(0))).toBe(
      true
    );
    expect(firstBatch.quantity).toBe(firstRecord.quantity);

    const [[plusStock], [plusBatch]] = await database.source.transaction(
      async (em) => plus(em, [plusRecord], { batchMode: "create" })
    );

    currentStock += plusRecord.quantity;

    expect(product.stock).toBe(currentStock);
    expect(plusStock.current).toBe(stock.result);
    expect(plusStock.add).toBe(plusRecord.quantity);
    expect(plusStock.result).toBe(currentStock);
    expect(plusBatch.price.equalsTo(plusRecord.price ?? currency(0))).toBe(
      true
    );
    expect(plusBatch.quantity).toBe(plusRecord.quantity);

    const [[minusStock], minusBatches, profit] =
      await database.source.transaction(async (em) =>
        minus(em, [minusRecord], {
          mode,
          profitLedgerRecord: true,
        })
      );

    currentStock -= minusRecord.quantity;

    expect(product.stock).toBe(currentStock);
    expect(minusStock.current).toBe(plusStock.result);
    expect(minusStock.add).toBe(0 - minusRecord.quantity);
    expect(minusStock.result).toBe(currentStock);

    const groupedMinusBatches = minusBatches.reduce((carry, item) => {
      const index = carry.findIndex((el) => el.productId === item.productId);

      if (index >= 0) {
        carry[index].batches.push(item);
      } else {
        carry.push({
          productId: item.productId,
          batches: [item],
        });
      }

      return carry;
    }, [] as { productId: string; batches: StockBatch[] }[]);

    expect(groupedMinusBatches).toBeArrayOfSize(1);

    const currentQuantity = plusStock.result - minusRecord.quantity;
    const currentAllBatchesQuantity = groupedMinusBatches
      .filter((el) => el.productId === minusRecord.product.id)
      .reduce(
        (carry, item) =>
          carry +
          item.batches.reduce((carry, item) => carry + item.quantity, 0),
        0
      );

    expect(currentAllBatchesQuantity).toBe(minusRecord.product.stock);
    expect(currentAllBatchesQuantity).toBe(currentQuantity);
  };
}

describe("Product & Inventory", async () => {
  const category = ProductCategory.fromPlain({
    name: faker.commerce.department(),
  });

  const products = new Array(2).fill(null).map((_, key) =>
    Product.fromPlain({
      name: faker.commerce.productName(),
      price: currency(12500),
      barcode: `${key}${faker.string.numeric(12)}`,
      category,
      code: `FAKE-${key}-${faker.string.alphanumeric(12).toUpperCase()}`,
      stockSetting: {
        default: "PCS",
      },
    })
  );

  const [firstRecordFIFO, firstRecordLIFO] = products.map((item) => ({
    product: item,
    quantity: faker.number.int({ min: 5, max: 50 }),
    price: item.price.subtract(item.price.percentage(10)),
  }));

  const [plusRecordFIFO, plusRecordLIFO] = products.map((item) => ({
    product: item,
    quantity: faker.number.int({ min: 500, max: 1000000 }),
    price: item.price.subtract(item.price.percentage(50)),
  }));

  const minusRecordFIFO = {
    product: plusRecordFIFO.product,
    quantity: faker.number.int({
      min: firstRecordFIFO.quantity,
      max: firstRecordFIFO.quantity + plusRecordFIFO.quantity,
    }),
  };

  const minusRecordLIFO = {
    product: plusRecordLIFO.product,
    quantity: faker.number.int({
      min: firstRecordLIFO.quantity,
      max: firstRecordLIFO.quantity + plusRecordLIFO.quantity,
    }),
  };

  await test("Add product", async () => {
    await expect(category.save()).resolves.toBeInstanceOf(ProductCategory);
    await expect(Product.save(products)).resolves.toBeArray();
  });

  await test(
    "Increase & decrease product stock with FIFO",
    inventoryMovementTest(
      "FIFO",
      products[0],
      firstRecordFIFO,
      plusRecordFIFO,
      minusRecordFIFO
    )
  );

  await test(
    "Increase & decrease product stock with LIFO",
    inventoryMovementTest(
      "LIFO",
      products[1],
      plusRecordLIFO,
      firstRecordLIFO,
      minusRecordLIFO
    )
  );
});
