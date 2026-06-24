import { describe, expect, it } from "bun:test";
import { makeModel } from "../../../../src/core/model";
import { relationMany } from "../../../../src/core/model/data_type/relation_many";
import { text } from "../../../../src/core/model/data_type/text";
import { RecordId } from "surrealdb";
import z from "zod";

const target = makeModel("relation_many_test_target", {
  name: "Target",
  searchFields: ["title"],
  schema: z.object({ title: text({ label: "Title" }) }),
});

describe("relationMany", () => {
  it("transforms an array of string ids into RecordId instances", () => {
    const result = relationMany({ label: "Tags" }, target).parse(["a", "b"]) as unknown[];
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(RecordId);
  });

  it("wraps a single non-array value into a one-item array", () => {
    const result = relationMany({ label: "Tags" }, target).parse("solo") as unknown[];
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(RecordId);
  });

  it("allows an empty array", () => {
    expect(relationMany({ label: "Tags" }, target).parse([])).toEqual([]);
  });

  it("rejects missing value by default (required)", () => {
    expect(relationMany({ label: "Tags" }, target).safeParse(undefined).success).toBe(false);
  });

  it("carries renderAs/model through to meta", () => {
    expect(relationMany({ label: "Tags" }, target).meta()).toMatchObject({
      label: "Tags",
      renderAs: "multi_relation",
      model: "relation_many_test_target",
    });
  });
});
