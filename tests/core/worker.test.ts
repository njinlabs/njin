import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { AnyElysia } from "elysia";
import { buildResponseMessage, type WorkerErrorMessage, type WorkerOutboundMessage, type WorkerRequestMessage, type WorkerResponseMessage } from "../../src/core/worker";

const makeFakeApp = (handle: (request: Request) => Promise<Response> | Response): AnyElysia => ({ handle }) as unknown as AnyElysia;

describe("buildResponseMessage", () => {
  it("round-trips a request message through app.handle() into a response message", async () => {
    const app = makeFakeApp((request) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe("http://x/api/ping");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const msg: WorkerRequestMessage = { type: "request", id: "1", method: "GET", url: "http://x/api/ping", headers: [], body: null };
    const response = await buildResponseMessage(app, msg);

    expect(response.type).toBe("response");
    expect(response.id).toBe("1");
    expect(response.status).toBe(200);
    expect(Buffer.from(response.body as ArrayBuffer).toString()).toBe(JSON.stringify({ ok: true }));
  });

  it("passes an ArrayBuffer request body straight onto the reconstructed Request", async () => {
    const app = makeFakeApp(async (request) => {
      const text = await request.text();
      return new Response(text.toUpperCase());
    });

    const msg: WorkerRequestMessage = {
      type: "request",
      id: "2",
      method: "POST",
      url: "http://x/api/echo",
      headers: [["content-type", "text/plain"]],
      body: new TextEncoder().encode("hi").buffer as ArrayBuffer,
    };
    const response = await buildResponseMessage(app, msg);

    expect(Buffer.from(response.body as ArrayBuffer).toString()).toBe("HI");
  });

  it("returns a null body for empty responses", async () => {
    const app = makeFakeApp(() => new Response(null, { status: 204 }));
    const msg: WorkerRequestMessage = { type: "request", id: "3", method: "GET", url: "http://x/api/empty", headers: [], body: null };
    const response = await buildResponseMessage(app, msg);

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});

// serveWorker() itself can only be exercised inside a real Worker thread — it guards on
// Bun.isMainThread (read-only, can't be faked in-process) and talks over self.postMessage/
// onmessage rather than anything mockable from the test's own thread. tests/core/fixtures/
// worker_fixture.ts boots a real worker around a fake app; this drives it end to end exactly
// as a supervisor would.
describe("serveWorker (real Worker thread)", () => {
  const fixturePath = join(import.meta.dir, "fixtures/worker_fixture.ts");

  it("boots, answers a request over postMessage, and shuts down cleanly on 'shutdown'", async () => {
    const worker = new Worker(fixturePath);

    try {
      const ready = new Promise<void>((resolve) => {
        worker.onmessage = (event) => {
          const msg = event.data as WorkerOutboundMessage;
          if (msg.type === "ready") resolve();
        };
      });
      await ready;

      const response = await new Promise<WorkerResponseMessage>((resolve) => {
        worker.onmessage = (event) => {
          const msg = event.data as WorkerOutboundMessage;
          if (msg.type === "response") resolve(msg);
        };
        worker.postMessage({ type: "request", id: "smoke-1", method: "GET", url: "http://x/ping", headers: [], body: null });
      });

      expect(response.status).toBe(200);
      expect(Buffer.from(response.body as ArrayBuffer).toString()).toBe("pong");

      const closed = new Promise<void>((resolve) => {
        worker.addEventListener("close", () => resolve());
      });
      worker.postMessage({ type: "shutdown" });
      await closed;
    } finally {
      worker.terminate();
    }
  }, 10_000);

  it("replies with an error message instead of a response once shutting down", async () => {
    const worker = new Worker(fixturePath);

    try {
      const ready = new Promise<void>((resolve) => {
        worker.onmessage = (event) => {
          const msg = event.data as WorkerOutboundMessage;
          if (msg.type === "ready") resolve();
        };
      });
      await ready;

      const closed = new Promise<void>((resolve) => {
        worker.addEventListener("close", () => resolve());
      });

      const rejected = new Promise<WorkerErrorMessage>((resolve) => {
        worker.onmessage = (event) => {
          const msg = event.data as WorkerOutboundMessage;
          if (msg.type === "error") resolve(msg);
        };
      });

      worker.postMessage({ type: "shutdown" });
      worker.postMessage({ type: "request", id: "late-1", method: "GET", url: "http://x/ping", headers: [], body: null });

      const errorMsg = await rejected;
      expect(errorMsg.id).toBe("late-1");
      expect(errorMsg.message).toContain("shutting down");

      await closed;
    } finally {
      worker.terminate();
    }
  }, 10_000);
});
