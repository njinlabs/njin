import aclConfig from "@njin-config/acl.config";
import { ACLAllowed } from "@njin-types/acl";
import { Njin } from "@njin-types/njin";
import { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";

export default function acl<Item extends keyof typeof aclConfig>(
  item: Item,
  action: (typeof aclConfig)[Item][number]
) {
  return async (c: Context<Njin>, next: Next) => {
    const allowed: Partial<ACLAllowed> = c.var.auth.user?.controls || {};

    const parsedUserConrolList = Object.keys(allowed).reduce(
      (carry: string[], item) => {
        for (const list of allowed[item as keyof typeof allowed] || []) {
          carry.push(`${item}:${list}`);
        }

        return carry;
      },
      [] as string[]
    );

    if (!parsedUserConrolList.includes(`${item}:${action}`))
      throw new HTTPException(403, {
        message: "Action is not allowed",
      });

    await next();
  };
}
