import z from "zod";
import type { FormMeta } from "..";

export function email(meta: FormMeta): z.ZodPreprocess<z.ZodEmail>;

export function email<T extends z.ZodTypeAny>(meta: FormMeta, rule: (z: z.ZodEmail) => T): z.ZodPreprocess<T>;

export function email(meta: FormMeta, rule?: (z: any) => any) {
  const inner = rule ? rule(z.email()) : z.email();

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
