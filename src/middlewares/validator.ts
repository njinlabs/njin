import { zValidator } from "@hono/zod-validator";
import { ValidationTargets } from "hono";
import { ZodError, ZodSchema } from "zod";
import { errorResponse } from "../utils/response";

export class ValidationError extends Error {
  public data!: ZodError["issues"];

  constructor(msg: string, data: ZodError) {
    super(msg);
    this.data = data.issues;
  }
}

export default function validator<
  T extends ZodSchema,
  Target extends keyof ValidationTargets
>(target: Target, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        errorResponse(new ValidationError("Validation failed", result.error)),
        422
      );
    }
  });
}
