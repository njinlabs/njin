import Elysia, { status } from "elysia";
import z from "zod";
import { parseGrant, validateGrants } from "../core/auth/access";
import { HttpError } from "../core/http/http_error";
import { filtersQuerySchema } from "../core/model";
import { makeModule } from "../core/module";
import auth from "./auth";
import db from "./db";
import elysia from "./elysia";
import { getCatalog, getGuard } from "./guard";

const isFullAccess = (grants: readonly string[]) =>
  grants.some((raw) => {
    const grant = parseGrant(raw);
    return (
      grant?.resource === "*" && grant.action === "*" && grant.scope === "all"
    );
  });

const texts = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const PAGE = 500;

// Every row of a table, a page at a time.
const allRows = async (def: Parameters<ReturnType<typeof db>["list"]>[0]) => {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const result = await db().list(def, { page, limit: PAGE, populate: [] });
    rows.push(...result.rows);
    if (page * PAGE >= result.total) return rows;
  }
};

export type FullAccessChange = {
  // A group about to get these grants, or null when it is about to be deleted.
  group?: { id: string; grants: readonly string[] | null };
  // A user about to be in these groups, or null when they are about to be deleted.
  user?: { id: string; groups: readonly string[] | null };
};

// Someone has to be able to do everything, or nobody can hand out access again — setup only
// works on an empty site, so the way back is editing the database. Refuses a change that would
// take the last such person away; a site that has nobody like that to begin with is left alone.
export const assertFullAccessRemains = async (change: FullAccessChange) => {
  const { default: user } = await import("../models/user");
  const { default: accessGroup } = await import("../models/access_group");

  const groups = new Map(
    (await allRows(accessGroup.def)).map((row) => [row.id, texts(row.grants)]),
  );
  const users = (await allRows(user.def)).map((row) => ({
    id: row.id,
    groups: texts(row.groups),
  }));

  const holders = (
    ofGroups: ReadonlyMap<string, readonly string[]>,
    ofUsers: { id: string; groups: readonly string[] }[],
  ) =>
    ofUsers.filter((member) =>
      member.groups.some((id) => isFullAccess(ofGroups.get(id) ?? [])),
    ).length;

  if (holders(groups, users) === 0) return;

  const nextGroups = new Map<string, readonly string[]>(groups);
  if (change.group) {
    if (change.group.grants === null) nextGroups.delete(change.group.id);
    else nextGroups.set(change.group.id, change.group.grants);
  }

  const nextUsers = users.flatMap((member) => {
    if (member.id !== change.user?.id) return [member];
    return change.user.groups === null
      ? []
      : [{ ...member, groups: change.user.groups }];
  });

  if (holders(nextGroups, nextUsers) === 0) {
    throw new HttpError(
      409,
      "This would leave nobody with full access to the site",
    );
  }
};

const accessGroups = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const { default: accessGroup } = await import("../models/access_group");
    const authPlugin = (await auth()).plugin;
    const guard = await getGuard();
    const catalog = await getCatalog();

    const invalid = (grants: string[]) => {
      const errors = validateGrants(grants, catalog);
      return errors.length
        ? status(422, { message: "Some grants are not valid", errors })
        : null;
    };

    const controller = new Elysia({ prefix: "/api/access_group" })
      .use(authPlugin)
      .get(
        "/",
        async ({
          principal,
          query: { search, page, limit, sort, order, filters },
        }) => {
          const gate = guard.gate(principal, accessGroup);
          const result = await accessGroup.read(
            gate.read({ search, page, limit, sort, order, filters }),
          );

          return { ...result, data: gate.shapeAll(result.data) };
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
          const gate = guard.gate(principal, accessGroup);
          await gate.seeing(params.id);

          const data = await accessGroup.show(params.id);
          return { data: data ? gate.shape(data) : null };
        },
        {
          auth: { session: true },
          params: z.object({ id: z.coerce.string() }),
        },
      )
      .post(
        "/",
        async ({ body, principal }) => {
          const gate = guard.gate(principal, accessGroup);
          const owner = gate.creating();

          const problem = invalid(body.grants);
          if (problem) return problem;

          return {
            data: gate.echo(await accessGroup.create(body, owner)),
          };
        },
        { auth: { session: true }, body: accessGroup.validation },
      )
      .put(
        "/:id",
        async ({ params, body, principal }) => {
          const gate = guard.gate(principal, accessGroup);
          await gate.changing(params.id, "update");

          if (body.grants) {
            const problem = invalid(body.grants);
            if (problem) return problem;

            await assertFullAccessRemains({
              group: { id: params.id, grants: body.grants },
            });
          }

          return {
            data: gate.echo(await accessGroup.update(params.id, body)),
          };
        },
        {
          auth: { session: true },
          params: z.object({ id: z.coerce.string() }),
          body: accessGroup.validation.partial(),
        },
      )
      .delete(
        "/:id",
        async ({ params, principal }) => {
          const gate = guard.gate(principal, accessGroup);
          await gate.changing(params.id, "delete");
          await assertFullAccessRemains({
            group: { id: params.id, grants: null },
          });

          return { data: gate.echo(await accessGroup.destroy(params.id)) };
        },
        {
          auth: { session: true },
          params: z.object({ id: z.coerce.string() }),
        },
      );

    // What a grant can name, for the screen that edits groups.
    const catalogController = new Elysia({ prefix: "/api/access" })
      .use(authPlugin)
      .get("/catalog", () => ({ data: catalog }), {
        auth: { session: true, can: ["access_group", "read"] } as const,
      });

    // What the caller may do — for a client to show only what will work, and for an agent to
    // check before it tries. Open to every kind of token: it only tells them about themselves.
    const meController = new Elysia({ prefix: "/api/auth" })
      .use(authPlugin)
      .get(
        "/permissions",
        ({ principal }) => ({
          data: catalog.flatMap((entry) => {
            const actions = Object.fromEntries(
              entry.actions.flatMap((action) => {
                const level = guard.can(principal, entry.resource, action);
                return level ? [[action, level] as const] : [];
              }),
            );

            return Object.keys(actions).length
              ? [{ resource: entry.resource, scoped: entry.scoped, actions }]
              : [];
          }),
        }),
        { auth: true },
      );

    elysia().use(controller).use(catalogController).use(meController);

    return {};
  };

  return fn;
});

export default accessGroups;
