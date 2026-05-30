import z from "zod";
import { type FormMeta } from "..";

export function array<T extends z.ZodTypeAny>(meta: FormMeta, input: T): z.ZodPreprocess<z.ZodArray<T>>;

export function array<T extends z.ZodTypeAny, Z extends z.ZodTypeAny>(meta: FormMeta, input: T, rule: (z: z.ZodArray<T>) => Z): z.ZodPreprocess<Z>;

export function array(meta: FormMeta, input: z.ZodTypeAny, rule?: (z: any) => any) {
  const baseRule = z.preprocess(
    (value) => {
      if (!!value && !Array.isArray(value)) return [value];

      return value;
    },
    rule ? rule(z.array(input)) : z.array(input),
  );

  return baseRule.meta({
    ...meta,
    renderAs: "array",
  });
}
