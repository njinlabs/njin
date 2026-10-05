import { describe, expect, it, mock } from "bun:test";
import Elysia, { status } from "elysia";
import { RecordId } from "surrealdb";
import z from "zod";
import * as realConfig from "../../src/core/config";
import * as realElysiaModule from "../../src/modules/elysia";
import * as realMcpUpload from "../../src/modules/mcp_upload";
import { makeFakeElysia } from "../helpers/fake_elysia";

const records = new Map<string, Record<string, unknown>>();
records.set("p1", { id: "p1", title: "Hello" });
records.set("p3", { id: new RecordId("post", "p3"), title: "Linked" });
const readCalls: Record<string, unknown>[] = [];

const fakeModel = {
  name: "Post",
  prefix: "post",
  validation: z.object({
    title: z.string(),
    // Mirrors the real user model's password field — the transform must run for MCP writes
    // just like it does for REST bodies, or secrets would be stored unhashed.
    slug: z.string().transform((v) => v.toLowerCase().replaceAll(" ", "-")),
    internalFlag: z.boolean().meta({ hideForm: true }).optional(),
  }),
  read: async (opts: Record<string, unknown>) => {
    readCalls.push(opts);
    return { data: [...records.values()], meta: { total: records.size } };
  },
  show: async (id: string) => records.get(id) ?? null,
  create: async (body: Record<string, unknown>) => {
    const record = { id: "p2", ...body };
    records.set("p2", record);
    return record;
  },
  update: async (id: string, body: Record<string, unknown>) => {
    const record = { ...(records.get(id) ?? {}), ...body, id };
    records.set(id, record);
    return record;
  },
  destroy: async (id: string) => {
    const record = records.get(id) ?? { id };
    records.delete(id);
    return record;
  },
};

let seo = { title: "Default" };
const fakeVars = {
  name: "SEO",
  prefix: "seo",
  validation: z.object({ title: z.string().default("Default") }),
  get: async () => seo,
  update: async (data: Record<string, unknown>) => {
    seo = { ...seo, ...data } as typeof seo;
    return seo;
  },
};

mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({
    models: [async () => ({ default: fakeModel })],
    vars: [async () => ({ default: fakeVars })],
  }),
}));

// Real Elysia plugin (macros can't be faked with a plain object) standing in for
// mcp_token.ts's — only "Bearer ok" authenticates.
const fakeMcpTokenPlugin = new Elysia({ name: "mcp-auth" }).macro({
  mcpAuth: {
    resolve: ({ headers }) =>
      headers.authorization === "Bearer ok"
        ? { mcpToken: { id: "t1", name: "Test agent" } }
        : status(401, { message: "Unauthorized" }),
  },
});
mock.module("../../src/modules/mcp_token", () => ({
  default: async () => ({ plugin: fakeMcpTokenPlugin }),
}));

const fileRecords = new Map<string, Record<string, unknown>>();
fileRecords.set("f1", { id: "f1", name: "logo.png", url: "/uploads/logo.png" });
const fileReadCalls: Record<string, unknown>[] = [];
const removed: string[] = [];

mock.module("../../src/modules/file", () => ({
  default: () => ({
    model: {
      read: async (opts: Record<string, unknown>) => {
        fileReadCalls.push(opts);
        return {
          data: [...fileRecords.values()],
          meta: { total: fileRecords.size },
        };
      },
      show: async (id: string) => fileRecords.get(id) ?? null,
    },
    upload: async () => [],
    remove: async (id: string) => {
      removed.push(id);
      return fileRecords.get(id) ?? { id };
    },
  }),
}));

const ticketCalls: Record<string, unknown>[] = [];
mock.module("../../src/modules/mcp_upload", () => ({
  ...realMcpUpload,
  createUploadTicket: async (input: Record<string, unknown>) => {
    ticketCalls.push(input);
    return { upload_id: "up1", url: `${input.base}/mcp/upload/up1.secret` };
  },
  getUploadStatus: async (id: string) =>
    id === "up1"
      ? { files: [{ id: "f1" }], remaining: 9, expired: false }
      : null,
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const { default: mcp } = await import("../../src/modules/mcp");

await mcp.init();
const app = fakeElysia.buildApp();

let nextId = 1;
const rpc = async (
  method: string,
  params?: Record<string, unknown>,
  authorization = "Bearer ok",
) => {
  const res = await app.handle(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: authorization,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        params,
      }),
    }),
  );
  return res;
};

type ToolResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};

const callTool = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await rpc("tools/call", { name, arguments: args });
  const body = (await res.json()) as {
    result?: ToolResult;
    error?: { message: string };
  };
  const result = body.result!;
  const text = result.content[0]!.text;
  return {
    isError: result.isError === true,
    text,
    json: () => JSON.parse(text),
  };
};

describe("POST /mcp auth", () => {
  it("returns 401 without a valid token", async () => {
    const res = await rpc("tools/list", {}, "Bearer nope");
    expect(res.status).toBe(401);
  });
});

describe("tools/list", () => {
  it("exposes the content tools with destructive/read-only hints", async () => {
    const res = await rpc("tools/list", {});
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      result: {
        tools: { name: string; annotations?: Record<string, unknown> }[];
      };
    };
    const tools = new Map(body.result.tools.map((t) => [t.name, t]));

    expect([...tools.keys()].sort()).toEqual([
      "check_upload",
      "create_record",
      "create_upload_url",
      "delete_file",
      "delete_record",
      "get_file",
      "get_record",
      "get_vars",
      "list_files",
      "list_models",
      "read_records",
      "update_record",
      "update_vars",
    ]);
    expect(tools.get("delete_file")!.annotations?.destructiveHint).toBe(true);
    expect(tools.get("delete_record")!.annotations?.destructiveHint).toBe(true);
    expect(tools.get("read_records")!.annotations?.readOnlyHint).toBe(true);
  });
});

