import type { AnyElysia } from "elysia";
import logger from "../modules/logger";

// This project's tsconfig only loads lib "DOM" (not "DOM.Iterable"/webworker), which ships no
// DedicatedWorkerGlobalScope type. Bun's own docs recommend this exact local override — reusing
// the DOM `Worker` interface's shape (postMessage/onmessage) as a stand-in for the worker-side
// global, since both expose the same members. Scoped to this module only (not global) because
// this file has imports/exports.
declare var self: Worker;

// Wire protocol between a supervisor thread (`new Worker("out/worker.js")`, spawned/terminated
// on its own schedule) and this headless njin instance running inside that worker. The
// supervisor owns request routing/load-balancing — this module only speaks the message shapes
// below over `self.postMessage`/`self.onmessage`.
export type WorkerRequestMessage = {
  type: "request";
  id: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
};

export type WorkerShutdownMessage = {
  type: "shutdown";
};

export type WorkerInboundMessage = WorkerRequestMessage | WorkerShutdownMessage;

export type WorkerResponseMessage = {
  type: "response";
  id: string;
  status: number;
  headers: [string, string][];
  body: ArrayBuffer | null;
};

export type WorkerErrorMessage = {
  type: "error";
  id: string;
  message: string;
};

export type WorkerReadyMessage = {
  type: "ready";
};

export type WorkerOutboundMessage = WorkerResponseMessage | WorkerErrorMessage | WorkerReadyMessage;

// Bounds how long shutdown waits for in-flight requests to finish before exiting anyway —
// the supervisor can terminate a worker at any time, so this is a safety net, not the
// expected path.
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const SHUTDOWN_POLL_INTERVAL_MS = 50;

const isRequestMessage = (raw: unknown): raw is WorkerRequestMessage =>
  typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "request";

const isShutdownMessage = (raw: unknown): raw is WorkerShutdownMessage =>
  typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "shutdown";

// Pure request/response conversion, split out from serveWorker()'s self/postMessage wiring
// so it can be unit tested directly without spinning up a real Worker thread.
export const buildResponseMessage = async (app: AnyElysia, msg: WorkerRequestMessage): Promise<WorkerResponseMessage> => {
  const request = new Request(msg.url, {
    method: msg.method,
    headers: msg.headers,
    body: msg.body ?? undefined,
  });

  const response = await app.handle(request);
  const body = await response.arrayBuffer();

  // lib.dom (without lib.dom.iterable) doesn't type Headers as iterable, so build the
  // array via forEach rather than a for...of/spread over response.headers directly.
  const headers: [string, string][] = [];
  response.headers.forEach((value, key) => headers.push([key, value]));

  return {
    type: "response",
    id: msg.id,
    status: response.status,
    headers,
    body: body.byteLength > 0 ? body : null,
  };
};

// Worker-mode replacement for `app.listen()` — wired in by elysia.ts's spin() when
// NJIN_WORKER=1. Requests arrive as postMessage()s from the supervisor thread instead of
// real socket connections; app.handle() is the same Elysia entrypoint either way.
export const serveWorker = (app: AnyElysia): void => {
  if (Bun.isMainThread) {
    throw new Error('serveWorker() must run inside a Worker thread (new Worker("out/worker.js")), not the main thread.');
  }

  let inFlight = 0;
  let shuttingDown = false;

  const handleRequest = async (msg: WorkerRequestMessage): Promise<void> => {
    if (shuttingDown) {
      self.postMessage({ type: "error", id: msg.id, message: "worker is shutting down" } satisfies WorkerErrorMessage);
      return;
    }

    inFlight++;
    try {
      self.postMessage(await buildResponseMessage(app, msg));
    } catch (error) {
      logger().error(error);
      self.postMessage({
        type: "error",
        id: msg.id,
        message: error instanceof Error ? error.message : "Unknown error",
      } satisfies WorkerErrorMessage);
    } finally {
      inFlight--;
    }
  };

  // No OS signal equivalent per-thread — the supervisor asks for a graceful shutdown by
  // posting { type: "shutdown" } instead of sending SIGTERM/SIGINT to a whole process.
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    const start = Date.now();
    const poll = setInterval(() => {
      if (inFlight === 0 || Date.now() - start > SHUTDOWN_DRAIN_TIMEOUT_MS) {
        clearInterval(poll);
        // Scoped to this worker thread only — confirmed in Bun's own docs — the supervisor's
        // main thread and any sibling workers keep running.
        process.exit(0);
      }
    }, SHUTDOWN_POLL_INTERVAL_MS);
  };

  self.onmessage = (event: MessageEvent<unknown>) => {
    const raw = event.data;
    if (isRequestMessage(raw)) {
      void handleRequest(raw);
    } else if (isShutdownMessage(raw)) {
      shutdown();
    }
  };

  self.postMessage({ type: "ready" } satisfies WorkerReadyMessage);
};
