import { describe, expect, it } from "bun:test";
import { boolean } from "../../../../src/core/model/data_type/boolean";

describe("boolean", () => {
  it("accepts a real boolean", () => {
    expect(boolean({ label: "Featured" }).parse(true)).toBe(true);
    expect(boolean({ label: "Featured" }).parse(false)).toBe(false);
  });

  it("rejects missing value by default (required)", () => {
    expect(boolean({ label: "Featured" }).safeParse(undefined).success).toBe(false);
  });

  it("does not coerce string/number values (no \"true\"/1 coercion)", () => {
    expect(boolean({ label: "Featured" }).safeParse("true").success).toBe(false);
    expect(boolean({ label: "Featured" }).safeParse(1).success).toBe(false);
  });

  it("supports .default() to make the field effectively optional", () => {
    expect(boolean({ label: "Featured" }, (z) => z.default(false)).parse(undefined)).toBe(false);
  });

  it("supports .optional()", () => {
    expect(boolean({ label: "Archived" }, (z) => z.optional()).parse(undefined)).toBeUndefined();
  });

  it("carries label/renderAs through to meta", () => {
    expect(boolean({ label: "Featured" }).meta()).toMatchObject({ label: "Featured", renderAs: "boolean" });
  });
});
