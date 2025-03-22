import aclConfig from "@njin-config/acl.config";
import { ACLAllowed, ACLItem } from "@njin-types/acl";

export function makeConfig<
  Keys extends string,
  Item extends Record<Keys, ACLItem>
>(config: Item) {
  return config;
}

export function toList(allowed: Partial<ACLAllowed> = aclConfig) {
  return Object.keys(allowed).reduce((carry: string[], item) => {
    for (const list of allowed[item as keyof typeof allowed] || []) {
      carry.push(`${item}:${list}`);
    }

    return carry;
  }, [] as string[]);
}
