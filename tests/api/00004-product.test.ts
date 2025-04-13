import { faker } from "@faker-js/faker";
import Product from "@njin-entities/product";
import product from "@njin-handlers/product";
import { describe, expect, test } from "bun:test";
import { testClient } from "hono/testing";
import { defaultTestData } from "../bootstrap";

describe("Product API", async () => {
  const token = (await defaultTestData()).tokens.superuser;
  const client = testClient(product);

  test("Create product", async () => {
    const product = await client.index.$post(
      {
        json: {
          name: faker.commerce.productName(),
          price: faker.number.int({ min: 15000, max: 100000 }),
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

  test("Update product", async () => {
    const [source] = await Product.find();

    const json = {
      name: faker.commerce.productName(),
      price: faker.number.int({ min: 15000, max: 100000 }),
      barcode: `${faker.string.numeric(12)}`,
      category: {
        name: faker.commerce.department(),
      },
      code: `FAKE-${faker.string.alphanumeric(12).toUpperCase()}`,
      stockSetting: {
        default: "PCS",
      },
    };

    const product = await client[":id"].$put(
      {
        param: {
          id: source.id,
        },
        json,
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(product.status).toBe(200);
    await source.reload();

    expect(source.name).toBe(json.name);
    expect(source.barcode).toBe(json.barcode);
    expect(source.code).toBe(json.code);
    expect(source.price).toBe(json.price);
  });

  test("Get product", async () => {
    const [source] = await Product.find();
    const product = await client[":id"].$get(
      {
        param: {
          id: source.id,
        },
      },
      {
        headers: { Authorization: token },
      }
    );

    expect(product.status).toBe(200);
  });

  test("Delete product", async () => {
    const [source] = await Product.find();

    const product = await client[":id"].$delete(
      {
        param: {
          id: source.id,
        },
      },
      {
        headers: { Authorization: token },
      }
    );

    expect(product.status).toBe(200);
  });

  test("Index product", async () => {
    const product = await client.index.$get(
      {
        query: {},
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(product.status).toBe(200);
    expect(await Product.count()).toBe(0);
  });
});
