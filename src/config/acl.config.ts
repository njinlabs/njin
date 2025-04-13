import purchase from "@njin-handlers/purchase";
import { makeConfig } from "@njin-utils/acl";

export default makeConfig({
  user: ["write", "read"],
  accessGroup: ["write", "read"],
  product: ["write", "read"],
  transaction: ["makeAdjustment"],
  customer: ["write", "read"],
  supplier: ["write", "read"],
  paymentMethod: ["write", "read"],
  purchase: ["write", "read"],
} as const);
