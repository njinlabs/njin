import { Fee } from "@njin-types/fee";
import DineroFactory, { Dinero } from "dinero.js";

export function calculateFee(subtotal: Dinero, fees: Fee[] = []) {
  let total = subtotal;
  const result: Fee[] = [];

  for (const fee of fees) {
    let amount =
      fee.amount ||
      DineroFactory({
        amount: 0,
        currency: total.getCurrency(),
        precision: total.getPrecision(),
      });
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
