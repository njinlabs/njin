import { describe, expect, it } from "bun:test";
import { richtext } from "@njin/core/model/data_type/richtext";

describe("richtext", () => {
  it("accepts an HTML string", () => {
    expect(richtext({ label: "Body" }).parse("<p>hi</p>")).toBe("<p>hi</p>");
  });

  it("rejects missing value by default (required)", () => {
    expect(richtext({ label: "Body" }).safeParse(undefined).success).toBe(false);
  });

  it("allows opting out of required via rule", () => {
    expect(richtext({ label: "Body" }, (z) => z.optional()).parse(undefined)).toBeUndefined();
  });

  it("supports chained validators on the underlying ZodString", () => {
    const schema = richtext({ label: "Body" }, (z) => z.max(5));
    expect(schema.safeParse("toolong").success).toBe(false);
    expect(schema.parse("ok")).toBe("ok");
  });

  it("carries renderAs: richtext through to meta (distinct from text)", () => {
    expect(richtext({ label: "Body" }).meta()).toMatchObject({ label: "Body", renderAs: "richtext" });
  });
});
