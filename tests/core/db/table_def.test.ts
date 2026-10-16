import { describe, expect, it } from "bun:test";
import z from "zod";
import type { FieldDef } from "../../../src/core/db/contract";
import { fieldsFromSchema } from "../../../src/core/db/table_def";
import { makeModel } from "../../../src/core/model";
import { array } from "../../../src/core/model/data_type/array";
import { boolean } from "../../../src/core/model/data_type/boolean";
import { date } from "../../../src/core/model/data_type/date";
import { email } from "../../../src/core/model/data_type/email";
import { numeric } from "../../../src/core/model/data_type/numeric";
import { object } from "../../../src/core/model/data_type/object";
import { relation } from "../../../src/core/model/data_type/relation";
import { relationMany } from "../../../src/core/model/data_type/relation_many";
import { richtext } from "../../../src/core/model/data_type/richtext";
import { select } from "../../../src/core/model/data_type/select";
import { text } from "../../../src/core/model/data_type/text";

const field = (fields: FieldDef[], name: string) =>
  fields.find((f) => f.name === name);

const target = makeModel("table_def_target", {
  name: "Target",
  searchFields: [],
  schema: z.object({ title: text({ label: "Title" }) }),
});

describe("fieldsFromSchema", () => {
  it("maps the scalar data types", () => {
    const fields = fieldsFromSchema(
      z.object({
        title: text({ label: "T" }),
        body: richtext({ label: "B" }),
        views: numeric({ label: "V" }),
        live: boolean({ label: "L" }),
        publishedAt: date({ label: "P" }),
        mail: email({ label: "M" }),
        status: select({ label: "S" }, ["draft", "live"] as const),
      }),
    );

    expect(field(fields, "title")).toEqual({
      name: "title",
      kind: "scalar",
      type: "string",
    });
    expect(field(fields, "body")).toMatchObject({ type: "string" });
    expect(field(fields, "views")).toMatchObject({ type: "number" });
    expect(field(fields, "live")).toMatchObject({ type: "boolean" });
    expect(field(fields, "publishedAt")).toMatchObject({ type: "datetime" });
    expect(field(fields, "mail")).toMatchObject({ type: "string" });
    expect(field(fields, "status")).toMatchObject({
      type: "string",
      options: ["draft", "live"],
    });
  });

  it("sees through optional, nullable, default and transform layers", () => {
    const fields = fieldsFromSchema(
      z.object({
        a: text({ label: "A" }, (z) => z.optional()),
        b: numeric({ label: "B" }, (z) => z.default(1)),
        c: text({ label: "C" }, (z) => z.transform((v) => v.toUpperCase())),
        d: z.string().nullable().optional(),
        e: z.coerce.number(),
      }),
    );

    expect(fields.map((f) => [f.name, (f as { type?: string }).type])).toEqual([
      ["a", "string"],
      ["b", "number"],
      ["c", "string"],
      ["d", "string"],
      ["e", "number"],
    ]);
  });

  it("flags unique scalar fields", () => {
    const fields = fieldsFromSchema(
      z.object({
        mail: email({ label: "M", unique: true }),
        name: text({ label: "N" }),
      }),
    );

    expect(field(fields, "mail")).toMatchObject({ unique: true });
    expect(field(fields, "name")).not.toHaveProperty("unique");
  });

  it("maps relation and relationMany to a link to the target table", () => {
    const fields = fieldsFromSchema(
      z.object({
        author: relation({ label: "A" }, target),
        tags: relationMany({ label: "T" }, target),
      }),
    );

    expect(field(fields, "author")).toEqual({
      name: "author",
      kind: "one",
      target: "table_def_target",
    });
    expect(field(fields, "tags")).toEqual({
      name: "tags",
      kind: "many",
      target: "table_def_target",
    });
  });

  it("maps object() to a structured object field, recursively", () => {
    const fields = fieldsFromSchema(
      z.object({
        seo: object(
          { label: "SEO" },
          {
            title: text({ label: "T" }),
            og: object({ label: "OG" }, { image: text({ label: "I" }) }),
          },
        ),
      }),
    );

    expect(field(fields, "seo")).toEqual({
      name: "seo",
      kind: "object",
      fields: [
        { name: "title", kind: "scalar", type: "string" },
        {
          name: "og",
          kind: "object",
          fields: [{ name: "image", kind: "scalar", type: "string" }],
        },
      ],
    });
  });

  it("maps array() to a structured array whose element is described too", () => {
    const fields = fieldsFromSchema(
      z.object({
        tags: array({ label: "T" }, z.string()),
        items: array(
          { label: "I" },
          z.object({ sku: z.string(), qty: z.number() }),
        ),
        matrix: array({ label: "M" }, z.array(z.number())),
        links: array({ label: "L" }, relation({ label: "R" }, target)),
      }),
    );

    expect(field(fields, "tags")).toEqual({
      name: "tags",
      kind: "array",
      of: { kind: "scalar", type: "string" },
    });
    expect(field(fields, "items")).toEqual({
      name: "items",
      kind: "array",
      of: {
        kind: "object",
        fields: [
          { name: "sku", kind: "scalar", type: "string" },
          { name: "qty", kind: "scalar", type: "number" },
        ],
      },
    });
    expect(field(fields, "matrix")).toEqual({
      name: "matrix",
      kind: "array",
      of: { kind: "array", of: { kind: "scalar", type: "number" } },
    });
    expect(field(fields, "links")).toEqual({
      name: "links",
      kind: "array",
      of: { kind: "one", target: "table_def_target" },
    });
  });

  it("falls back to json only for a shape that has none", () => {
    const fields = fieldsFromSchema(
      z.object({
        anything: z.any(),
        bag: z.record(z.string(), z.string()),
      }),
    );

    expect(field(fields, "anything")).toMatchObject({ type: "json" });
    expect(field(fields, "bag")).toMatchObject({ type: "json" });
  });

  it("is what makeModel exposes as the table definition", () => {
    const model = makeModel("table_def_model", {
      name: "M",
      searchFields: ["title"],
      schema: z.object({
        title: text({ label: "T" }),
        author: relation({ label: "A" }, target),
      }),
    });

    expect(model.def.name).toBe("table_def_model");
    expect(model.def.fields.map((f) => f.name)).toEqual(["title", "author"]);
    expect(model.def.search).toEqual([
      { table: "table_def_model", field: "title" },
    ]);
  });
});
