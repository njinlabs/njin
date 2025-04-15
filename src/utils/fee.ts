import { Fee } from "@njin-types/fee";
import { Dinero } from "dinero.js";
import { currency } from "./currency";

export function calculateFee(subtotal: Dinero, fees: Fee[] = []) {
  let total = subtotal;
  const result: Fee[] = [];

  for (const fee of fees) {
    let amount = fee.amount || currency(0);
    if (amount.isZero() && fee.percentage) {
      amount = (fee.percentage.fromGrandTotal ? total : subtotal).percentage(
        fee.percentage.value
      );
    }

    total = total.add(amount);

    result.push({
      name: fee.name,
      amount,
      percentage: fee.percentage,
    });
  }

  return { result, total };
}
