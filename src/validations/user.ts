import { password } from "bun";
import z from "zod";

export const createUserValidation = z.object({
  fullname: z.string().nonempty(),
  email: z.string().email().nonempty(),
  password: z.string().nonempty(),
});
