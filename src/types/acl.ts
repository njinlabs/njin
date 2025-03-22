import aclConfig from "@njin-config/acl.config";

export type ACLItem<List extends string = any> = Array<List>;

export type ACLAllowed = {
  [key in keyof typeof aclConfig]: Array<(typeof aclConfig)[key][number]>;
};
