import moment from "moment";
import type { z } from "zod";
import db from "../../modules/db";
import { varsTable } from "../db/internal";
import { runAfterHooks, runBeforeHooks } from "../model/hooks";

// One shared physical table for every VARS group — rows are keyed by each
// group's own prefix as the record id, not one table per group (see varsTable).
type Values<T> = T;

export const makeVars = <Rules extends z.ZodObject>(
  prefix: string,
  config: {
    schema: Rules;
    name: string;
  },
) => {
  type Data = z.infer<Rules>;
  type Returning = Data & { updatedAt: string | null };

  // schema.parse() fills in every field's .default() for anything missing —
  // including the row never having been saved at all — so get() always
  // returns a complete, valid object. Every VARS field is expected to
  // declare a .default(...) for this reason.
  const get = async (): Promise<Returning> => {
    const record = await db().find(varsTable, prefix);
    const { updatedAt, ...rest } = (record ?? {}) as Record<string, unknown> & {
      updatedAt?: string;
    };
    return {
      ...(config.schema.parse(rest) as Data),
      updatedAt: updatedAt ?? null,
    };
  };

  // Upsert, not update — the row may not exist yet on first save.
  const update = async (data: Values<Partial<Data>>): Promise<Returning> => {
    const merged = (await runBeforeHooks(
      "beforeVarsUpdate",
      prefix,
      data as Record<string, unknown>,
      {},
    )) as Values<Partial<Data>>;

    const record = await db().upsert(varsTable, prefix, {
      ...merged,
      updatedAt: moment().toISOString(),
    });

    const { updatedAt, ...rest } = (record ?? {}) as Record<string, unknown> & {
      updatedAt?: string;
    };
    const result = {
      ...(config.schema.parse(rest) as Data),
      updatedAt: updatedAt ?? null,
    };

    await runAfterHooks("afterVarsUpdate", prefix, result);

    return result;
  };

  return {
    name: config.name,
    prefix,
    validation: config.schema,
    get,
    update,
  };
};
