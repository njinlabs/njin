import aclConfig from "@njin-config/acl.config";
import z from "zod";
import { unique } from "./general";
import User from "@njin-entities/user";

export const controlValidation = Object.keys(aclConfig).reduce(
  (carry, key) => {
    (carry as Record<string, unknown>)[key as keyof typeof carry] = z
      .array(z.enum(aclConfig[key as keyof typeof aclConfig]))
      .optional();

    return carry;
  },
  {} as {
    [key in keyof typeof aclConfig]: z.ZodOptional<
      z.ZodArray<z.ZodEnum<(typeof aclConfig)[key]>, "many">
    >;
  }
);

export const updateUserValidation = z.object({
  fullname: z.string().nonempty(),
  email: unique(
    z.string().email().nonempty(),
    User,
    "email",
    (value, res) => res.email === value
  ),
  password: z.string().optional(),
  controls: z.object(controlValidation).optional(),
});

export const createUserValidation = z.object({
  fullname: z.string().nonempty(),
  email: z.string().email().nonempty(),
  password: z.string().nonempty(),
  controls: z.object(controlValidation).optional(),
});
