import { faker } from "@faker-js/faker";
import Customer from "@njin-entities/customer";
import customer from "@njin-handlers/customer";
import { describe, expect, test } from "bun:test";
import { testClient } from "hono/testing";
import { defaultTestData } from "../bootstrap";

describe("Customer API", async () => {
  const token = (await defaultTestData()).tokens.superuser;
  const client = testClient(customer);

  test("Create customer", async () => {
    const customer = await client.index.$post(
      {
        json: {
          fullname: faker.person.fullName(),
          email: faker.internet.email(),
          phone: faker.phone.number(),
        },
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(customer.status).toBe(200);
    expect(await Customer.count()).toBe(1);
  });

  test("Update customer", async () => {
    const [source] = await Customer.find();

    const json = {
      fullname: faker.person.fullName(),
      email: faker.internet.email(),
      phone: faker.phone.number(),
    };

    const customer = await client[":id"].$put(
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

    expect(customer.status).toBe(200);
    await source.reload();

    expect(source.fullname).toBe(json.fullname);
    expect(source.email).toBe(json.email.toLowerCase());
    expect(source.phone).toBe(
      json.phone.replace(/\D/g, "").replace(/^0/, "62")
    );
  });

  test("Get customer", async () => {
    const [source] = await Customer.find();
    const customer = await client[":id"].$get(
      {
        param: {
          id: source.id,
        },
      },
      {
        headers: { Authorization: token },
      }
    );

    expect(customer.status).toBe(200);
  });

  test("Delete customer", async () => {
    const [source] = await Customer.find();

    const customer = await client[":id"].$delete(
      {
        param: {
          id: source.id,
        },
      },
      {
        headers: { Authorization: token },
      }
    );

    expect(customer.status).toBe(200);
  });

  test("Index customer", async () => {
    const customer = await client.index.$get(
      {
        query: {},
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(customer.status).toBe(200);
    expect(await Customer.count()).toBe(0);
  });
});
