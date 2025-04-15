import { faker } from "@faker-js/faker";
import Product from "@njin-entities/product";
import product from "@njin-handlers/product";
import transaction from "@njin-handlers/transaction";
import { describe, expect, test } from "bun:test";
import { testClient } from "hono/testing";
import { defaultTestData } from "../bootstrap";

describe("Transaction API", async () => {
  const token = (await defaultTestData()).tokens.superuser;
  const client = testClient(transaction);
  const clientProduct = testClient(product);

  test("Create product", async () => {
    const product = await clientProduct.index.$post(
      {
        json: {
          name: faker.commerce.productName(),
          price: {
            value: faker.number.int({ min: 15000, max: 100000 }),
          },
          barcode: `${faker.string.numeric(12)}`,
          category: {
            name: faker.commerce.department(),
          },
          code: `FAKE-${faker.string.alphanumeric(12).toUpperCase()}`,
          stockSetting: {
            default: "PCS",
          },
        },
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(product.status).toBe(200);
    expect(await Product.count()).toBe(1);
  });

  test("Make stock adjustment", async () => {
    const [product] = await Product.find();

    const adjustment = await client.adjustment.$post(
      {
        json: {
          adjustments: [
            {
              productId: product.id,
              quantity: 50,
              price: {
                value: product.price.getAmount(),
              },
            },
          ],
        },
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(adjustment.status).toBe(200);
  });
});
