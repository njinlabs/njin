import { describe, expect, it, mock } from "bun:test";
import { createNodeEngines } from "@surrealdb/node";
import { RecordId, Surreal } from "surrealdb";
import * as realElysiaModule from "../../src/modules/elysia";
import * as realSurrealModule from "../../src/modules/surreal";
import { makeFakeElysia } from "../helpers/fake_elysia";

const db = new Surreal({ engines: createNodeEngines() });
await db.connect("mem://");
await db.use({ namespace: "test", database: "test" });
await db.query("DEFINE TABLE IF NOT EXISTS mcp_upload SCHEMALESS;");

mock.module("../../src/modules/surreal", () => ({
  ...realSurrealModule,
  default: () => db,
}));

const stored = new Map<string, Record<string, unknown>>();
const uploaded: File[] = [];

// Stands in for modules/file.ts — the real one writes through a storage adapter. The fake
// records exactly what it was handed, which is what matters here (name, normalized type).
mock.module("../../src/modules/file", () => ({
  default: () => ({
    model: {
      show: async (id: string) => stored.get(id) ?? null,
    },
    upload: async (file: File) => {
      uploaded.push(file);
      const id = new RecordId("file", `f${stored.size + 1}`);
      const record = {
        id,
        name: file.name,
        url: `/uploads/${file.name}`,
        type: file.type,
        size: file.size,
      };
      stored.set(id.id.toString(), record);
      return [record];
    },
    remove: async () => ({}),
  }),
}));

const fakeElysia = makeFakeElysia();
mock.module("../../src/modules/elysia", () => ({
  ...realElysiaModule,
  default: fakeElysia.fn,
}));

const {
  default: mcpUpload,
  createUploadTicket,
  getUploadStatus,
} = await import("../../src/modules/mcp_upload");

await mcpUpload.init();
const app = fakeElysia.buildApp();

const newTicket = () =>
  createUploadTicket({
    tokenId: "tok1",
    userId: "admin1",
    base: "https://site.example",
  });

const path = (url: string) => new URL(url).pathname;

const post = (
  url: string,
  files: [string, BlobPart, string?][],
  headers: Record<string, string> = {},
) => {
  const body = new FormData();
  for (const [name, content, type] of files) {
    body.append("file", new File([content], name, { type: type ?? "" }));
  }

  return app.handle(
    new Request(`http://localhost${path(url)}`, {
      method: "POST",
      body,
      headers,
    }),
  );
};

describe("createUploadTicket", () => {
  it("returns a URL on the public base plus the limits an agent needs", async () => {
    const ticket = await newTicket();

    expect(ticket.url).toMatch(
      /^https:\/\/site\.example\/mcp\/upload\/[^./]+\.[\w-]+$/,
    );
    expect(ticket.upload_id).toBeTruthy();
    expect(ticket.max_files).toBe(10);
    expect(ticket.max_file_bytes).toBe(10 * 1024 * 1024);
    expect(ticket.allowed_extensions).toContain("png");
    expect(ticket.allowed_extensions).not.toContain("html");
    expect(ticket.allowed_extensions).not.toContain("svg");
  });

  it("never stores the secret", async () => {
    const ticket = await newTicket();
    const secret = ticket.url.split(".").pop()!;
    const record = await db.select(
      new RecordId("mcp_upload", ticket.upload_id),
    );

    expect(JSON.stringify(record)).not.toContain(secret);
  });
});

