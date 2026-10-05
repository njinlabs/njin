import type z from "zod";

// Removes fields marked hideForm: true from a JSON schema's properties/required,
// recursing into nested object/array shapes so hidden fields never reach the admin panel.
const stripHiddenFields = (node: any): void => {
  if (!node || typeof node !== "object") return;

  if (node.properties) {
    for (const [key, prop] of Object.entries(
      node.properties as Record<string, any>,
    )) {
      if (prop?.hideForm) {
        delete node.properties[key];
        if (Array.isArray(node.required)) {
          node.required = node.required.filter((r: string) => r !== key);
        }
      } else {
        stripHiddenFields(prop);
      }
    }
  }

  if (node.items) stripHiddenFields(node.items);
};

// Shared by both models and vars groups on the /api/schema endpoint — strips
// non-JSON-representable renderAs types (relation/multi_relation/file) into
// plain JSON-schema shapes the admin panel can render a form from, and drops
// any field marked hideForm: true so it never reaches the admin panel.
export const toAdminSchema = (schema: z.ZodObject) => {
  const jsonSchema = schema.toJSONSchema({
    unrepresentable: "any",
    override: (ctx) => {
      if (ctx.jsonSchema.renderAs === "relation") {
        ctx.jsonSchema.type = "object";
        ctx.jsonSchema.properties = {
          id: {
            type: "string",
          },
        };
        ctx.jsonSchema.required = ["id"];
        ctx.jsonSchema.additionalProperties = {};
      } else if (ctx.jsonSchema.renderAs === "multi_relation") {
        (ctx.jsonSchema.items! as any).type = "string";
      } else if (ctx.jsonSchema.renderAs === "file") {
        ctx.jsonSchema.type = "string";
      }
    },
  });

  stripHiddenFields(jsonSchema);

  return jsonSchema;
};
