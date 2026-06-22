import fileModule from "@njin/modules/file";
import type z from "zod";
import { relation, type FormMeta, type RelationType } from "..";

export function file(meta: FormMeta): RelationType<ReturnType<ReturnType<typeof fileModule>["model"]["validation"]["partial"]>>;

export function file<T extends z.ZodTypeAny>(meta: FormMeta, rule: (z: RelationType<ReturnType<ReturnType<typeof fileModule>["model"]["validation"]["partial"]>>) => T): T;

export function file(meta: FormMeta, rule?: (z: any) => any) {
  return relation(meta, fileModule().model, rule ? rule : (z) => z).meta({
    ...meta,
    renderAs: "file",
    model: fileModule().model.prefix,
  });
}
