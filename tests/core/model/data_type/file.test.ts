import { beforeAll, describe, expect, it } from "bun:test";
import { file } from "@njin/core/model/data_type/file";
import elysia from "@njin/modules/elysia";
import fileModule from "@njin/modules/file";
import { RecordId } from "surrealdb";

// file() reads the file module's internal model lazily, so the module must be
// initialized first — registering routes here has no network/DB side effects
// (no .listen(), no surreal connection).
beforeAll(async () => {
  elysia.init();
  await fileModule.init();
});

describe("file", () => {
  it("transforms a plain string id into a RecordId", () => {
    expect(file({ label: "Thumbnail" }).parse("abc123")).toBeInstanceOf(RecordId);
  });

  it("rejects missing value by default (required)", () => {
    expect(file({ label: "Thumbnail" }).safeParse(undefined).success).toBe(false);
  });

  it("supports .optional()", () => {
    expect(file({ label: "Thumbnail" }, (z) => z.optional()).parse(undefined)).toBeUndefined();
  });

  it("carries renderAs: file and model: file through to meta (regression: model used to get dropped)", () => {
    expect(file({ label: "Thumbnail" }).meta()).toMatchObject({
      label: "Thumbnail",
      renderAs: "file",
      model: "file",
    });
  });
});
