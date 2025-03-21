import { Handler } from "@njin-types/handler";
import hello from "./hello";
import user from "./user";
import auth from "./auth";
import setup from "./setup";
import accessGroup from "./access-group";

const handlers: Handler[] = [
  {
    path: "/api/access-group",
    action: accessGroup,
  },
  {
    path: "/api/auth",
    action: auth,
  },
  {
    path: "/api/user",
    action: user,
  },
  {
    path: "/api/setup",
    action: setup,
  },
  {
    path: "/",
    action: hello,
  },
];

export default handlers;
