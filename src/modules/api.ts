import { getConfig } from "../core/config";
import { makeModule } from "../core/module";
import Elysia from "elysia";
import z from "zod";
import auth from "./auth";
import elysia from "./elysia";

const api = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const models = getConfig().models;
    const authPlugin = await auth();

    const controller = new Elysia({ prefix: "/api/schema" }).use(authPlugin.plugin).get(
      "/",
      async () => {
        const allModels = await Promise.all(
          models.map((model) =>
            (async () => {
              const { default: data } = await model();

              return {
                name: data.name,
                prefix: data.prefix,
                schema: data.validation.toJSONSchema({
                  unrepresentable: "any",
                  override: (ctx) => {
                    if (ctx.jsonSchema.renderAs === "relation") {
                      ctx.jsonSchema.type = "object";
                      ctx.jsonSchema.properties = {
                        id: {
                          type: "string",
                        },
                      };
                      ctx.jsonSchema.required = ["id"];
                      ctx.jsonSchema.additionalProperties = {};
                    } else if (ctx.jsonSchema.renderAs === "multi_relation") {
                      (ctx.jsonSchema.items! as any).type = "string";
                    } else if (ctx.jsonSchema.renderAs === "file") {
                      ctx.jsonSchema.type = "string";
                    }
                  },
                }),
              };
            })(),
          ),
        );

        return { data: allModels };
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
          async ({ params }) => {
            const data = await model.show(params.id);

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
          async ({ query: { search, page, limit, sort, order, populate, filters } }) => {
            const populateOpt =
              populate === "none" ? ("none" as const) : populate ? populate.split(",").map((s) => s.trim()) : undefined;

            return model.read({ search, page, limit, sort, order, populate: populateOpt, filters });
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
              filters: z
                .record(z.string(), z.union([z.coerce.string(), z.record(z.string(), z.coerce.string())]))
                .optional(),
            }),
          },
        );

      elysia().use(controller);
    }

    return {};
  };

  return fn;
});

export default api;
