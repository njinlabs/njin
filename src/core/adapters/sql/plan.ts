import { createHash } from "node:crypto";
import type {
  ElementDef,
  FieldDef,
  ScalarType,
  TableDef,
} from "../../db/contract";

// Turns a TableDef into the physical layout a SQL database needs. It knows nothing about any one
// SQL dialect — column types stay abstract (ScalarType) and the dialect module maps them — so a
// Postgres, MySQL or SQLite adapter all share it.
//
// The layout follows the shape of the data instead of storing JSON:
//   scalar            -> a column
//   one (relation)    -> a text column holding the target's id
//   object            -> its fields flattened into columns on the same row: seo__title
//   many (relation)   -> a pivot table: (_parent, _pos, target)
//   array             -> a child table: (_id, _parent, _pos, ...element columns); an array of
//                        objects flattens each object into the child's columns, an array of
//                        arrays chains another child table
// Every child and pivot row also carries `_owner`, the id of the root row it ultimately belongs
// to, so deleting a row (or replacing one of its arrays) never has to chase parents.

// Physical identifiers are capped (Postgres allows 63 bytes); a longer one is cut and given a
// hash suffix of the full name so two long names can't collapse into the same one.
const MAX_IDENTIFIER = 63;

export const physicalName = (name: string) =>
  name.length <= MAX_IDENTIFIER
    ? name
    : `${name.slice(0, MAX_IDENTIFIER - 9)}_${createHash("sha1").update(name).digest("hex").slice(0, 8)}`;

export type Column = {
  // Physical column name.
  name: string;
  type: ScalarType;
  // Where the value sits in the row object, relative to the body it belongs to
  // (["seo", "title"] for a flattened seo.title). Empty for an array element's own value.
  path: string[];
  // For a one() column: the table it links to.
  link?: string;
  unique?: boolean;
};

export type Pivot = {
  table: string;
  path: string[];
  target: string;
};

// Anything that holds fields: the root row, or one element of an array of objects.
export type Body = {
  columns: Column[];
  arrays: ArrayPlan[];
  pivots: Pivot[];
  // Paths of object() fields that were flattened into `columns`, deepest last — needed to fold
  // an object whose columns are all empty back into null when reading.
  objects: string[][];
};

export type ArrayPlan = Body & {
  table: string;
  // Key of the array inside its body; empty when it is the element of an outer array.
  path: string[];
  shape: "scalar" | "object" | "array";
};

export type TablePlan = Body & {
  name: string;
  def: TableDef;
  // A free-form document table: undeclared keys live together in a JSON column.
  document: boolean;
};

const reserved = new Set(["id", "createdAt", "updatedAt", "data"]);

const emptyBody = (): Body => ({
  columns: [],
  arrays: [],
  pivots: [],
  objects: [],
});

const fillBody = (
  body: Body,
  owner: string,
  fields: readonly FieldDef[],
  path: string[],
  prefix: string,
  isRoot: boolean,
) => {
  for (const field of fields) {
    const here = [...path, field.name];
    const column = prefix + field.name;

    if (isRoot && reserved.has(column)) {
      throw new Error(
        `Table "${owner}": field "${field.name}" collides with a built-in column name.`,
      );
    }

    switch (field.kind) {
      case "scalar":
        body.columns.push({
          name: physicalName(column),
          type: field.type,
          path: here,
          unique: field.unique,
        });
        break;
      case "one":
        body.columns.push({
          name: physicalName(column),
          type: "string",
          path: here,
          link: field.target,
        });
        break;
      case "many":
        body.pivots.push({
          table: physicalName(`${owner}__${here.join("__")}`),
          path: here,
          target: field.target,
        });
        break;
      case "object":
        body.objects.push(here);
        fillBody(body, owner, field.fields, here, `${column}__`, isRoot);
        break;
      case "array":
        body.arrays.push(planArray(owner, here, field.of));
        break;
    }
  }
};

const planArray = (
  owner: string,
  path: string[],
  of: ElementDef,
): ArrayPlan => {
  const table = physicalName(
    `${owner}__${path.length ? path.join("__") : "item"}`,
  );
  const plan: ArrayPlan = { ...emptyBody(), table, path, shape: "scalar" };

  switch (of.kind) {
    case "scalar":
      plan.columns.push({ name: "value", type: of.type, path: [] });
      break;
    case "one":
      plan.columns.push({
        name: "value",
        type: "string",
        path: [],
        link: of.target,
      });
      break;
    case "object":
      plan.shape = "object";
      fillBody(plan, table, of.fields, [], "", false);
      break;
    case "array":
      plan.shape = "array";
      plan.arrays.push(planArray(table, [], of.of));
      break;
  }

  return plan;
};

export const planTable = (def: TableDef): TablePlan => {
  const plan: TablePlan = {
    ...emptyBody(),
    name: def.name,
    def,
    document: def.document === true,
  };
  fillBody(plan, def.name, def.fields, [], "", true);
  return plan;
};

// Every child table under a body, depth first.
export const descendantArrays = (body: Body): ArrayPlan[] =>
  body.arrays.flatMap((array) => [array, ...descendantArrays(array)]);

// Every pivot under a body, including those inside array elements.
export const descendantPivots = (body: Body): Pivot[] => [
  ...body.pivots,
  ...descendantArrays(body).flatMap((array) => array.pivots),
];

// The value at `path` inside `data`, and whether the caller supplied one at all. An explicit
// null anywhere above the path clears everything below it, so it reads as "supplied, null".
export const lookup = (
  data: unknown,
  path: readonly string[],
): { found: boolean; value: unknown } => {
  let current: unknown = data;

  for (const key of path) {
    if (current === null) return { found: true, value: null };
    if (current === undefined || typeof current !== "object") {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[key];
    if (current === undefined) return { found: false, value: undefined };
  }

  return current === undefined
    ? { found: false, value: undefined }
    : { found: true, value: current };
};

export const setPath = (
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
) => {
  let current = target;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (next === null || typeof next !== "object") current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1] as string] = value;
};

const getPath = (target: Record<string, unknown>, path: readonly string[]) => {
  let current: unknown = target;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

// A flattened object whose every value is empty can't be told apart from an absent one, so it
// reads back as null (the deepest objects first, so a parent made only of empty children folds
// too).
export const foldEmptyObjects = (
  body: Pick<Body, "objects">,
  row: Record<string, unknown>,
) => {
  const empty = (value: unknown) =>
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value as object).every(empty));

  for (const path of [...body.objects].sort((a, b) => b.length - a.length)) {
    if (empty(getPath(row, path))) setPath(row, path, null);
  }
};
