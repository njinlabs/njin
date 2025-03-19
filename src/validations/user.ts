import z from "zod";

export const updateUserValidation = z.object({
  fullname: z.string().nonempty(),
  email: z.string().email().nonempty(),
  password: z.coerce.string(),
});

export const createUserValidation = z.object({
  fullname: z.string().nonempty(),
  email: z.string().email().nonempty(),
  password: z.string().nonempty(),
});
