import z from "zod";
import { dineroValidation } from "./general";

export const makeAdjustmentValidation = z.object({
  adjustments: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number().min(0),
      price: dineroValidation,
    })
  ),
  profitLedgerRecord: z.boolean().optional().default(true),
});
