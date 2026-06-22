import { describe, expect, it } from "bun:test";
import { numeric } from "@njin/core/model/data_type/numeric";

describe("numeric", () => {
  it("accepts a number", () => {
    expect(numeric({ label: "Price" }).parse(10)).toBe(10);
  });

  it("rejects missing value by default (required)", () => {
    expect(numeric({ label: "Price" }).safeParse(undefined).success).toBe(false);
  });

  it("does not coerce numeric strings (no string -> number coercion)", () => {
    expect(numeric({ label: "Price" }).safeParse("10").success).toBe(false);
  });

  it("supports chained validators (.min/.max/.int)", () => {
    const schema = numeric({ label: "Rating" }, (z) => z.min(0).max(5).int());
    expect(schema.safeParse(-1).success).toBe(false);
    expect(schema.safeParse(6).success).toBe(false);
    expect(schema.safeParse(2.5).success).toBe(false);
    expect(schema.parse(3)).toBe(3);
  });

  it("supports .default() to make the field effectively optional", () => {
    expect(numeric({ label: "Quantity" }, (z) => z.int().nonnegative().default(0)).parse(undefined)).toBe(0);
  });

  it("carries label/renderAs through to meta", () => {
    expect(numeric({ label: "Price" }).meta()).toMatchObject({ label: "Price", renderAs: "numeric" });
  });
});
