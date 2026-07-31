import { describe, expect, it, mock } from "bun:test";

// dispatch() calls logger().error(...) when a listener throws — logger is a makeModule
// singleton that only becomes callable after logger.init() runs (done once at boot in
// src/config/module.ts), which never happens in these plain unit tests, so replace it
// with a no-op fake, same pattern as tests/core/model/index.test.ts fakes ../modules/surreal.
const loggedErrors: unknown[] = [];
mock.module("../../src/modules/logger", () => ({
  default: () => ({
    error: (err: unknown, msg: string) => {
      loggedErrors.push({ err, msg });
    },
  }),
}));

const { makeEvent } = await import("../../src/core/event");

describe("event bus", () => {
  it("delivers the payload to a listener", async () => {
    const event = makeEvent<{ message: string }>();
    let received: unknown;

    event.listen((payload) => {
      received = payload;
    });

    await event.dispatch({ message: "hello" });

    expect(received).toEqual({ message: "hello" });
  });

  it("runs multiple listeners on the same instance in registration order", async () => {
    const event = makeEvent<void>();
    const order: number[] = [];

    event.listen(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(1);
    });
    event.listen(async () => {
      order.push(2);
    });

    await event.dispatch();

    expect(order).toEqual([1, 2]);
  });

  it("does not call listeners registered on a different makeEvent() instance", async () => {
    const eventA = makeEvent<void>();
    const eventB = makeEvent<void>();
    let calledForB = false;

    eventB.listen(() => {
      calledForB = true;
    });

    await eventA.dispatch();

    expect(calledForB).toBe(false);
  });

  it("isolates a throwing listener — other listeners still run and dispatch() does not reject", async () => {
    const event = makeEvent<void>();
    const seen: string[] = [];

    event.listen(() => {
      throw new Error("boom");
    });
    event.listen(() => {
      seen.push("second");
    });

    await expect(event.dispatch()).resolves.toBeUndefined();
    expect(seen).toEqual(["second"]);
  });

  it("is a no-op when dispatching to an instance with no listeners", async () => {
    const event = makeEvent<{ anything: boolean }>();

    await expect(event.dispatch({ anything: true })).resolves.toBeUndefined();
  });
});
