import { makeModule } from "../core/module";
import Elysia, { status } from "elysia";
import z from "zod";
import auth from "./auth";
import elysia from "./elysia";

const stripPassword = <T extends { password: unknown }>({ password: _, ...rest }: T) => rest;

const users = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const { default: user } = await import("../models/user");
    const authPlugin = (await auth()).plugin;

    const controller = new Elysia({ prefix: "/api/user" })
      .use(authPlugin)
      .get(
        "/",
        async ({ query: { search, page, limit, sort, order, filters } }) => {
          const result = await user.read({ search, page, limit, sort, order, filters });

          return { data: result.data.map(stripPassword), meta: result.meta };
        },
        {
          auth: true,
          query: z.object({
            search: z.coerce.string().optional(),
            page: z.coerce.number().int().positive().default(1),
            limit: z.coerce.number().int().positive().max(100).default(20),
            sort: z.coerce.string().optional(),
            order: z.enum(["asc", "desc"]).default("asc"),
            filters: z
              .record(z.string(), z.union([z.coerce.string(), z.record(z.string(), z.coerce.string())]))
              .optional(),
          }),
        },
      )
      .get(
        "/:id",
        async ({ params }) => {
          const data = await user.show(params.id);

          return { data: data ? stripPassword(data) : null };
        },
        { auth: true, params: z.object({ id: z.coerce.string() }) },
      )
      .post(
        "/",
        async ({ body }) => {
          const created = await user.create(body);

          return { data: stripPassword(created) };
        },
        { auth: true, body: user.validation },
      )
      .put(
        "/:id",
        async ({ params, body }) => {
          const updated = await user.update(params.id, body);

          return { data: stripPassword(updated) };
        },
        {
          auth: true,
          params: z.object({ id: z.coerce.string() }),
          body: user.validation.partial(),
        },
      )
      .delete(
        "/:id",
        async ({ params, user: actingUser }) => {
          // The only recovery path for a locked-out instance is a manual DB edit —
          // setup is permanently disabled once any user exists, so block self-delete.
          if (params.id === actingUser.id.id) {
            return status(400, { message: "You cannot delete your own account" });
          }

          const deleted = await user.destroy(params.id);

          return { data: stripPassword(deleted) };
        },
        { auth: true, params: z.object({ id: z.coerce.string() }) },
      );

    elysia().use(controller);

    return {};
  };

  return fn;
});

export default users;
