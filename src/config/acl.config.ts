import { makeConfig } from "@njin-utils/acl";

export default makeConfig({
  user: ["write", "read"],
  accessGroup: ["write", "read"],
  product: ["write", "read"],
  transaction: ["makeAdjustment"],
} as const);
