import surreal from "../../modules/surreal";
import moment from "moment";
import { RecordId, Table, type Values } from "surrealdb";
import { z } from "zod";
import { runAfterHooks, runBeforeHooks } from "../model/hooks";

// One shared physical table for every VARS group — rows are keyed by each
// group's own prefix as the record id (vars:general, vars:seo, ...), not one
// table per group. See surreal.ts's ensureTables() for the DEFINE TABLE call.
const table = new Table("vars");

export const makeVars = <Rules extends z.ZodObject>(
  prefix: string,
  config: {
    schema: Rules;
    name: string;
  },
) => {
  type Data = z.infer<Rules>;
  type Returning = Data & { updatedAt: string | null };

  const recordId = new RecordId(table, prefix);

  // schema.parse() fills in every field's .default() for anything missing —
  // including the row never having been saved at all — so get() always
  // returns a complete, valid object. Every VARS field is expected to
  // declare a .default(...) for this reason.
  const get = async (): Promise<Returning> => {
    const record = await surreal().select<Data & { updatedAt?: string }>(recordId);
    const { updatedAt, ...rest } = (record ?? {}) as Record<string, unknown> & { updatedAt?: string };
    return { ...(config.schema.parse(rest) as Data), updatedAt: updatedAt ?? null };
  };

  // Upsert, not update — the row may not exist yet on first save.
  const update = async (data: Values<Partial<Data>>): Promise<Returning> => {
    const merged = (await runBeforeHooks(
      "beforeVarsUpdate",
      prefix,
      data as Record<string, unknown>,
      {},
    )) as Values<Partial<Data>>;

    const record = (await surreal()
      .upsert<Data & { updatedAt: string }>(recordId)
      .merge({ ...merged, updatedAt: moment().toISOString() } as Values<Data & { updatedAt: string }>)
      .output("after")) as (Data & { updatedAt: string }) | undefined;

    const { updatedAt, ...rest } = (record ?? {}) as Record<string, unknown> & { updatedAt?: string };
    const result = { ...(config.schema.parse(rest) as Data), updatedAt: updatedAt ?? null };

    await runAfterHooks("afterVarsUpdate", prefix, result);

    return result;
  };

  return {
    name: config.name,
    prefix,
    table,
    validation: config.schema,
    get,
    update,
  };
};
