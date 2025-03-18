import { Handler } from "@njin-types/handler";
import hello from "./hello";

const handlers: Handler[] = [
  {
    path: "/",
    action: hello,
  },
];

export default handlers;
