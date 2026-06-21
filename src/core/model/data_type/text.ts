import z from "zod";
import type { FormMeta } from "..";

export function text(meta: FormMeta): z.ZodPreprocess<z.ZodString>;

export function text<T extends z.ZodTypeAny>(meta: FormMeta, rule: (z: z.ZodString) => T): z.ZodPreprocess<T>;

export function text(meta: FormMeta, rule?: (z: any) => any) {
  const inner = rule ? rule(z.string()) : z.string();

  return z
    .preprocess((value) => {
      if (!value) return undefined;
      return value;
    }, inner)
    .meta({
      ...meta,
      renderAs: "text",
    });
}
