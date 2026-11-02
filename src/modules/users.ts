import Elysia, { status } from "elysia";
import z from "zod";
import { HttpError } from "../core/http/http_error";
import { filtersQuerySchema } from "../core/model";
import { makeModule } from "../core/module";
import { assertFullAccessRemains } from "./access_group";
import auth from "./auth";
import elysia from "./elysia";
import { getGuard } from "./guard";

const omitPassword = (record: Record<string, unknown>) => {
  const { password: _, ...rest } = record;
  return rest;
};

// A group is given as its id or as a record carrying one.
const groupIds = (groups: readonly unknown[]) =>
  groups.map((group) =>
    typeof group === "object" && group !== null && "id" in group
      ? String(group.id)
      : String(group),
  );

const users = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const { default: user } = await import("../models/user");
    const authPlugin = (await auth()).plugin;
    const guard = await getGuard();

    // Which groups a user is in decides what they can do, so handing them out is the same power
    // as editing the groups: whoever can only edit users could otherwise make themselves an admin.
    const assertMayAssignGroups = (
      principal: Parameters<typeof guard.can>[0],
      groups: unknown,
    ) => {
      if (
        groups !== undefined &&
        !guard.can(principal, "access_group", "update")
      ) {
        throw new HttpError(
          403,
          "Putting a user in access groups needs access to manage access groups",
        );
      }
    };

    const controller = new Elysia({ prefix: "/api/user" })
      .use(authPlugin)
      .get(
        "/",
        async ({
          principal,
          query: { search, page, limit, sort, order, filters },
        }) => {
          const gate = guard.gate(principal, user);
          const result = await user.read(
            gate.read({ search, page, limit, sort, order, filters }),
          );

          return {
            data: gate.shapeAll(result.data).map(omitPassword),
            meta: result.meta,
          };
        },
        {
          auth: { session: true },
          query: z.object({
            search: z.coerce.string().optional(),
            page: z.coerce.number().int().positive().default(1),
            limit: z.coerce.number().int().positive().max(100).default(20),
            sort: z.coerce.string().optional(),
            order: z.enum(["asc", "desc"]).default("asc"),
            filters: filtersQuerySchema.optional(),
          }),
        },
      )
      .get(
        "/:id",
        async ({ params, principal }) => {
          const gate = guard.gate(principal, user);
          await gate.seeing(params.id);

          const data = await user.show(params.id);

          return { data: data ? omitPassword(gate.shape(data)) : null };
        },
        {
          auth: { session: true },
          params: z.object({ id: z.coerce.string() }),
        },
      )
      .post(
        "/",
        async ({ body, principal }) => {
          const gate = guard.gate(principal, user);
          const owner = gate.creating();
          assertMayAssignGroups(principal, body.groups);

          const created = await user.create(body, owner);

          return { data: omitPassword(gate.echo(created)) };
        },
        { auth: { session: true }, body: user.validation },
      )
      .put(
        "/:id",
        async ({ params, body, principal }) => {
          const gate = guard.gate(principal, user);
          await gate.changing(params.id, "update");
          assertMayAssignGroups(principal, body.groups);
          if (body.groups !== undefined) {
            await assertFullAccessRemains({
              user: { id: params.id, groups: groupIds(body.groups) },
            });
          }

          const updated = await user.update(params.id, body);

          return { data: omitPassword(gate.echo(updated)) };
        },
        {
          auth: { session: true },
          params: z.object({ id: z.coerce.string() }),
          body: user.validation.partial(),
        },
      )
      .delete(
        "/:id",
        async ({ params, principal }) => {
          // The only recovery path for a locked-out instance is a manual DB edit —
          // setup is permanently disabled once any user exists, so block self-delete.
          if (params.id === principal.user.id) {
            return status(400, {
              message: "You cannot delete your own account",
            });
          }

          const gate = guard.gate(principal, user);
          await gate.changing(params.id, "delete");
          await assertFullAccessRemains({
            user: { id: params.id, groups: null },
          });

          const deleted = await user.destroy(params.id);

          return { data: omitPassword(gate.echo(deleted)) };
        },
        {
          auth: { session: true },
          params: z.object({ id: z.coerce.string() }),
        },
      );

    elysia().use(controller);

    return {};
  };

  return fn;
});

export default users;
