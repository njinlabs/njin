import { makeConfig } from "@njin-utils/acl";

export default makeConfig({
  user: ["write", "read"] as const,
  group: ["write", "read"] as const,
});
