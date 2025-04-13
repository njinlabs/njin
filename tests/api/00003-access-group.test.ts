import { describe, expect, test } from "bun:test";
import { testClient } from "hono/testing";
import { defaultTestData } from "../bootstrap";
import aclConfig from "@njin-config/acl.config";
import AccessGroup from "@njin-entities/access-group";
import accessGroup from "@njin-handlers/access-group";

describe("Access Group API", async () => {
  const token = (await defaultTestData()).tokens.superuser;
  const client = testClient(accessGroup);

  test("Create access group", async () => {
    const group = await client.index.$post(
      {
        json: {
          controls: aclConfig,
          name: "All",
        },
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(group.status).toBe(200);
    expect(await AccessGroup.count()).toBe(1);
  });

  test("Update access group", async () => {
    const [source] = await AccessGroup.find();

    const json = {
      controls: aclConfig,
      name: "Super",
    };

    const group = await client[":id"].$put(
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

    expect(group.status).toBe(200);
    await source.reload();

    expect(source.name).toBe(json.name);
  });

  test("Get access group", async () => {
    const [source] = await AccessGroup.find();
    const group = await client[":id"].$get(
      {
        param: {
          id: source.id,
        },
      },
      {
        headers: { Authorization: token },
      }
    );

    expect(group.status).toBe(200);
  });

  test("Delete access group", async () => {
    const [source] = await AccessGroup.find();

    const group = await client[":id"].$delete(
      {
        param: {
          id: source.id,
        },
      },
      {
        headers: { Authorization: token },
      }
    );

    expect(group.status).toBe(200);
  });

  test("Index access group", async () => {
    const group = await client.index.$get(
      {
        query: {},
      },
      {
        headers: {
          Authorization: token,
        },
      }
    );

    expect(group.status).toBe(200);
    expect(await AccessGroup.count()).toBe(0);
  });
});
