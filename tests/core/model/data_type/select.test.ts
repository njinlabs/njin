import { describe, expect, it } from "bun:test";
import { select } from "../../../../src/core/model/data_type/select";

describe("select", () => {
  it("accepts one of the given options", () => {
    expect(select({ label: "Status" }, ["DRAFT", "PUBLISH"]).parse("PUBLISH")).toBe("PUBLISH");
  });

  it("rejects a value outside the options", () => {
    expect(select({ label: "Status" }, ["DRAFT", "PUBLISH"]).safeParse("ARCHIVED").success).toBe(false);
  });

  it("rejects missing value by default (required)", () => {
    expect(select({ label: "Status" }, ["DRAFT", "PUBLISH"]).safeParse(undefined).success).toBe(false);
  });

  it("supports .default() to make the field effectively optional", () => {
    expect(select({ label: "Priority" }, ["LOW", "MEDIUM", "HIGH"], (z) => z.default("MEDIUM")).parse(undefined)).toBe(
      "MEDIUM",
    );
  });

  it("carries label/renderAs through to meta", () => {
    expect(select({ label: "Status" }, ["DRAFT", "PUBLISH"]).meta()).toMatchObject({
      label: "Status",
      renderAs: "select",
    });
  });
});
