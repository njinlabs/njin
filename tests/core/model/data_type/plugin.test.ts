import { describe, expect, it } from "bun:test";
import z from "zod";
import { toAdminSchema } from "../../../../src/core/model/admin_schema";
import { plugin } from "../../../../src/core/model/data_type/plugin";
import { text } from "../../../../src/core/model/data_type/text";

describe("plugin", () => {
  const slug = () =>
    plugin(text({ label: "Slug" }), ["reports:slugify", { from: "title" }]);

  it("validates as the type it wraps", () => {
    expect(slug().parse("hello")).toBe("hello");
    expect(slug().safeParse(undefined).success).toBe(false);
  });

  it("keeps the type's own meta and adds the renderer and its options", () => {
    expect(slug().meta()).toMatchObject({
      label: "Slug",
      renderAs: "text",
      plugin: ["reports:slugify", { from: "title" }],
    });
  });

  it("reaches the admin's JSON schema", () => {
    const json = toAdminSchema(z.object({ slug: slug() })) as any;

    expect(json.properties.slug.renderAs).toBe("text");
    expect(json.properties.slug.plugin).toEqual([
      "reports:slugify",
      { from: "title" },
    ]);
  });

  it("takes no options", () => {
    expect(plugin(text({ label: "A" }), ["reports:a"]).meta()?.plugin).toEqual([
      "reports:a",
      undefined,
    ]);
  });

  it("refuses a name that is not <plugin>:<renderer>", () => {
    for (const name of ["slugify", "Reports:slugify", "reports:", ":x"]) {
      expect(() => plugin(text({ label: "A" }), [name])).toThrow(
        "Invalid plugin renderer",
      );
    }
  });
});