describe("GET /mcp/upload/:ticket", () => {
  it("shows a drop page for a valid link", async () => {
    const ticket = await newTicket();
    const res = await app.handle(
      new Request(`http://localhost${path(ticket.url)}`),
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('type="file"');
    expect(html).toContain("multiple");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("answers 404 for a wrong secret", async () => {
    const ticket = await newTicket();
    const bad = `${path(ticket.url).split(".")[0]}.not-the-secret`;
    const res = await app.handle(new Request(`http://localhost${bad}`));

    expect(res.status).toBe(404);
  });

  it("answers 404 for a garbage ticket", async () => {
    for (const bad of ["nodot", ".", "a.", ".b"]) {
      const res = await app.handle(
        new Request(`http://localhost/mcp/upload/${bad}`),
      );
      expect(res.status).toBe(404);
    }
  });
});

describe("POST /mcp/upload/:ticket", () => {
  it("accepts a file from curl and answers with JSON", async () => {
    const ticket = await newTicket();
    const res = await post(ticket.url, [["photo.png", "pngbytes"]]);
    const body = (await res.json()) as { data: Record<string, unknown>[] };

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.name).toBe("photo.png");
    expect(body.data[0]!.id).toBeTruthy();
  });

  it("answers a browser form post with an HTML page", async () => {
    const ticket = await newTicket();
    const res = await post(ticket.url, [["a.pdf", "pdf"]], {
      Accept: "text/html,application/xhtml+xml",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("a.pdf");
  });

  it("replaces the client-declared MIME type with the one for the extension", async () => {
    const ticket = await newTicket();
    uploaded.length = 0;
    await post(ticket.url, [["logo.png", "x", "text/html"]]);

    expect(uploaded[0]!.type).toBe("image/png");
  });

  it("takes several files in one request and counts them against the ticket", async () => {
    const ticket = await newTicket();
    await post(ticket.url, [
      ["a.png", "1"],
      ["b.jpg", "2"],
      ["c.pdf", "3"],
    ]);

    const status = await getUploadStatus(ticket.upload_id);
    expect(status!.files.map((f) => f.name)).toEqual([
      "a.png",
      "b.jpg",
      "c.pdf",
    ]);
    expect(status!.remaining).toBe(7);
    expect(status!.expired).toBe(false);
  });

  it("stops accepting once the ticket's file allowance is used up", async () => {
    const ticket = await newTicket();
    const many = Array.from({ length: 10 }, (_, i) => [`f${i}.png`, "x"]) as [
      string,
      string,
    ][];

    expect((await post(ticket.url, many)).status).toBe(200);
    expect((await post(ticket.url, [["one-more.png", "x"]])).status).toBe(404);
  });

  it("rejects more files than the ticket has left", async () => {
    const ticket = await newTicket();
    const eleven = Array.from({ length: 11 }, (_, i) => [`f${i}.png`, "x"]) as [
      string,
      string,
    ][];

    expect((await post(ticket.url, eleven)).status).toBe(400);
  });

  for (const name of [
    "page.html",
    "logo.svg",
    "x.js",
    "noextension",
    "a.exe",
  ]) {
    it(`rejects ${name}`, async () => {
      const ticket = await newTicket();
      const res = await post(ticket.url, [[name, "x"]]);

      expect(res.status).toBe(415);
    });
  }

  it("matches the extension case-insensitively", async () => {
    const ticket = await newTicket();
    expect((await post(ticket.url, [["PHOTO.PNG", "x"]])).status).toBe(200);
    expect((await post(ticket.url, [["PAGE.HTML", "x"]])).status).toBe(415);
  });

  it("rejects an empty file and an oversized one", async () => {
    const ticket = await newTicket();

    expect((await post(ticket.url, [["empty.png", ""]])).status).toBe(413);

    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    expect((await post(ticket.url, [["big.png", big]])).status).toBe(413);
  });

  it("writes nothing when one file in the batch is bad", async () => {
    const ticket = await newTicket();
    uploaded.length = 0;

    const res = await post(ticket.url, [
      ["fine.png", "x"],
      ["bad.html", "x"],
    ]);

    expect(res.status).toBe(415);
    expect(uploaded).toHaveLength(0);
    expect((await getUploadStatus(ticket.upload_id))!.remaining).toBe(10);
  });

  it("rejects a request with no file field", async () => {
    const ticket = await newTicket();
    const res = await app.handle(
      new Request(`http://localhost${path(ticket.url)}`, {
        method: "POST",
        body: new FormData(),
      }),
    );

    expect(res.status).toBe(400);
  });

  it("rejects a non-multipart body", async () => {
    const ticket = await newTicket();
    const res = await app.handle(
      new Request(`http://localhost${path(ticket.url)}`, {
        method: "POST",
        body: "plain text",
      }),
    );

    expect(res.status).toBe(400);
  });

  it("answers 404 for a wrong secret", async () => {
    const ticket = await newTicket();
    const bad = `${ticket.url.split(".")[0]}.wrong`;

    expect((await post(bad, [["a.png", "x"]])).status).toBe(404);
  });

  it("answers 404 once the ticket has expired", async () => {
    const ticket = await newTicket();
    await db
      .update(new RecordId("mcp_upload", ticket.upload_id))
      .merge({ expiresAt: "2000-01-01T00:00:00.000Z" });

    expect((await post(ticket.url, [["a.png", "x"]])).status).toBe(404);
    expect((await getUploadStatus(ticket.upload_id))!.expired).toBe(true);
  });
});

describe("getUploadStatus", () => {
  it("returns null for an unknown ticket", async () => {
    expect(await getUploadStatus("nope")).toBeNull();
  });
});

describe("pruning", () => {
  it("removes tickets that expired more than an hour ago", async () => {
    const old = await newTicket();
    await db
      .update(new RecordId("mcp_upload", old.upload_id))
      .merge({ expiresAt: "2000-01-01T00:00:00.000Z" });

    await newTicket();

    expect(await getUploadStatus(old.upload_id)).toBeNull();
  });
});
