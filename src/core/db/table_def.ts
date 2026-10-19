import type { z } from "zod";
import type { ElementDef, FieldDef, ScalarType } from "./contract";

// Turns a model's Zod schema into the structural FieldDef list adapters work from. Zod wraps
// fields in layers (optional/nullable/default, a preprocess or transform pipe, a .meta() tag),
// so the walk below peels those off to find the layer that actually describes the field — the
// njin data-type helpers tag theirs with `renderAs`, a bare Zod type (an array() element
// like z.string()) is read from its Zod type instead.

type Meta = {
  renderAs?: string;
  model?: string;
  unique?: boolean;
  localized?: boolean;
};

type AnyZod = any;

const metaOf = (schema: AnyZod): Meta | undefined =>
  typeof schema?.meta === "function" ? schema.meta() : undefined;

const defOf = (schema: AnyZod) => schema?.def ?? schema?._zod?.def;

// One layer down, if this is a wrapper. A preprocess is pipe(transform, real) and a
// post-transform is pipe(real, transform), so the real side is whichever isn't the transform.
const inner = (schema: AnyZod): AnyZod | undefined => {
  const def = defOf(schema);
  if (!def) return undefined;
  if (def.innerType) return def.innerType;
  if (def.type === "pipe") {
    return defOf(def.in)?.type === "transform" ? def.out : def.in;
  }
  return undefined;
};

const find = (schema: AnyZod, test: (layer: AnyZod) => boolean) => {
  let current = schema;
  for (let i = 0; current && i < 32; i += 1) {
    if (test(current)) return current;
    current = inner(current);
  }
  return undefined;
};

const innermost = (schema: AnyZod) => {
  let current = schema;
  for (let i = 0; i < 32; i += 1) {
    const next = inner(current);
    if (!next) return current;
    current = next;
  }
  return current;
};

const scalar = (type: ScalarType, extra?: { options?: readonly string[] }) =>
  ({ kind: "scalar", type, ...extra }) as const;

// Omit<> on a union collapses it to the members' common keys; this keeps each member intact.
type Shape = FieldDef extends infer F
  ? F extends unknown
    ? Omit<F, "name">
    : never
  : never;

const objectFields = (objectSchema: AnyZod): FieldDef[] =>
  Object.entries(objectSchema.shape as Record<string, AnyZod>).map(
    ([name, value]) => ({ name, ...shapeOf(value) }) as FieldDef,
  );

const shapeOf = (schema: AnyZod): Shape => {
  const tagged = find(schema, (layer) => Boolean(metaOf(layer)?.renderAs));
  const meta = tagged ? metaOf(tagged) : undefined;

  switch (meta?.renderAs) {
    case "relation":
    case "file":
      return { kind: "one", target: meta.model as string };
    case "multi_relation":
    case "multi_file":
      return { kind: "many", target: meta.model as string };
    case "datepicker":
      return scalar("datetime");
    case "numeric":
      return scalar("number");
    case "boolean":
      return scalar("boolean");
    case "select": {
      const enumLayer = find(tagged, (l) => defOf(l)?.type === "enum");
      const options = enumLayer
        ? Object.values(defOf(enumLayer).entries as Record<string, string>)
        : undefined;
      return scalar("string", { options });
    }
    case "text":
    case "richtext":
      return scalar("string");
    case "array": {
      const array = find(tagged, (l) => defOf(l)?.type === "array");
      return array
        ? { kind: "array", of: shapeOf(defOf(array).element) as ElementDef }
        : scalar("json");
    }
    case "object": {
      const object = find(tagged, (l) => defOf(l)?.type === "object");
      return object
        ? { kind: "object", fields: objectFields(object) }
        : scalar("json");
    }
  }

  // No njin tag: read the plain Zod type underneath.
  const core = innermost(schema);
  const def = defOf(core);

  switch (def?.type) {
    case "string":
      return scalar("string");
    case "number":
    case "int":
      return scalar("number");
    case "boolean":
      return scalar("boolean");
    case "date":
      return scalar("datetime");
    case "enum":
      return scalar("string", {
        options: Object.values(def.entries as Record<string, string>),
      });
    case "literal": {
      const first = (def.values as unknown[])[0];
      return scalar(
        typeof first === "number"
          ? "number"
          : typeof first === "boolean"
            ? "boolean"
            : "string",
      );
    }
    case "array":
      return { kind: "array", of: shapeOf(def.element) as ElementDef };
    case "object":
      return { kind: "object", fields: objectFields(core) };
    default:
      // z.any(), z.record(), mixed unions, a bare transform: no fixed shape to give columns.
      return scalar("json");
  }
};

// The njin metadata of a field (its label, renderAs, unique, localized...), wherever in the
// Zod wrappers it was attached.
export const fieldMeta = (schema: AnyZod): Record<string, unknown> => {
  const tagged = find(schema, (layer) => Boolean(metaOf(layer)?.renderAs));
  return (tagged ? metaOf(tagged) : undefined) ?? {};
};

// `unique: false` leaves the unique flag off every field (a table whose uniqueness is enforced
// some other way).
export const fieldsFromSchema = (
  schema: z.ZodObject,
  options: { unique?: boolean } = {},
): FieldDef[] =>
  Object.entries(schema.shape as Record<string, AnyZod>).map(
    ([name, value]) => {
      const shape = shapeOf(value);
      const tagged = find(value, (layer) => Boolean(metaOf(layer)?.renderAs));
      const unique =
        options.unique !== false && tagged
          ? metaOf(tagged)?.unique === true
          : false;

      return (
        shape.kind === "scalar" && unique
          ? { name, ...shape, unique: true }
          : { name, ...shape }
      ) as FieldDef;
    },
  );
