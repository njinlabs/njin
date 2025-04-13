import { Transform } from "class-transformer";
import DineroFactory, { type Dinero } from "dinero.js";
import { ValueTransformer } from "typeorm";

export const transformDinero: ValueTransformer = {
  to(value: Dinero) {
    return value.toUnit().toFixed(2);
  },
  from(value: string) {
    return value;
  },
};

export function TransformDinero() {
  return function (target: object, propertyKey: string | symbol): void {
    Transform(
      ({ value }: { value: string | { amount: number } | Dinero }) => {
        return typeof value === "string"
          ? DineroFactory({ amount: Math.round(parseFloat(value) * 100) })
          : (value as { amount: number }).amount
          ? DineroFactory({
              amount: (value as { amount: number }).amount,
            })
          : value;
      },
      { toClassOnly: true }
    )(target, propertyKey);

    Transform(
      ({ value }: { value: Dinero | string }) => {
        return typeof value === "string"
          ? Math.round(parseFloat(value) * 100)
          : value.getAmount();
      },
      { toPlainOnly: true }
    )(target, propertyKey);
  };
}
