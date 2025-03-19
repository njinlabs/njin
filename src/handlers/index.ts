import { Handler } from "@njin-types/handler";
import hello from "./hello";
import user from "./user";

const handlers: Handler[] = [
  {
    path: "/user",
    action: user,
  },
  {
    path: "/",
    action: hello,
  },
];

export default handlers;
