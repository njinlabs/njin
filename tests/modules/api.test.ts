import { describe, expect, it, mock } from "bun:test";
import Elysia from "elysia";
import z from "zod";
import * as realConfig from "../../src/core/config";
import * as realElysiaModule from "../../src/modules/elysia";
import { makeFakeAuthPlugin } from "../helpers/fake_auth";
import { makeFakeElysia } from "../helpers/fake_elysia";

const hookCalls: string[] = [];
const eventCalls: string[] = [];

const records = new Map<string, Record<string, unknown>>();
records.set("p1", { id: "p1", title: "Hello" });

const fakeModel = {
  name: "Post",
  prefix: "post",
  validation: z.object({
    title: z.string(),
    owner: z.string().meta({ renderAs: "relation" }).optional(),
    tags: z.array(z.string()).meta({ renderAs: "multi_relation" }).optional(),
    cover: z.string().meta({ renderAs: "file" }).optional(),
  }),
  read: async (opts: Record<string, unknown>) => ({ data: Array.from(records.values()), opts }),
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

const fakeVarsGroup = {
  name: "SEO",
  prefix: "seo",
  validation: z.object({ title: z.string() }),
};

let customRouteMounted = false;

// Spreading each real module's other exports below — without --isolate, mock.module()
// replaces the module in a registry shared across every test file in the run, so a
// partial mock would otherwise break other files that import the un-mocked exports
// from these same specifiers (e.g. loadConfig from core/config, injectBracketQuery
// from modules/elysia).
mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({
    models: [async () => ({ default: fakeModel })],
    vars: [async () => ({ default: fakeVarsGroup })],
    hooks: [async () => { hookCalls.push("hook1"); }],
    events: [async () => { eventCalls.push("event1"); }],
    routes: [
      async () => {
        customRouteMounted = true;
        return { default: new Elysia().get("/custom", () => "custom-ok") };
      },
    ],
  }),
}));

const fakeAuthPlugin = makeFakeAuthPlugin();
mock.module("../../src/modules/auth", () => ({ default: async () => ({ plugin: fakeAuthPlugin }) }));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({ ...realElysiaModule, default: fakeElysia.fn }));

const { default: api } = await import("../../src/modules/api");

await api.init();
const app = fakeElysia.buildApp();

describe("api.init() wiring", () => {
  it("drains every hook and event factory before mounting routes", () => {
    expect(hookCalls).toEqual(["hook1"]);
    expect(eventCalls).toEqual(["event1"]);
  });

  it("mounts custom route factories", async () => {
    expect(customRouteMounted).toBe(true);
    const res = await app.handle(new Request("http://localhost/custom"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("custom-ok");
  });
});

describe("GET /api/schema", () => {
  it("returns admin-friendly JSON schema for models and vars, remapping relation/file types", async () => {
    const res = await app.handle(new Request("http://localhost/api/schema", { headers: { Authorization: "Bearer x" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { name: string; prefix: string; schema: Record<string, unknown> }[];
      vars: { name: string; prefix: string; schema: Record<string, unknown> }[];
    };

    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.prefix).toBe("post");
    const props = (body.data[0]!.schema as { properties: Record<string, { type?: string; properties?: unknown }> }).properties;
    expect(props.owner!.type).toBe("object");
    expect((props.owner as { required?: string[] }).required).toEqual(["id"]);
    expect(props.cover!.type).toBe("string");

    expect(body.vars).toHaveLength(1);
    expect(body.vars[0]!.prefix).toBe("seo");
  });
});

describe("model CRUD routes", () => {
  it("GET /api/post lists records and parses populate=none", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post?populate=none", { headers: { Authorization: "Bearer x" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { opts: { populate: unknown } };
    expect(body.opts.populate).toBe("none");
  });

  it("GET /api/post parses a comma-separated populate list", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post?populate=owner,tags", { headers: { Authorization: "Bearer x" } }),
    );
    const body = (await res.json()) as { opts: { populate: unknown } };
    expect(body.opts.populate).toEqual(["owner", "tags"]);
  });

  it("GET /api/post/:id shows a single record", async () => {
    const res = await app.handle(new Request("http://localhost/api/post/p1", { headers: { Authorization: "Bearer x" } }));
    expect(await res.json()).toEqual({ data: { id: "p1", title: "Hello" } });
  });

  it("POST /api/post creates a record", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post", {
        method: "POST",
        headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Post" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.title).toBe("New Post");
  });

  it("PUT /api/post/:id updates a record", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post/p1", {
        method: "PUT",
        headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Updated" }),
      }),
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.title).toBe("Updated");
  });

  it("DELETE /api/post/:id destroys a record", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/post/p1", { method: "DELETE", headers: { Authorization: "Bearer x" } }),
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.id).toBe("p1");
  });
});
