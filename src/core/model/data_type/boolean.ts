import z from "zod";
import type { FormMeta } from "..";

export function boolean(meta: FormMeta): z.ZodBoolean;

export function boolean<T extends z.ZodTypeAny>(meta: FormMeta, rule: (z: z.ZodBoolean) => T): T;

export function boolean(meta: FormMeta, rule?: (z: any) => any) {
  const baseRule = z.boolean();

  return (rule ? rule(baseRule) : baseRule).meta({
    ...meta,
    renderAs: "boolean",
  });
}
