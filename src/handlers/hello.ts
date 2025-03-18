import { Hono } from "hono";

const hello = new Hono();

hello.get("/", (c) => {
  return c.json({
    message: "Hello Njin!",
  });
});

export default hello;
