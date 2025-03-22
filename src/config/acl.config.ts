import { makeConfig } from "@njin-utils/acl";

export default makeConfig({
  user: ["write", "read"] as const,
  accessGroup: ["write", "read"] as const,
});