describe("list_models", () => {
  it("returns models and vars groups with schemas, hidden fields stripped", async () => {
    const { json } = await callTool("list_models");
    const data = json();

    expect(data.models[0].prefix).toBe("post");
    expect(Object.keys(data.models[0].schema.properties)).toContain("title");
    expect(data.models[0].schema.properties.internalFlag).toBeUndefined();
    expect(data.vars[0].prefix).toBe("seo");
  });
});

describe("read / get", () => {
  it("passes pagination defaults and filters through to model.read", async () => {
    readCalls.length = 0;
    const { json } = await callTool("read_records", {
      model: "post",
      search: "hel",
      filters: { title: "Hello" },
    });

    expect(json().data).toHaveLength(2);
    expect(readCalls[0]).toMatchObject({
      search: "hel",
      page: 1,
      limit: 20,
      order: "asc",
      filters: { title: "Hello" },
    });
  });

  it("gets a record by id", async () => {
    const { json } = await callTool("get_record", { model: "post", id: "p1" });
    expect(json().title).toBe("Hello");
  });

  it("returns an error result for a missing record", async () => {
    const result = await callTool("get_record", { model: "post", id: "zzz" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("zzz");
  });

  it("lists the available models when the name is unknown", async () => {
    const result = await callTool("get_record", { model: "nope", id: "p1" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Available: post");
  });
});

describe("create / update / delete", () => {
  it("validates and applies schema transforms on create", async () => {
    const { json, isError } = await callTool("create_record", {
      model: "post",
      data: { title: "New", slug: "My New Post" },
    });

    expect(isError).toBe(false);
    expect(json().slug).toBe("my-new-post");
  });

  it("returns a readable validation error instead of throwing", async () => {
    const result = await callTool("create_record", {
      model: "post",
      data: { slug: "x" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Validation failed");
    expect(result.text).toContain("title");
  });

  it("updates only the supplied fields", async () => {
    const { json } = await callTool("update_record", {
      model: "post",
      id: "p1",
      data: { title: "Changed" },
    });

    expect(json().title).toBe("Changed");
  });

  it("deletes a record", async () => {
    records.set("gone", { id: "gone" });
    const { isError } = await callTool("delete_record", {
      model: "post",
      id: "gone",
    });

    expect(isError).toBe(false);
    expect(records.has("gone")).toBe(false);
  });
});

describe("vars", () => {
  it("gets and partially updates a settings group", async () => {
    expect((await callTool("get_vars", { group: "seo" })).json().title).toBe(
      "Default",
    );

    const updated = await callTool("update_vars", {
      group: "seo",
      data: { title: "My Site" },
    });
    expect(updated.json().title).toBe("My Site");
  });

  it("rejects an unknown group", async () => {
    const result = await callTool("get_vars", { group: "nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Available: seo");
  });
});

describe("files", () => {
  it("hands out an upload URL on the request's own origin, tied to the calling token", async () => {
    const { json } = await callTool("create_upload_url");

    expect(json().url).toBe("http://localhost/mcp/upload/up1.secret");
    expect(json().how_to.length).toBeGreaterThan(0);
    expect(ticketCalls[0]).toMatchObject({
      tokenId: "t1",
      base: "http://localhost",
    });
  });

  it("reports what arrived on an upload", async () => {
    const { json } = await callTool("check_upload", { upload_id: "up1" });

    expect(json().files[0].id).toBe("f1");
    expect(json().remaining).toBe(9);
  });

  it("returns an error result for an unknown upload", async () => {
    const result = await callTool("check_upload", { upload_id: "nope" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown upload_id");
  });

  it("lists files newest first by default", async () => {
    fileReadCalls.length = 0;
    const { json } = await callTool("list_files", { search: "logo" });

    expect(json().data[0].name).toBe("logo.png");
    expect(fileReadCalls[0]).toMatchObject({
      search: "logo",
      sort: "createdAt",
      order: "desc",
    });
  });

  it("gets a file, and errors for a missing one", async () => {
    expect((await callTool("get_file", { id: "f1" })).json().name).toBe(
      "logo.png",
    );
    expect((await callTool("get_file", { id: "zzz" })).isError).toBe(true);
  });

  it("deletes a file through the shared remove()", async () => {
    const { isError } = await callTool("delete_file", { id: "f1" });

    expect(isError).toBe(false);
    expect(removed).toEqual(["f1"]);
  });
});

describe("record ids", () => {
  it("sends ids out bare, never as table:id", async () => {
    const { json } = await callTool("get_record", { model: "post", id: "p3" });

    expect(json().id).toBe("p3");
  });

  it("accepts the table:id form on the way in", async () => {
    const { json, isError } = await callTool("get_record", {
      model: "post",
      id: "post:p3",
    });

    expect(isError).toBe(false);
    expect(json().title).toBe("Linked");
  });

  it("accepts file:id for file tools", async () => {
    const { json } = await callTool("get_file", { id: "file:f1" });

    expect(json().name).toBe("logo.png");
  });
});
