import { Handler } from "@njin-types/handler";
import hello from "./hello";
import user from "./user";
import auth from "./auth";

const handlers: Handler[] = [
  {
    path: "/api/auth",
    action: auth,
  },
  {
    path: "/api/user",
    action: user,
  },
  {
    path: "/",
    action: hello,
  },
];

export default handlers;
