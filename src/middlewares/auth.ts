import authLib from "@njin-modules/auth";
import { Njin } from "@njin-types/njin";
import { Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";

export default function auth(guard: keyof (typeof authLib)["guards"]) {
  return bearerAuth({
    verifyToken: async (token, c: Context<Njin>) => {
      try {
        const valid = await authLib.use(guard).validate(token);
        c.set("auth", valid);
        return true;
      } catch (e) {
        return false;
      }
    },
    noAuthenticationHeaderMessage: "Authentication required",
    invalidAuthenticationHeaderMessage: "Authentication invalid",
    invalidTokenMessage: "Unathorized",
  });
}
