import z from "zod";

export const makeAdjustmentValidation = z.object({
  adjustments: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number(),
    })
  ),
});
