import type { AnyElysia } from "elysia";
import { serveWorker } from "../../../src/core/worker";

// Minimal fake app — serveWorker()/buildResponseMessage() only ever call app.handle(),
// so a real Elysia instance isn't needed here.
const app = {
  handle: async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/echo") {
      const text = await request.text();
      return new Response(text.toUpperCase());
    }
    return new Response("pong", { status: 200 });
  },
} as unknown as AnyElysia;

serveWorker(app);
