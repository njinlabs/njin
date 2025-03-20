import { Njin } from "@njin-types/njin";
import { Hono } from "hono";

const hello = new Hono<Njin>();

hello.get("/", (c) => {
  return c.json({
    message: "Hello Njin!",
  });
});

export default hello;
