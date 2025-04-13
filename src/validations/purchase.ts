import z from "zod";
import { supplierValidation } from "./supplier";
import { dineroValidation } from "./general";

export const composePurchaseValidation = z.object({
  status: z.enum(["PAID", "PENDING"]),
  supplier: z.string().transform(supplierValidation),
  items: z.array(
    z.object({
      productId: z.string(),
      quantity: z.number(),
    })
  ),
  fees: z
    .array(
      z.object({
        name: z.string(),
        amount: dineroValidation.optional(),
        percentage: z
          .object({
            value: z.number(),
            fromGrandTotal: z.boolean().optional().default(false),
          })
          .optional(),
      })
    )
    .optional()
    .default([]),
});
