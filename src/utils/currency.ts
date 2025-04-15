import config from "@njin-modules/config";
import DineroFactory, { type Dinero, type Currency } from "dinero.js";

export const currency = (amount: number, currency?: Currency): Dinero => {
  return DineroFactory({
    amount,
    currency: currency || (config.njin.currency.default as Currency),
  });
};
