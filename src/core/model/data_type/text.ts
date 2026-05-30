import z from "zod";
import type { FormMeta } from "..";

export function text(meta: FormMeta): z.ZodPreprocess<z.ZodString>;

export function text<T extends z.ZodTypeAny>(meta: FormMeta, rule: (z: z.ZodPreprocess<z.ZodString>) => T): T;

export function text(meta: FormMeta, rule?: (z: any) => any) {
  const baseRule = z.preprocess((value) => {
    if (!value) return undefined;
    return value;
  }, z.string());

  return (rule ? rule(baseRule) : baseRule).meta({
    ...meta,
    renderAs: "text",
  });
}
