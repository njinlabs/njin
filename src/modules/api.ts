import Elysia from "elysia";
import z from "zod";
import { toAdminSchema } from "../core/admin_schema";
import { getConfig } from "../core/config";
import { filtersQuerySchema, isDraftable, isI18n } from "../core/model";
import { makeModule } from "../core/module";
import { isDraftableVars, isI18nVars } from "../core/vars";
import auth from "./auth";
import elysia from "./elysia";

const api = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const models = getConfig().models;
    const hooks = getConfig().hooks;
    const events = getConfig().events;
    const routes = getConfig().routes;
    const varsGroups = getConfig().vars;
    const authPlugin = await auth();

    // Trigger each hook file's import side effect (afterCreate()/etc. registration)
    // before any route goes live, so hooks are always registered before the first request.
    for (const promise of hooks) await promise();

    // Same reasoning as hooks above, for the event bus (src/core/event.ts): drain
    // every listener file's .listen() registration before any route goes live.
    for (const promise of events) await promise();

    const controller = new Elysia({ prefix: "/api/schema" })
      .use(authPlugin.plugin)
      .get(
        "/",
        async () => {
          const allModels = await Promise.all(
            models.map((model) =>
              (async () => {
                const { default: data } = await model();

                return {
                  name: data.name,
                  prefix: data.prefix,
                  draftable: isDraftable(data),
                  i18n: isI18n(data),
                  schema: toAdminSchema(data.validation),
                };
              })(),
            ),
          );

          const allVars = await Promise.all(
            varsGroups.map((varsGroup) =>
              (async () => {
                const { default: group } = await varsGroup();

                return {
                  name: group.name,
                  prefix: group.prefix,
                  draftable: isDraftableVars(group),
                  i18n: isI18nVars(group),
                  schema: toAdminSchema(group.validation),
                };
              })(),
            ),
          );

          return {
            data: allModels,
            vars: allVars,
            // The languages of the site, for models with `i18n: true`; null when not configured.
            i18n: getConfig().i18n ?? null,
          };
        },
        {
          auth: true,
        },
      );

    elysia().use(controller);

    for (const promise of models) {
      const { default: model } = await promise();

      const controller = new Elysia({ prefix: `/api/${model.prefix}` })
        .use(authPlugin.plugin)
        .delete(
          "/:id",
          async ({ params }) => {
            const data = await model.destroy(params.id);

            return {
              data,
            };
          },
          {
            params: z.object({
              id: z.coerce.string(),
            }),
            auth: true,
          },
        )
        .get(
          "/:id",
          async ({ params, query }) => {
            const data = await model.show(params.id, {
              locale: query.locale,
              fallback: query.fallback !== "false",
            });

            return {
              data,
            };
          },
          {
            params: z.object({
              id: z.coerce.string(),
            }),
            // One language: flat records for a model with `i18n: true`, and the language of
            // the related i18n records for any other.
            query: z.object({
              locale: z.coerce.string().optional(),
              fallback: z.enum(["true", "false"]).optional(),
            }),
            auth: true,
          },
        )
        .put(
          "/:id",
          async ({ params, body }) => {
            const data = await model.update(params.id, body);

            return {
              data,
            };
          },
          {
            params: z.object({
              id: z.coerce.string(),
            }),
            auth: true,
            body: model.validation.partial(),
          },
        )
        .post(
          "/",
          async ({ body }) => {
            const data = await model.create(body);

            return {
              data,
            };
          },
          {
            auth: true,
            body: model.validation,
          },
        )
        .get(
          "/",
          async ({
            query: {
              search,
              page,
              limit,
              sort,
              order,
              populate,
              select,
              filters,
              locale,
              fallback,
            },
          }) => {
            const populateOpt =
              populate === "none"
                ? ("none" as const)
                : populate
                  ? populate.split(",").map((s) => s.trim())
                  : undefined;

            const selectOpt = select
              ? select
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined;

            const options = {
              search,
              page,
              limit,
              sort,
              order,
              populate: populateOpt,
              select: selectOpt,
              filters,
            };

            // `locale` is a model's own language when it has i18n, and the language of the
            // related records of other i18n models otherwise.
            return model.read({
              ...options,
              locale,
              fallback: fallback !== "false",
            });
          },
          {
            auth: true,
            query: z.object({
              search: z.coerce.string().optional(),
              page: z.coerce.number().int().positive().default(1),
              limit: z.coerce.number().int().positive().max(100).default(20),
              sort: z.coerce.string().optional(),
              order: z.enum(["asc", "desc"]).default("asc"),
              populate: z.coerce.string().optional(),
              select: z.coerce.string().max(1000).optional(),
              filters: filtersQuerySchema.optional(),
              // See the single-record route above.
              locale: z.coerce.string().optional(),
              fallback: z.enum(["true", "false"]).optional(),
            }),
          },
        );

      // i18n models: take one language of a record away.
      if (isI18n(model)) {
        controller.delete(
          "/:id/locale/:locale",
          async ({ params }) => ({
            data: await model.removeLocale(params.id, params.locale),
          }),
          {
            params: z.object({
              id: z.coerce.string(),
              locale: z.coerce.string(),
            }),
            auth: true,
          },
        );
      }

      // Draftable models: edits only touch the working copy, these move it to / from live.
      if (isDraftable(model)) {
        for (const action of ["publish", "unpublish", "discard"] as const) {
          controller.post(
            `/:id/${action}`,
            async ({ params, query }) => {
              // i18n models: `?locale=en` or `?locale=en,id`; nothing means every language.
              const locale = query.locale
                ?.split(",")
                .map((code) => code.trim())
                .filter(Boolean);
              return {
                data: await model[action](
                  params.id,
                  locale?.length ? { locale } : undefined,
                ),
              };
            },
            {
              params: z.object({ id: z.coerce.string() }),
              query: z.object({ locale: z.coerce.string().optional() }),
              auth: true,
            },
          );
        }
      }

      elysia().use(controller);
    }

    for (const promise of routes) {
      const { default: plugin } = await promise();
      elysia().use(plugin);
    }

    return {};
  };

  return fn;
});

export default api;
