import z from "zod";
import type { FormMeta } from "..";

export function select<const T extends readonly string[]>(meta: FormMeta, options: T): z.ZodEnum<{ [x in T[number]]: x }>;

export function select<const T extends readonly string[], Z extends z.ZodTypeAny>(meta: FormMeta, options: T, rule: (z: z.ZodEnum<{ [x in T[number]]: x }>) => Z): Z;

export function select(meta: FormMeta, options: string[], rule?: (z: any) => any) {
  const baseRule = z.enum(options);

  return (rule ? rule(baseRule) : baseRule).meta({
    ...meta,
    renderAs: "select",
  });
}
