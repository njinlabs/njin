import { RecordId } from "surrealdb";
import z from "zod";
import { type FormMeta, type makeModel, type RelationType } from "..";

type Return<Model extends ReturnType<typeof makeModel>> = z.ZodPreprocess<z.ZodArray<RelationType<ReturnType<Model["validation"]["partial"]>>>>;

export function relationMany<Model extends ReturnType<typeof makeModel>>(meta: FormMeta, model: Model): Return<Model>;

export function relationMany<T extends z.ZodTypeAny, Model extends ReturnType<typeof makeModel>>(meta: FormMeta, model: Model, rule: (z: z.ZodArray<RelationType<ReturnType<Model["validation"]["partial"]>>>) => T): T;

export function relationMany(meta: FormMeta, model: ReturnType<typeof makeModel>, rule?: (z: any) => any) {
  const baseRule = z.array(
    z.preprocess(
      (value) => {
        if (typeof value === "string") {
          return { id: value, _write: true };
        }

        if (value instanceof RecordId) {
          return { id: value.toString().split(":")[1], _write: true };
        }

        return value;
      },
      model.validation
        .extend({
          id: z.any(),
          createdAt: z.string(),
          updatedAt: z.string(),
          _write: z.boolean(),
        })
        .partial()
        .transform((value) => {
          if (value._write) return new RecordId(model.table, value.id);

          return value;
        }),
    ),
  );

  return z
    .preprocess(
      (value) => {
        if (!!value && !Array.isArray(value)) return [value];

        return value;
      },
      rule ? rule(baseRule) : baseRule,
    )
    .meta({
      ...meta,
      renderAs: "multi_relation",
    });
}
