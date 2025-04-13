import { faker } from "@faker-js/faker";
import aclConfig from "@njin-config/acl.config";
import auth from "@njin-handlers/auth";
import setup from "@njin-handlers/setup";
import { describe, expect, test } from "bun:test";
import { testClient } from "hono/testing";

const email = faker.internet.email();
const password = faker.internet.password();

describe("Setup API", () => {
  const client = testClient(setup);

  test("Initial setup", async () => {
    const res = await client.index.$post({
      json: {
        superuser: {
          fullname: faker.person.fullName(),
          email,
          password,
          controls: aclConfig,
        },
      },
    });

    expect(res.status).toBe(200);
  });
});

describe("Auth API", () => {
  const client = testClient(auth);
  const data = { token: "" };

  test("Login", async () => {
    const login = await client.index.$post({
      json: {
        email,
        password,
      },
    });

    expect(login.status).toBe(200);

    data.token = (await login.json()).data!.token;
  });

  test("Check token", async () => {
    const check = await client.index.$get(
      {},
      {
        headers: {
          Authorization: `Bearer ${data.token}`,
        },
      }
    );

    expect(check.status).toBe(200);
  });

  test("Logout", async () => {
    const logout = await client.index.$delete(
      {},
      {
        headers: {
          Authorization: `Bearer ${data.token}`,
        },
      }
    );

    expect(logout.status).toBe(200);
  });
});
