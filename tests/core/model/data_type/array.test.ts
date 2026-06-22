import { describe, expect, it } from "bun:test";
import { array } from "@njin/core/model/data_type/array";
import { numeric } from "@njin/core/model/data_type/numeric";
import { text } from "@njin/core/model/data_type/text";

describe("array", () => {
  it("accepts an array of the item type", () => {
    expect(array({ label: "Tags" }, text({ label: "Tag" })).parse(["a", "b"])).toEqual(["a", "b"]);
  });

  it("wraps a single non-array value into a one-item array", () => {
    expect(array({ label: "Tags" }, text({ label: "Tag" })).parse("solo")).toEqual(["solo"]);
  });

  it("rejects missing value by default (required)", () => {
    expect(array({ label: "Tags" }, text({ label: "Tag" })).safeParse(undefined).success).toBe(false);
  });

  it("validates each item against the item schema", () => {
    expect(array({ label: "Scores" }, numeric({ label: "Score" })).safeParse(["not-a-number"]).success).toBe(false);
  });

  it("supports chained validators (.min/.max) on the array itself", () => {
    const schema = array({ label: "Keywords" }, text({ label: "Keyword" }), (z) => z.min(1).max(2));
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse(["a", "b", "c"]).success).toBe(false);
    expect(schema.parse(["a", "b"])).toEqual(["a", "b"]);
  });

  it("supports .optional()", () => {
    expect(array({ label: "Scores" }, numeric({ label: "Score" }), (z) => z.optional()).parse(undefined)).toBeUndefined();
  });

  it("carries label/renderAs through to meta", () => {
    expect(array({ label: "Tags" }, text({ label: "Tag" })).meta()).toMatchObject({ label: "Tags", renderAs: "array" });
  });
});
