import User from "@njin-entities/user";
import UserToken from "@njin-entities/user-token";
import { makeConfig } from "@njin-modules/auth";

export default makeConfig({
  guards: {
    user: {
      user: User,
      token: UserToken,
    },
  },
  defaultGuard: "user",
});
