import moment from "moment";
import db from "../modules/db";
import elysia from "../modules/elysia";
import sqliteAdapter from "./adapters/sqlite";
import { getConfig, loadConfig, type NjinConfig } from "./config";
import type { DbAdapter, TableDef } from "./db/contract";
import { internalTables, tokenTable } from "./db/internal";
import { hashToken } from "./token_hash";

// Test helper for projects built on njin: boots the real app (every module, your models, hooks,
// events, routes and vars) on an in-memory SQLite database and lets a test call it over HTTP
// without opening a port.
//
//   import { createTestApp } from "@njinlabs/njin/testing";
//   import config from "../config";
//
//   const app = await createTestApp(config);
//   afterAll(() => app.close());
//
//   it("lists posts", async () => {
//     await app.seed(post, { title: "Hello" });
//     const res = await app.get("/api/post", { as: await app.createUser() });
//     expect(res.status).toBe(200);
//   });
//
// njin keeps its modules as process-wide singletons, so one process can hold one test app: run
// the suite with `bun test --isolate` (each test file then gets its own app) or keep one
// createTestApp() per run.

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type TestRequestInit = {
  // Sent as JSON. A FormData / string / Uint8Array body is sent as-is.
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  // Authenticates the request: a user record (an `id` is enough — a session token is minted
  // for it) or a ready-made "token:<id>:<secret>" bearer token.
  as?: { id: string } | string;
};

export type TestApp = {
  request(
    method: Method,
    path: string,
    init?: TestRequestInit,
  ): Promise<Response>;
  get(path: string, init?: Omit<TestRequestInit, "body">): Promise<Response>;
  post(path: string, init?: TestRequestInit): Promise<Response>;
  put(path: string, init?: TestRequestInit): Promise<Response>;
  patch(path: string, init?: TestRequestInit): Promise<Response>;
  delete(path: string, init?: TestRequestInit): Promise<Response>;

  // Creates a record through the model, so validation, transforms and hooks run as in production.
  seed<Model extends { create(data: never): Promise<unknown> }>(
    model: Model,
    data: Parameters<Model["create"]>[0],
  ): Promise<Awaited<ReturnType<Model["create"]>>>;
  // Creates a user (random email, password "password" unless given).
  createUser(
    data?: Partial<{ name: string; email: string; password: string }>,
  ): Promise<{ id: string; name: string; email: string }>;
  // A bearer token for `user`, to put in your own Authorization header.
  tokenFor(user: { id: string }): Promise<string>;

  // Empties every table (the users and sessions too), keeping the schema.
  reset(): Promise<void>;
  // The database the app runs on, for assertions that the HTTP surface can't express.
  db: DbAdapter;
  close(): Promise<void>;
};

let created = false;

export const createTestApp = async (
  config: NjinConfig = {},
): Promise<TestApp> => {
  if (created) {
    throw new Error(
      "createTestApp() was already called in this process — njin's modules are singletons. " +
        "Run the tests with `bun test --isolate` so every test file gets its own app.",
    );
  }
  created = true;
  process.env.NJIN_TEST = "1";

  await loadConfig({
    ...config,
    // Port 0: the server listens on a free port nobody uses; requests go through app.handle().
    port: 0,
    logger: { level: "fatal", console: false, ...config.logger },
    adapters: {
      ...config.adapters,
      db: config.adapters?.db ?? sqliteAdapter({ path: ":memory:" }),
    },
  });

  // Imported only now: config/module.ts initialises every module as it loads, and that has to
  // happen after the test config above is in place.
  const { boot } = await import("./boot");
  await boot();

  const app = elysia();
  const adapter = db();
  const { default: userModel } = await import("../models/user");

  const tokenFor = async (user: { id: string }) => {
    const secret = Bun.randomUUIDv7();
    const token = await adapter.insert(tokenTable, {
      hash: hashToken(secret),
      user: user.id,
      createdAt: moment().toISOString(),
      updatedAt: moment().toISOString(),
    });
    return `token:${token.id}:${secret}`;
  };

  const request: TestApp["request"] = async (method, path, init = {}) => {
    const url = new URL(path, "http://localhost");
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers = new Headers(init.headers);
    if (init.as) {
      const token =
        typeof init.as === "string" ? init.as : await tokenFor(init.as);
      headers.set("authorization", `Bearer ${token}`);
    }

    let body: BodyInit | undefined;
    if (init.body !== undefined) {
      if (
        typeof init.body === "string" ||
        init.body instanceof FormData ||
        init.body instanceof Uint8Array
      ) {
        body = init.body as BodyInit;
      } else {
        body = JSON.stringify(init.body);
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
      }
    }

    return app.handle(new Request(url, { method, headers, body }));
  };

  const allTables = async (): Promise<TableDef[]> => {
    const tables = new Map<string, TableDef>();
    for (const table of internalTables) tables.set(table.name, table);
    tables.set(userModel.def.name, userModel.def);
    for (const factory of getConfig().models) {
      const { default: model } = await factory();
      const m = model as {
        def: TableDef;
        publishedDef?: TableDef;
        i18nDef?: TableDef;
      };
      for (const def of [m.def, m.publishedDef, m.i18nDef]) {
        if (def) tables.set(def.name, def);
      }
    }
    return [...tables.values()];
  };

  let userCount = 0;

  return {
    request,
    get: (path, init) => request("GET", path, init),
    post: (path, init) => request("POST", path, init),
    put: (path, init) => request("PUT", path, init),
    patch: (path, init) => request("PATCH", path, init),
    delete: (path, init) => request("DELETE", path, init),

    seed: ((model: { create(data: never): Promise<unknown> }, data: never) =>
      model.create(data)) as TestApp["seed"],
    createUser: async (data = {}) => {
      userCount += 1;
      const user = (await userModel.create({
        name: `Test User ${userCount}`,
        email: `user${userCount}-${Bun.randomUUIDv7()}@test.local`,
        password: "password",
        ...data,
      } as never)) as { id: string; name: string; email: string };
      return user;
    },
    tokenFor,

    reset: async () => {
      // A table that others still point at can't be emptied first on an adapter that enforces
      // foreign keys, so retry the ones that fail until a pass makes no progress.
      let pending = await allTables();
      while (pending.length > 0) {
        const failed: TableDef[] = [];
        let lastError: unknown;
        for (const table of pending) {
          try {
            await adapter.removeWhere(table, []);
          } catch (error) {
            failed.push(table);
            lastError = error;
          }
        }
        if (failed.length === pending.length) throw lastError;
        pending = failed;
      }
    },
    db: adapter,
    close: async () => {
      await app.stop(true);
      await adapter.close();
    },
  };
};
