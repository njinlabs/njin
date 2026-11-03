import type z from "zod";

// What a plugin's admin renderer is called: "<plugin>:<renderer>" ("reports:slugify"). The plugin
// is the `name` of its admin side, the renderer a key of its `fields`.
const NAME = /^[a-z0-9][a-z0-9-]*:[A-Za-z0-9_-]+$/;

// A field drawn by an admin plugin's own input. The type underneath keeps validating and
// storing the value, and is what the admin draws if no plugin registered that renderer; the
// pair travels with the field's meta as `plugin: [name, options]`.
//
//   slug: plugin(text({ label: "Slug" }), ["reports:slugify", { from: "title" }])
export const plugin = <T extends z.ZodTypeAny>(
  type: T,
  [name, options]: [name: string, options?: unknown],
): T => {
  if (!NAME.test(name)) {
    throw new Error(
      `Invalid plugin renderer "${name}" — expected "<plugin>:<renderer>", such as "reports:slugify".`,
    );
  }

  return type.meta({ ...type.meta(), plugin: [name, options] }) as T;
};
