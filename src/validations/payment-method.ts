import z from "zod";

export const composePaymentMethod = z.object({
  name: z.string(),
  accountName: z.string().optional(),
  accountNumber: z.string().optional(),
  isActive: z.boolean().nullable().default(true),
});
