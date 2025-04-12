import { faker } from "@faker-js/faker";
import PaymentMethod from "@njin-entities/payment-method";
import { describe, expect, test } from "bun:test";
import { testClient } from "hono/testing";
import paymentMethod from "../../src/handlers/payment-method";
import { defaultTestData } from "../bootstrap";

describe("Payment Method API", async () => {
  const token = (await defaultTestData()).tokens.superuser;
  const client = testClient(paymentMethod);

  test("Create payment method", async () => {
    const paymentMethod = await client.index.$post(
      {
        json: {
          name: "Transfer",
          accountName: faker.finance.accountName(),
          accountNumber: faker.finance.accountNumber(),
        },
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(paymentMethod.status).toBe(200);
    expect(await PaymentMethod.count()).toBe(1);
  });

  test("Update payment method", async () => {
    const [source] = await PaymentMethod.find();

    const json = {
      name: "Transfer",
      accountName: faker.finance.accountName(),
      accountNumber: faker.finance.accountNumber(),
    };

    const paymentMethod = await client[":id"].$put(
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

    expect(paymentMethod.status).toBe(200);
    await source.reload();

    expect(source.name).toBe(json.name);
    expect(source.accountName).toBe(json.accountName);
    expect(source.accountNumber).toBe(json.accountNumber);
  });

  test("Get payment method", async () => {
    const [source] = await PaymentMethod.find();
    const paymentMethod = await client[":id"].$get(
      {
        param: {
          id: source.id,
        },
      },
      {
        headers: { Authorization: token },
      }
    );

    expect(paymentMethod.status).toBe(200);
  });

  test("Delete payment method", async () => {
    const [source] = await PaymentMethod.find();

    const paymentMethod = await client[":id"].$delete(
      {
        param: {
          id: source.id,
        },
      },
      {
        headers: { Authorization: token },
      }
    );

    expect(paymentMethod.status).toBe(200);
  });

  test("Index payment method", async () => {
    const paymentMethod = await client.index.$get(
      {
        query: {},
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(paymentMethod.status).toBe(200);
    expect(await PaymentMethod.count()).toBe(0);
  });
});
