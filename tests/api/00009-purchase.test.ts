import purchase from "@njin-handlers/purchase";
import { describe, expect, test } from "bun:test";
import { testClient } from "hono/testing";
import { defaultTestData } from "../bootstrap";
import Product from "@njin-entities/product";
import { faker } from "@faker-js/faker";
import Supplier from "@njin-entities/supplier";

describe("Purchase API", async () => {
  const token = (await defaultTestData()).tokens.superuser;
  const client = testClient(purchase);

  test("Create purchase", async () => {
    const [product] = await Product.find();
    const supplier = await Supplier.fromPlain({
      email: faker.internet.email(),
      fullname: faker.company.name(),
      phone: faker.phone.number(),
    }).save();

    const purchase = await client.index.$post(
      {
        json: {
          items: [
            {
              productId: product.id,
              quantity: faker.number.int({ min: 1, max: product.stock }),
            },
          ],
          status: "PENDING",
          supplier: supplier.id,
          fees: [
            {
              name: "Ongkos Kirim",
              amount: {
                value: 25000,
              },
            },
            {
              name: "Biaya Admin",
              percentage: {
                value: 5,
              },
            },
            {
              name: "PPN",
              percentage: {
                value: 11,
                fromGrandTotal: true,
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

    expect(purchase.status).toBe(200);
  });
});
