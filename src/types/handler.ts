import { Hono } from "hono";
import { Njin } from "./njin";

export type Handler = {
  path: string;
  action: Hono<Njin>;
};
