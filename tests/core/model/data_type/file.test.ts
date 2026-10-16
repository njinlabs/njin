import { beforeAll, describe, expect, it } from "bun:test";
import { loadConfig } from "../../../../src/core/config";
import { file } from "../../../../src/core/model/data_type/file";
import elysia from "../../../../src/modules/elysia";
import fileModule from "../../../../src/modules/file";

// file() reads the file module's internal model lazily, so the module must be
// initialized first — registering routes here has no network/DB side effects
// (no .listen(), no db connection). models/file.ts reads the configured
// adapter via getConfig(), so config must be loaded first too.
beforeAll(async () => {
  await loadConfig();
  elysia.init();
  await fileModule.init();
});

describe("file", () => {
  it("keeps a plain string id as the plain string id", () => {
    expect(file({ label: "Thumbnail" }).parse("abc123")).toBe("abc123");
  });

  it("rejects missing value by default (required)", () => {
    expect(file({ label: "Thumbnail" }).safeParse(undefined).success).toBe(
      false,
    );
  });

  it("supports .optional()", () => {
    expect(
      file({ label: "Thumbnail" }, (z) => z.optional()).parse(undefined),
    ).toBeUndefined();
  });

  it("carries renderAs: file and model: file through to meta (regression: model used to get dropped)", () => {
    expect(file({ label: "Thumbnail" }).meta()).toMatchObject({
      label: "Thumbnail",
      renderAs: "file",
      model: "file",
    });
  });
});
