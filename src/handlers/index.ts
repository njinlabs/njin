import { Handler } from "@njin-types/handler";
import hello from "./hello";
import user from "./user";
import auth from "./auth";
import setup from "./setup";
import accessGroup from "./access-group";
import product from "./product";
import transaction from "./transaction";
import customer from "./customer";
import supplier from "./supplier";

const handlers: Handler[] = [
  {
    path: "/api/supplier",
    action: supplier,
  },
  {
    path: "/api/customer",
    action: customer,
  },
  {
    path: "/api/transaction",
    action: transaction,
  },
  {
    path: "/api/product",
    action: product,
  },
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
