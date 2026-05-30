import { RecordId } from "surrealdb";
import z from "zod";
import { type FormMeta, type makeModel } from "..";

export type RelationType<Relation> = z.ZodPreprocess<
  z.ZodPipe<
    z.ZodObject<
      Relation & {
        id: z.ZodOptional<z.ZodAny>;
        createdAt: z.ZodOptional<z.ZodPreprocess<z.ZodString>>;
        updatedAt: z.ZodOptional<z.ZodPreprocess<z.ZodString>>;
        _write: z.ZodOptional<z.ZodNullable<z.ZodOptional<z.ZodBoolean>>>;
      },
      z.core.$strip
    >,
    z.ZodTransform<
      | (z.infer<Relation> & {
          id: unknown;
          createdAt?: string;
          updtedAt?: string;
          _write?: boolean;
        })
      | RecordId<string, any>,
      Relation & {
        id: unknown;
        createdAt?: string;
        updtedAt?: string;
        _write?: boolean;
      }
    >
  >
>;

type Relation<Model extends ReturnType<typeof makeModel>> = RelationType<ReturnType<Model["validation"]["partial"]>>;

export function relation<Model extends ReturnType<typeof makeModel>>(meta: FormMeta & { labelKey?: keyof Model["validation"]["shape"] }, model: Model): Relation<Model>;

export function relation<T extends z.ZodTypeAny, Model extends ReturnType<typeof makeModel>>(meta: FormMeta & { labelKey?: keyof Model["validation"]["shape"] }, model: Model, rule: (z: Relation<Model>) => T): T;

export function relation(meta: any, model: ReturnType<typeof makeModel>, rule?: (z: any) => any) {
  const baseRule = z.preprocess(
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
  );

  return (rule ? rule(baseRule) : baseRule).meta({
    ...meta,
    renderAs: "relation",
    model: model.prefix,
  });
}
