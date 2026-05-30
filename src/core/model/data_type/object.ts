import z from "zod";
import type { FormMeta } from "..";

export function object<T extends { [x: string]: z.ZodTypeAny }>(meta: FormMeta, shape: T): z.ZodPreprocess<z.ZodString>;

export function object<T extends { [x: string]: z.ZodTypeAny }, Z extends z.ZodTypeAny>(meta: FormMeta, shape: T, rule: (z: z.ZodObject<T>) => Z): Z;

export function object(meta: FormMeta, shape: any, rule?: (z: any) => any) {
  const baseRule = z.object(shape);

  return (rule ? rule(baseRule) : baseRule).meta({
    ...meta,
    renderAs: "object",
  });
}
