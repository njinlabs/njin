import { describe, expect, it } from "bun:test";
import { object } from "../../../../src/core/model/data_type/object";
import { text } from "../../../../src/core/model/data_type/text";

describe("object", () => {
  it("accepts an object matching the shape", () => {
    const schema = object({ label: "SEO" }, { metaTitle: text({ label: "Meta Title" }) });
    expect(schema.parse({ metaTitle: "hi" })).toEqual({ metaTitle: "hi" });
  });

  it("rejects a missing required nested field", () => {
    const schema = object({ label: "SEO" }, { metaTitle: text({ label: "Meta Title" }) });
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("allows a nested field to be optional independently", () => {
    const schema = object(
      { label: "SEO" },
      {
        metaTitle: text({ label: "Meta Title" }),
        metaDescription: text({ label: "Meta Description" }, (z) => z.optional()),
      },
    );
    expect(schema.parse({ metaTitle: "hi" })).toEqual({ metaTitle: "hi" });
  });

  it("supports making the whole object optional via rule", () => {
    const schema = object({ label: "SEO" }, { metaTitle: text({ label: "Meta Title" }) }, (z) => z.optional());
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it("carries label/renderAs through to meta", () => {
    const schema = object({ label: "SEO" }, { metaTitle: text({ label: "Meta Title" }) });
    expect(schema.meta()).toMatchObject({ label: "SEO", renderAs: "object" });
  });
});
