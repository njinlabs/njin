import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordId } from "surrealdb";
import * as realConfig from "../../src/core/config";
import * as realElysiaModule from "../../src/modules/elysia";
import * as realSurrealModule from "../../src/modules/surreal";
import { makeFakeAuthPlugin } from "../helpers/fake_auth";
import { makeFakeElysia } from "../helpers/fake_elysia";

// file.ts resolves its static uploads dir as `resolve(getConfig().rootDir, adapters.file.dir)`
// — `dir` here is relative, so the mocked getConfig() below points rootDir at this temp root.
const projectRoot = mkdtempSync(join(tmpdir(), "njin-file-uploads-"));
mkdirSync(join(projectRoot, "uploads"));
writeFileSync(join(projectRoot, "uploads", "existing.txt"), "already here");

const deleteCalls: unknown[] = [];
const createCalls: unknown[] = [];
const writeCalls: unknown[] = [];
const unlinkCalls: unknown[] = [];

const fakeDb = {
  read: async () => ({ data: [], meta: { total: 0, page: 1, limit: 20, pageCount: 0 } }),
  delete: async (id: unknown) => {
    deleteCalls.push(id);
    return { id, name: "deleted.txt" };
  },
  create: (_table: unknown) => ({
    content: async (data: Record<string, unknown>) => {
      createCalls.push(data);
      return { ...data, id: new RecordId("file", "f1") };
    },
  }),
};

// Spreading each real module's other exports below — without --isolate, mock.module()
// replaces the module in a registry shared across the whole test run, so a partial
// mock would otherwise break other files importing the un-mocked exports from these
// same specifiers (isRemotePath, loadConfig, injectBracketQuery).
mock.module("../../src/modules/surreal", () => ({ ...realSurrealModule, default: () => fakeDb }));

mock.module("../../src/models/file", () => ({
  default: { read: fakeDb.read, table: "file" },
}));

mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({
    rootDir: projectRoot,
    adapters: {
      file: {
        dir: "uploads",
        write: async (file: File) => {
          writeCalls.push(file);
          return { name: file.name, size: file.size, type: file.type, meta: null, url: `/uploads/${file.name}` };
        },
        unlink: async (data: unknown) => {
          unlinkCalls.push(data);
        },
      },
    },
  }),
}));

const fakeAuthPlugin = makeFakeAuthPlugin();
mock.module("../../src/modules/auth", () => ({ default: async () => ({ plugin: fakeAuthPlugin }) }));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({ ...realElysiaModule, default: fakeElysia.fn }));

const { default: file } = await import("../../src/modules/file");

await file.init();
const app = fakeElysia.buildApp();

describe("GET /api/file", () => {
  it("lists files", async () => {
    const res = await app.handle(new Request("http://localhost/api/file", { headers: { Authorization: "Bearer x" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], meta: { total: 0, page: 1, limit: 20, pageCount: 0 } });
  });
});

describe("DELETE /api/file/:id", () => {
  it("deletes the record and unlinks the underlying file via the adapter", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/file/f1", { method: "DELETE", headers: { Authorization: "Bearer x" } }),
    );
    expect(res.status).toBe(200);
    expect(deleteCalls).toHaveLength(1);
    expect(unlinkCalls).toHaveLength(1);
  });
});

describe("POST /api/file", () => {
  it("writes the upload via the adapter then creates the record", async () => {
    const form = new FormData();
    form.set("file", new File(["hello"], "upload.txt", { type: "text/plain" }));

    const res = await app.handle(
      new Request("http://localhost/api/file", { method: "POST", headers: { Authorization: "Bearer x" }, body: form }),
    );

    expect(res.status).toBe(200);
    expect(writeCalls).toHaveLength(1);
    expect(createCalls).toHaveLength(1);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.name).toBe("upload.txt");
  });
});

describe("GET /uploads/*", () => {
  it("serves an existing uploaded file", async () => {
    const res = await app.handle(new Request("http://localhost/uploads/existing.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("already here");
  });

  it("returns 404 for a file that doesn't exist", async () => {
    const res = await app.handle(new Request("http://localhost/uploads/nope.txt"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for a path-traversal attempt", async () => {
    const res = await app.handle(new Request("http://localhost/uploads/..%2f..%2fetc%2fpasswd"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the wildcard segment fails to decode", async () => {
    const res = await app.handle(new Request("http://localhost/uploads/%E0%A4%A"));
    expect(res.status).toBe(404);
  });
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});
