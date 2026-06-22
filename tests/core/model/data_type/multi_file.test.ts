import { beforeAll, describe, expect, it } from "bun:test";
import { multiFile } from "@njin/core/model/data_type/multi_file";
import elysia from "@njin/modules/elysia";
import fileModule from "@njin/modules/file";
import { RecordId } from "surrealdb";

beforeAll(async () => {
  elysia.init();
  await fileModule.init();
});

describe("multiFile", () => {
  it("transforms an array of string ids into RecordId instances", () => {
    const result = multiFile({ label: "Gallery" }).parse(["a", "b"]) as unknown[];
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(RecordId);
  });

  it("wraps a single non-array value into a one-item array", () => {
    expect(multiFile({ label: "Gallery" }).parse("solo")).toHaveLength(1);
  });

  it("rejects missing value by default (required)", () => {
    expect(multiFile({ label: "Gallery" }).safeParse(undefined).success).toBe(false);
  });

  it("supports chained validators (.min/.max)", () => {
    const schema = multiFile({ label: "Gallery" }, (z) => z.min(1).max(2));
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.parse(["a", "b"])).toHaveLength(2);
  });

  it("carries renderAs: multi_file and model: file through to meta (regression: model used to get dropped)", () => {
    expect(multiFile({ label: "Gallery" }).meta()).toMatchObject({
      label: "Gallery",
      renderAs: "multi_file",
      model: "file",
    });
  });
});
