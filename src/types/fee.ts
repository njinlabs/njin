import { type Dinero } from "dinero.js";

export type Fee = {
  name: string;
  amount?: Dinero;
  percentage?: {
    value: number;
    fromGrandTotal?: boolean;
  };
};
