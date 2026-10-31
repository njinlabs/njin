import moment from "moment";
import db from "../modules/db";
import { rateLimitTable } from "./db/internal";
import { hashToken } from "./token_hash";

// Counts failed attempts per key (an email, say) in the database, so the count survives a restart
// and is shared by every worker. It is a speed bump, not a guarantee: the read and the write are
// not one atomic step, so a burst of parallel attempts can slip a few extra through.

export const MAX_FAILURES = 10;
export const WINDOW_MINUTES = 15;

// The record id is a hash of the key, so an email never sits in the table and any characters are
// safe in an id.
const idOf = (key: string) => hashToken(`rate-limit:${key}`);

type Counter = { count: number; resetAt: string };

const read = async (key: string): Promise<Counter | null> => {
  const row = await db().find(rateLimitTable, idOf(key));
  if (!row) return null;

  const { count, resetAt } = row;
  if (typeof count !== "number" || typeof resetAt !== "string") return null;
  if (moment().isAfter(resetAt)) return null;

  return { count, resetAt };
};

export const isLimited = async (key: string, max = MAX_FAILURES) => {
  const counter = await read(key);
  return counter !== null && counter.count >= max;
};

export const recordFailure = async (key: string) => {
  const counter = await read(key);

  await db().upsert(rateLimitTable, idOf(key), {
    count: (counter?.count ?? 0) + 1,
    // The window starts at the first failure and does not slide, so steady attempts cannot keep
    // someone locked out for ever.
    resetAt:
      counter?.resetAt ?? moment().add(WINDOW_MINUTES, "minutes").toISOString(),
  });
};

export const clearFailures = async (key: string) => {
  await db().removeWhere(rateLimitTable, [
    { field: "id", op: "$eq", value: idOf(key) },
  ]);
};
