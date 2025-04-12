import { makeConfig } from "@njin-utils/acl";

export default makeConfig({
  user: ["write", "read"],
  accessGroup: ["write", "read"],
  product: ["write", "read"],
  transaction: ["makeAdjustment"],
  customer: ["write", "read"],
  supplier: ["write", "read"],
  paymentMethod: ["write", "read"],
} as const);
