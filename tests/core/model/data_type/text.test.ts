import { describe, expect, it } from "bun:test";
import { text } from "@njin/core/model/data_type/text";

describe("text", () => {
  it("accepts a string", () => {
    expect(text({ label: "Title" }).parse("hello")).toBe("hello");
  });

  it("rejects missing value by default (required)", () => {
    expect(text({ label: "Title" }).safeParse(undefined).success).toBe(false);
  });

  it("treats empty string as absent via preprocess — still fails required validation", () => {
    expect(text({ label: "Title" }).safeParse("").success).toBe(false);
  });

  it("allows opting out of required via rule", () => {
    expect(text({ label: "Title" }, (z) => z.optional()).parse(undefined)).toBeUndefined();
  });

  it("supports chained validators (.min/.max) on the underlying ZodString", () => {
    const schema = text({ label: "Title" }, (z) => z.min(3).max(5));
    expect(schema.safeParse("ab").success).toBe(false);
    expect(schema.parse("abcd")).toBe("abcd");
    expect(schema.safeParse("abcdef").success).toBe(false);
  });

  it("carries label/unique/renderAs through to meta", () => {
    expect(text({ label: "Slug", unique: true }).meta()).toMatchObject({
      label: "Slug",
      unique: true,
      renderAs: "text",
    });
  });
});
