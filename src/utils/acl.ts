import { ACLItem } from "@njin-types/acl";

export function makeConfig<
  Keys extends string,
  Item extends Record<Keys, ACLItem>
>(config: Item) {
  return config;
}
