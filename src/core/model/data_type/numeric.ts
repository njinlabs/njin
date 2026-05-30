import z from "zod";
import type { FormMeta } from "..";

export function numeric(meta: FormMeta): z.ZodNumber;

export function numeric<T extends z.ZodTypeAny>(meta: FormMeta, rule: (z: z.ZodNumber) => T): T;

export function numeric(meta: FormMeta, rule?: (z: any) => any) {
  const baseRule = z.number();

  return (rule ? rule(baseRule) : baseRule).meta({
    ...meta,
    renderAs: "numeric",
  });
}
