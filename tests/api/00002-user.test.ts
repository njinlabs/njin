import { faker } from "@faker-js/faker";
import User from "@njin-entities/user";
import { describe, expect, test } from "bun:test";
import { testClient } from "hono/testing";
import user from "../../src/handlers/user";
import { defaultTestData } from "../bootstrap";

describe("User API", async () => {
  const token = (await defaultTestData()).tokens.superuser;
  const client = testClient(user);

  test("Create user", async () => {
    const user = await client.index.$post(
      {
        json: {
          email: faker.internet.email(),
          fullname: faker.person.fullName(),
          password: faker.internet.password(),
          controls: {
            user: ["read"],
            supplier: ["read"],
            product: ["read"],
            paymentMethod: ["read"],
            customer: ["read"],
          },
        },
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(user.status).toBe(200);
    expect(await User.count()).toBe(2);
  });

  test("Update user", async () => {
    const [source] = await User.find();
    const json = {
      email: faker.internet.email(),
      fullname: faker.person.fullName(),
      controls: source.controls || {},
      password: faker.internet.password(),
    };

    const user = await client[":id"].$put(
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

    expect(user.status).toBe(200);
    await source.reload();

    expect(source.fullname).toBe(json.fullname);
    expect(source.email).toBe(json.email.toLowerCase());
  });

  test("Get user", async () => {
    const [source] = await User.find();

    const user = await client[":id"].$get(
      {
        param: { id: source.id },
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(user.status).toBe(200);
  });

  test("Delete user", async () => {
    const [source] = await User.find();

    const user = await client[":id"].$delete(
      {
        param: { id: source.id },
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(user.status).toBe(200);
  });

  test("Index user", async () => {
    const user = await client.index.$get(
      {
        query: {},
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(user.status).toBe(200);
    expect(await User.count()).toBe(1);
  });
});
