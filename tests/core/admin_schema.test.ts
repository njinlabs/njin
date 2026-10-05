import { describe, expect, it } from "bun:test";
import z from "zod";
import { toAdminSchema } from "../../src/core/admin_schema";

const schema = z.object({
  title: z.string(),
  author: z.string().meta({ renderAs: "relation", model: "author" }),
  reviewers: z
    .array(z.string())
    .meta({ renderAs: "multi_relation", model: "author" }),
  cover: z.string().meta({ renderAs: "file", model: "file" }),
  gallery: z.array(z.string()).meta({ renderAs: "multi_file", model: "file" }),
  secret: z.string().meta({ hideForm: true }),
});

const props = (forAgent: boolean) =>
  (toAdminSchema(schema, { forAgent }) as any).properties;

describe("toAdminSchema — admin panel shape (default)", () => {
  it("keeps a single relation as an { id } object, which the panel's form expects", () => {
    expect(props(false).author.type).toBe("object");
    expect(props(false).author.properties.id.type).toBe("string");
  });

  it("drops hideForm fields", () => {
    expect(props(false).secret).toBeUndefined();
  });
});

describe("toAdminSchema — forAgent", () => {
  it("describes a relation as the target's id string, not an object", () => {
    expect(props(true).author.type).toBe("string");
    expect(props(true).author.properties).toBeUndefined();
    expect(props(true).author.required).toBeUndefined();
    expect(props(true).author.description).toContain('"author"');
    expect(props(true).author.description).toContain("plain string");
  });

  it("describes a file the same way", () => {
    expect(props(true).cover.type).toBe("string");
    expect(props(true).cover.description).toContain('"file"');
  });

  it("describes multi relations and multi files as arrays of id strings", () => {
    for (const field of ["reviewers", "gallery"]) {
      expect(props(true)[field].type).toBe("array");
      expect(props(true)[field].items).toEqual({ type: "string" });
    }
  });

  it("leaves ordinary fields alone and still drops hideForm fields", () => {
    expect(props(true).title.type).toBe("string");
    expect(props(true).secret).toBeUndefined();
  });
});
