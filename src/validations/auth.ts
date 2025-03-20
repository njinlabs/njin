import z from "zod";

export const createTokenValidation = z.object({
  email: z.string().email(),
  password: z.string(),
});
