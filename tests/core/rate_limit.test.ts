import { describe, expect, it } from "bun:test";
import { rateLimitTable } from "../../src/core/db/internal";
import { useTestDb } from "../helpers/test_db";

const db = await useTestDb();

const { MAX_FAILURES, clearFailures, isLimited, recordFailure } = await import(
  "../../src/core/rate_limit"
);

const fail = async (key: string, times: number) => {
  for (let n = 0; n < times; n++) await recordFailure(key);
};

// The row behind a key: its id is a hash, so find it as the only row of that shape.
const rows = async () =>
  (await db.adapter.list(rateLimitTable, { page: 1, limit: 100, populate: [] }))
    .rows;

describe("rate limit", () => {
  it("lets a key through until it has failed too often", async () => {
    await fail("a", MAX_FAILURES - 1);
    expect(await isLimited("a")).toBe(false);

    await recordFailure("a");
    expect(await isLimited("a")).toBe(true);
  });

  it("counts each key on its own", async () => {
    await fail("b", MAX_FAILURES);

    expect(await isLimited("b")).toBe(true);
    expect(await isLimited("c")).toBe(false);
  });

  it("takes a limit of its own", async () => {
    await fail("d", 2);

    expect(await isLimited("d", 3)).toBe(false);
    expect(await isLimited("d", 2)).toBe(true);
  });

  it("forgets a key when it is cleared", async () => {
    await fail("e", MAX_FAILURES);
    await clearFailures("e");

    expect(await isLimited("e")).toBe(false);
  });

  it("clearing a key nobody failed on is harmless", async () => {
    await clearFailures("never-seen");
    expect(await isLimited("never-seen")).toBe(false);
  });

  it("starts over once the window has passed", async () => {
    await fail("f", MAX_FAILURES);
    expect(await isLimited("f")).toBe(true);

    for (const row of await rows()) {
      await db.adapter.update(rateLimitTable, row.id, {
        resetAt: new Date(Date.now() - 1000).toISOString(),
      });
    }

    expect(await isLimited("f")).toBe(false);

    await recordFailure("f");
    expect(await isLimited("f")).toBe(false);
  });

  it("does not move the end of the window with later failures", async () => {
    await recordFailure("g");
    const first = (await rows()).find((r) => r.count === 1)?.resetAt;

    await recordFailure("g");
    const later = (await rows()).find((r) => r.count === 2)?.resetAt;

    expect(later).toBe(first);
  });

  it("keeps the key itself out of the table", async () => {
    await recordFailure("someone@example.com");

    for (const row of await rows()) {
      expect(JSON.stringify(row)).not.toContain("someone@example.com");
    }
  });
});
