import z from "zod";

export const metaDataValidation = z.object({
  perPage: z.coerce.number().min(1).max(200).default(50),
  page: z.coerce.number().min(1).default(1),
});
