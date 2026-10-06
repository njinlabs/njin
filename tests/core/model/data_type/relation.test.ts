import { describe, expect, it } from "bun:test";
import { RecordId } from "surrealdb";
import z from "zod";
import { makeModel } from "../../../../src/core/model";
import { relation } from "../../../../src/core/model/data_type/relation";
import { text } from "../../../../src/core/model/data_type/text";

const target = makeModel("relation_test_target", {
  name: "Target",
  searchFields: ["title"],
  schema: z.object({ title: text({ label: "Title" }) }),
});

describe("relation", () => {
  it("transforms a plain string id into a RecordId", () => {
    const result = relation({ label: "Category" }, target).parse("abc123");
    expect(result).toBeInstanceOf(RecordId);
    expect((result as RecordId).table.toString()).toBe("relation_test_target");
  });

  it("passes through an existing RecordId instance", () => {
    const id = new RecordId(target.table, "xyz789");
    expect(relation({ label: "Category" }, target).parse(id)).toBeInstanceOf(
      RecordId,
    );
  });

  it("passes an embedded object through unchanged instead of linking it", () => {
    const result = relation({ label: "Rel" }, target).parse({
      title: "inline",
    });
    expect(result as unknown).toEqual({ title: "inline" });
  });

  it("rejects missing value by default (required)", () => {
    expect(
      relation({ label: "Category" }, target).safeParse(undefined).success,
    ).toBe(false);
  });

  it("supports .optional()", () => {
    expect(
      relation({ label: "Category" }, target, (z) => z.optional()).parse(
        undefined,
      ),
    ).toBeUndefined();
  });

  it("carries renderAs/model through to meta", () => {
    expect(relation({ label: "Category" }, target).meta()).toMatchObject({
      label: "Category",
      renderAs: "relation",
      model: "relation_test_target",
    });
  });
});
