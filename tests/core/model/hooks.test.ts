import { describe, expect, it } from "bun:test";
import {
  afterCreate,
  afterDestroy,
  afterUpdate,
  afterVarsUpdate,
  beforeCreate,
  beforeDestroy,
  beforeUpdate,
  beforeVarsUpdate,
  runAfterHooks,
  runBeforeDestroyHooks,
  runBeforeHooks,
} from "../../../src/core/model/hooks";

// Minimal dummy models satisfying the structural AnyModel shape hooks.ts relies on —
// prefix is randomized per test so registrations from different tests never collide.
const dummyModel = (prefix: string) => ({
  prefix,
  create: async (data: Record<string, unknown>) => data,
  update: async (id: string, data: Record<string, unknown>) => data,
  destroy: async (id: string) => ({ id }),
});

// Minimal dummy vars group satisfying the structural AnyVars shape — update() takes
// a single argument (no id), unlike a model's update(id, data).
const dummyVars = (prefix: string) => ({
  prefix,
  update: async (data: Record<string, unknown>) => data,
});

describe("hooks", () => {
  it("dispatches afterCreate with the created record", async () => {
    const model = dummyModel(`post-${crypto.randomUUID()}`);
    let received: unknown;
    afterCreate(model, (record) => {
      received = record;
    });

    await runAfterHooks("afterCreate", model.prefix, { id: "1", title: "hello" });

    expect(received).toEqual({ id: "1", title: "hello" });
  });

  it("dispatches afterUpdate and afterDestroy with the record", async () => {
    const model = dummyModel(`post-${crypto.randomUUID()}`);
    const seen: unknown[] = [];
    afterUpdate(model, (record) => void seen.push(["update", record]));
    afterDestroy(model, (record) => void seen.push(["destroy", record]));

    await runAfterHooks("afterUpdate", model.prefix, { id: "1" });
    await runAfterHooks("afterDestroy", model.prefix, { id: "1" });

    expect(seen).toEqual([
      ["update", { id: "1" }],
      ["destroy", { id: "1" }],
    ]);
  });

  it("merges beforeCreate return value into the data passed to the next handler and the final result", async () => {
    const model = dummyModel(`post-${crypto.randomUUID()}`);
    const seenByFirst: unknown[] = [];
    const seenBySecond: unknown[] = [];

    beforeCreate(model, (data) => {
      seenByFirst.push({ ...data });
      return { slug: "auto-slug" };
    });
    beforeCreate(model, (data) => {
      seenBySecond.push({ ...data });
    });

    const result = await runBeforeHooks<Record<string, unknown>>("beforeCreate", model.prefix, { title: "Hello" }, {});

    expect(seenByFirst).toEqual([{ title: "Hello" }]);
    expect(seenBySecond).toEqual([{ title: "Hello", slug: "auto-slug" }]);
    expect(result).toEqual({ title: "Hello", slug: "auto-slug" });
  });

  it("passes the id context to beforeUpdate handlers", async () => {
    const model = dummyModel(`post-${crypto.randomUUID()}`);
    let receivedContext: unknown;

    beforeUpdate(model, (_data, context) => {
      receivedContext = context;
    });

    await runBeforeHooks("beforeUpdate", model.prefix, { title: "Hello" }, { id: "42" });

    expect(receivedContext).toEqual({ id: "42" });
  });

  it("runs beforeDestroy handlers with the id being destroyed", async () => {
    const model = dummyModel(`post-${crypto.randomUUID()}`);
    let receivedId: unknown;

    beforeDestroy(model, (id) => {
      receivedId = id;
    });

    await runBeforeDestroyHooks(model.prefix, "42");

    expect(receivedId).toBe("42");
  });

  it("propagates errors thrown by an afterCreate handler", async () => {
    const model = dummyModel(`post-${crypto.randomUUID()}`);
    afterCreate(model, () => {
      throw new Error("boom");
    });

    await expect(runAfterHooks("afterCreate", model.prefix, { id: "1" })).rejects.toThrow("boom");
  });

  it("propagates errors thrown by a beforeCreate handler", async () => {
    const model = dummyModel(`post-${crypto.randomUUID()}`);
    beforeCreate(model, () => {
      throw new Error("validation failed");
    });

    await expect(runBeforeHooks("beforeCreate", model.prefix, { title: "x" }, {})).rejects.toThrow(
      "validation failed",
    );
  });

  it("does not call hooks registered for a different model's prefix", async () => {
    const modelA = dummyModel(`post-${crypto.randomUUID()}`);
    const modelB = dummyModel(`post-${crypto.randomUUID()}`);
    let calledForB = false;

    afterCreate(modelB, () => {
      calledForB = true;
    });

    await runAfterHooks("afterCreate", modelA.prefix, { id: "1" });

    expect(calledForB).toBe(false);
  });

  it("runs handlers sequentially in registration order", async () => {
    const model = dummyModel(`post-${crypto.randomUUID()}`);
    const order: number[] = [];

    afterCreate(model, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(1);
    });
    afterCreate(model, async () => {
      order.push(2);
    });

    await runAfterHooks("afterCreate", model.prefix, { id: "1" });

    expect(order).toEqual([1, 2]);
  });

  it("returns data unchanged when no beforeCreate hooks are registered", async () => {
    const model = dummyModel(`post-${crypto.randomUUID()}`);
    const data = { title: "Hello" };

    const result = await runBeforeHooks("beforeCreate", model.prefix, data, {});

    expect(result).toEqual(data);
  });

  it("dispatches afterVarsUpdate with the updated record", async () => {
    const vars = dummyVars(`general-${crypto.randomUUID()}`);
    let received: unknown;
    afterVarsUpdate(vars, (record) => {
      received = record;
    });

    await runAfterHooks("afterVarsUpdate", vars.prefix, { siteName: "My Site" });

    expect(received).toEqual({ siteName: "My Site" });
  });

  it("merges beforeVarsUpdate return value into the data passed to the next handler and the final result", async () => {
    const vars = dummyVars(`general-${crypto.randomUUID()}`);
    const seenByFirst: unknown[] = [];
    const seenBySecond: unknown[] = [];

    beforeVarsUpdate(vars, (data) => {
      seenByFirst.push({ ...data });
      return { normalized: true };
    });
    beforeVarsUpdate(vars, (data) => {
      seenBySecond.push({ ...data });
    });

    const result = await runBeforeHooks<Record<string, unknown>>(
      "beforeVarsUpdate",
      vars.prefix,
      { siteName: "My Site" },
      {},
    );

    expect(seenByFirst).toEqual([{ siteName: "My Site" }]);
    expect(seenBySecond).toEqual([{ siteName: "My Site", normalized: true }]);
    expect(result).toEqual({ siteName: "My Site", normalized: true });
  });

  it("propagates errors thrown by a beforeVarsUpdate handler", async () => {
    const vars = dummyVars(`general-${crypto.randomUUID()}`);
    beforeVarsUpdate(vars, () => {
      throw new Error("invalid vars data");
    });

    await expect(
      runBeforeHooks("beforeVarsUpdate", vars.prefix, { siteName: "x" }, {}),
    ).rejects.toThrow("invalid vars data");
  });

  it("does not call beforeUpdate/afterUpdate handlers registered for a model when a vars group with the same prefix updates", async () => {
    const sharedPrefix = `general-${crypto.randomUUID()}`;
    const model = dummyModel(sharedPrefix);
    const vars = dummyVars(sharedPrefix);
    let modelHookCalled = false;

    afterUpdate(model, () => {
      modelHookCalled = true;
    });

    await runAfterHooks("afterVarsUpdate", vars.prefix, { siteName: "My Site" });

    expect(modelHookCalled).toBe(false);
  });
});
