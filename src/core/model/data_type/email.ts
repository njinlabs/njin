import z from "zod";
import type { FormMeta } from "..";

export function email(meta: FormMeta): z.ZodPreprocess<z.ZodEmail>;

export function email<T extends z.ZodTypeAny>(meta: FormMeta, rule: (z: z.ZodPreprocess<z.ZodEmail>) => T): T;

export function email(meta: FormMeta, rule?: (z: any) => any) {
  const baseRule = z.preprocess((value) => {
    if (!value) return undefined;

    return value;
  }, z.email());

  return (rule ? rule(baseRule) : baseRule).meta({
    ...meta,
    renderAs: "text",
  });
}
