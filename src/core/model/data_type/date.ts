import moment from "moment";
import z from "zod";
import type { FormMeta } from "..";

export function date(meta: FormMeta): z.ZodPreprocess<z.ZodString>;

export function date<T extends z.ZodTypeAny>(meta: FormMeta, rule: (z: z.ZodString) => T): z.ZodPreprocess<T>;

export function date(meta: FormMeta, rule?: (z: any) => any) {
  const inner = rule ? rule(z.string()) : z.string();

  return z
    .preprocess((value) => {
      if (moment.isMoment(value)) {
        return value.toISOString();
      }

      if (typeof value === "string") {
        return moment(value).toISOString();
      }

      return undefined;
    }, inner)
    .meta({
      ...meta,
      renderAs: "datepicker",
    });
}
