import Elysia from "elysia";
import { z } from "zod";
import { getConfig } from "../core/config";
import { makeModule } from "../core/module";
import { isDraftableVars } from "../core/vars";
import auth from "./auth";
import elysia from "./elysia";

// `?locale=en` or `?locale=en,id`; nothing means every language.
const languagesOf = (locale: string | undefined) => {
  const list = locale
    ?.split(",")
    .map((code) => code.trim())
    .filter(Boolean);
  return list?.length ? { locale: list } : undefined;
};

const vars = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const groups = getConfig().vars;
    const authPlugin = await auth();

    for (const promise of groups) {
      const { default: group } = await promise();

      // `locale` / `fallback` are only read by groups made with `i18n: true`: one language, flat.
      const read = z.object({
        locale: z.coerce.string().optional(),
        fallback: z.enum(["true", "false"]).optional(),
      });

      const controller = new Elysia({ prefix: `/api/vars/${group.prefix}` })
        .use(authPlugin.plugin)
        .get(
          "/",
          async ({ query }) => ({
            data: await group.get({
              locale: query.locale,
              fallback: query.fallback !== "false",
            }),
          }),
          { auth: true, query: read },
        )
        .put("/", async ({ body }) => ({ data: await group.update(body) }), {
          auth: true,
          body: group.validation.partial(),
        });

      // Draftable groups: what is live, and the moves between working copy and live.
      if (isDraftableVars(group)) {
        controller.get(
          "/published",
          async ({ query }) => ({
            data: await group.published.get({
              locale: query.locale,
              fallback: query.fallback !== "false",
            }),
          }),
          { auth: true, query: read },
        );

        for (const action of ["publish", "unpublish", "discard"] as const) {
          controller.post(
            `/${action}`,
            async ({ query }) => ({
              data: await group[action](languagesOf(query.locale)),
            }),
            {
              auth: true,
              query: z.object({ locale: z.coerce.string().optional() }),
            },
          );
        }
      }

      elysia().use(controller);
    }

    return {};
  };

  return fn;
});

export default vars;
