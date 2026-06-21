import fileModule from "@njin/modules/file";
import type z from "zod";
import { type FormMeta, type RelationType } from "..";
import { relationMany } from "./relation_many";

type Return = RelationType<ReturnType<ReturnType<typeof fileModule>["model"]["validation"]["partial"]>>;

export function multiFile(meta: FormMeta): z.ZodPreprocess<z.ZodArray<Return>>;

export function multiFile<T extends z.ZodTypeAny>(meta: FormMeta, rule: (z: z.ZodArray<Return>) => T): T;

export function multiFile(meta: FormMeta, rule?: (z: any) => any) {
  return relationMany(meta, fileModule().model, rule ? rule : (z) => z).meta({
    ...meta,
    renderAs: "multi_file",
    model: fileModule().model.prefix,
  });
}
