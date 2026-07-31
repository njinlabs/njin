import { getConfig } from "../core/config";
import { makeModule } from "../core/module";
import Elysia from "elysia";
import auth from "./auth";
import elysia from "./elysia";

const vars = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const groups = getConfig().vars;
    const authPlugin = await auth();

    for (const promise of groups) {
      const { default: group } = await promise();

      const controller = new Elysia({ prefix: `/api/vars/${group.prefix}` })
        .use(authPlugin.plugin)
        .get("/", async () => ({ data: await group.get() }), { auth: true })
        .put("/", async ({ body }) => ({ data: await group.update(body) }), {
          auth: true,
          body: group.validation.partial(),
        });

      elysia().use(controller);
    }

    return {};
  };

  return fn;
});

export default vars;
