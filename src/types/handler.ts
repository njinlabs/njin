import { Hono } from "hono";

export type Handler = {
  path: string;
  action: Hono;
};
