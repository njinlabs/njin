import { zValidator } from "@hono/zod-validator";
import { response } from "@njin-utils/response";
import { ValidationTargets } from "hono";
import { ZodSchema } from "zod";

export default function validator<
  T extends ZodSchema,
  Target extends keyof ValidationTargets
>(target: Target, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(response("Validation failed", result.error.issues), 422);
    }
  });
}
