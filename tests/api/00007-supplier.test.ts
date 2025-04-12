import { faker } from "@faker-js/faker";
import Supplier from "@njin-entities/supplier";
import { describe, expect, test } from "bun:test";
import { testClient } from "hono/testing";
import supplier from "../../src/handlers/supplier";
import { defaultTestData } from "../bootstrap";

describe("Supplier API", async () => {
  const token = (await defaultTestData()).tokens.superuser;
  const client = testClient(supplier);

  test("Create supplier", async () => {
    const supplier = await client.index.$post(
      {
        json: {
          fullname: faker.company.name(),
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

    expect(supplier.status).toBe(200);
    expect(await Supplier.count()).toBe(1);
  });

  test("Update supplier", async () => {
    const [source] = await Supplier.find();

    const json = {
      fullname: faker.company.name(),
      email: faker.internet.email(),
      phone: faker.phone.number(),
    };

    const supplier = await client[":id"].$put(
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

    expect(supplier.status).toBe(200);
    await source.reload();

    expect(source.fullname).toBe(json.fullname);
    expect(source.email).toBe(json.email.toLowerCase());
    expect(source.phone).toBe(
      json.phone.replace(/\D/g, "").replace(/^0/, "62")
    );
  });

  test("Get supplier", async () => {
    const [source] = await Supplier.find();
    const supplier = await client[":id"].$get(
      {
        param: {
          id: source.id,
        },
      },
      {
        headers: { Authorization: token },
      }
    );

    expect(supplier.status).toBe(200);
  });

  test("Delete supplier", async () => {
    const [source] = await Supplier.find();

    const supplier = await client[":id"].$delete(
      {
        param: {
          id: source.id,
        },
      },
      {
        headers: { Authorization: token },
      }
    );

    expect(supplier.status).toBe(200);
  });

  test("Index supplier", async () => {
    const supplier = await client.index.$get(
      {
        query: {},
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(supplier.status).toBe(200);
    expect(await Supplier.count()).toBe(0);
  });
});
