import type z from "zod";
import type { Condition } from "./db/contract";

// Permission engine. Pure: it knows grant strings, token scopes and the relation graph between
// models, never the database or a request — callers (core/guarded.ts) feed it a user's grants and
// act on the answer.
//
// A grant is "<resource>:<action>[:<scope>]":
//   resource  a model prefix, "vars.<prefix>", "file", "user", "access_group", "analytics", or "*"
//   action    read | create | update | delete | publish (models), read | write (vars), or "*"
//   scope     "own" (rows whose createdBy is the caller) or "all" (the default)
// Grants only add up; there is no deny.

export type Level = "ref" | "own" | "all";

export const MODEL_ACTIONS = [
  "read",
  "create",
  "update",
  "delete",
  "publish",
] as const;
export const VARS_ACTIONS = ["read", "write"] as const;

const VARS_PREFIX = "vars.";

export const isVarsResource = (resource: string) =>
  resource.startsWith(VARS_PREFIX);

export type Grant = { resource: string; action: string; scope: "own" | "all" };

export const parseGrant = (value: string): Grant | null => {
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) return null;

  const [resource, action, scope = "all"] = parts;
  if (!resource || !action || (scope !== "own" && scope !== "all")) {
    return null;
  }

  return { resource, action, scope };
};

export type CatalogEntry = {
  resource: string;
  actions: readonly string[];
  // Whether "own" means anything here: vars groups and analytics have no per-row owner.
  scoped: boolean;
};

export const buildCatalog = (input: {
  models: { prefix: string; draftable?: boolean }[];
  vars: string[];
}): CatalogEntry[] => [
  ...input.models.map(({ prefix, draftable }) => ({
    resource: prefix,
    actions: draftable
      ? MODEL_ACTIONS
      : MODEL_ACTIONS.filter((action) => action !== "publish"),
    scoped: true,
  })),
  ...input.vars.map((prefix) => ({
    resource: `${VARS_PREFIX}${prefix}`,
    actions: VARS_ACTIONS,
    scoped: false,
  })),
  { resource: "file", actions: ["read", "create", "delete"], scoped: true },
  {
    resource: "user",
    actions: ["read", "create", "update", "delete"],
    scoped: true,
  },
  {
    resource: "access_group",
    actions: ["read", "create", "update", "delete"],
    scoped: true,
  },
  { resource: "analytics", actions: ["read"], scoped: false },
];

// Human-readable problems, empty when every grant is valid for this catalog.
export const validateGrants = (
  grants: readonly string[],
  catalog: readonly CatalogEntry[],
) => {
  const errors: string[] = [];
  const byResource = new Map(catalog.map((entry) => [entry.resource, entry]));
  const everyAction = new Set(catalog.flatMap((entry) => entry.actions));

  for (const raw of grants) {
    const grant = parseGrant(raw);
    if (!grant) {
      errors.push(`"${raw}" is not a valid grant`);
      continue;
    }

    if (grant.resource === "*") {
      if (grant.action !== "*" && !everyAction.has(grant.action)) {
        errors.push(`"${raw}": unknown action "${grant.action}"`);
      }
      continue;
    }

    const entry = byResource.get(grant.resource);
    if (!entry) {
      errors.push(`"${raw}": unknown resource "${grant.resource}"`);
    } else if (grant.action !== "*" && !entry.actions.includes(grant.action)) {
      errors.push(
        `"${raw}": "${grant.resource}" has no action "${grant.action}"`,
      );
    } else if (grant.scope === "own" && !entry.scoped) {
      errors.push(`"${raw}": "${grant.resource}" has no owner to scope by`);
    }
  }

  return errors;
};

type Rules = Map<string, Level>;

const key = (resource: string, action: string) => `${resource}\u0000${action}`;

const RANK: Record<Level, number> = { ref: 1, own: 2, all: 3 };

// A wildcard can stand in for either half, so four entries can answer one question; the widest wins.
const lookup = (rules: Rules, resource: string, action: string) => {
  let best: Level | null = null;

  for (const candidate of [
    key(resource, action),
    key(resource, "*"),
    key("*", action),
    key("*", "*"),
  ]) {
    const level = rules.get(candidate);
    if (level && (!best || RANK[level] > RANK[best])) best = level;
  }

  return best;
};

export type Permissions = {
  grants: Rules;
  // Present for a token that was narrowed to specific "<resource>:<action>" scopes; the user's
  // own grants still bound it, so the effective permission is the intersection of both.
  scopes: Rules | null;
};

export const compile = (
  grants: readonly string[],
  scopes?: readonly string[] | null,
): Permissions => {
  const rules: Rules = new Map();

  for (const raw of grants) {
    const grant = parseGrant(raw);
    if (!grant) continue;

    const id = key(grant.resource, grant.action);
    const current = rules.get(id);
    if (!current || RANK[grant.scope] > RANK[current]) {
      rules.set(id, grant.scope);
    }
  }

  if (!scopes) return { grants: rules, scopes: null };

  const allowed: Rules = new Map();
  for (const raw of scopes) {
    const [resource, action, ...rest] = raw.split(":");
    if (resource && action && rest.length === 0) {
      allowed.set(key(resource, action), "all");
    }
  }

  return { grants: rules, scopes: allowed };
};

const direct = (
  permissions: Permissions,
  resource: string,
  action: string,
): Level | null => {
  const vars = isVarsResource(resource);
  // Vars groups only know read and write, whatever wider action a wildcard grant was meant for.
  const asked = vars && action !== "read" ? "write" : action;

  const level = lookup(permissions.grants, resource, asked);
  if (!level) return null;

  if (permissions.scopes && !lookup(permissions.scopes, resource, asked)) {
    return null;
  }

  // A vars group is a singleton, so there is no row to be the owner of.
  return vars && level === "own" ? null : level;
};

export type RelationField = { name: string; many: boolean; target: string };

const RELATION_KINDS = new Set([
  "relation",
  "multi_relation",
  "file",
  "multi_file",
]);

export const relationFieldsOf = (schema: z.ZodObject): RelationField[] =>
  Object.entries(schema.shape).flatMap(([name, field]) => {
    const meta = (field as z.ZodType).meta() as
      | { renderAs?: string; model?: string }
      | undefined;
    if (!RELATION_KINDS.has(meta?.renderAs ?? "")) return [];

    return [
      {
        name,
        many:
          meta?.renderAs === "multi_relation" ||
          meta?.renderAs === "multi_file",
        target: meta?.model ?? "",
      },
    ];
  });

export type RelationGraph = { referrersOf: (target: string) => string[] };

export const buildRelationGraph = (
  schemas: Iterable<[string, z.ZodObject]>,
): RelationGraph => {
  const referrers = new Map<string, Set<string>>();

  for (const [prefix, schema] of schemas) {
    for (const { target } of relationFieldsOf(schema)) {
      if (!target) continue;
      if (!referrers.has(target)) referrers.set(target, new Set());
      referrers.get(target)?.add(prefix);
    }
  }

  return { referrersOf: (target) => [...(referrers.get(target) ?? [])] };
};

const REF_SOURCE_ACTIONS = ["read", "create", "update"] as const;

// What the caller may do with `resource`. Beyond its own grants, anyone who can read, create or
// update a model that links to `resource` gets "ref" there: enough to see the id and label of a
// linked row (a dropdown, a populated field) but not to use it as content. Only one hop — a
// "ref" never grants more "ref".
export const access = (
  permissions: Permissions,
  resource: string,
  action: string,
  graph?: RelationGraph,
): Level | false => {
  const level = direct(permissions, resource, action);
  if (level) return level;

  if (action !== "read" || !graph || isVarsResource(resource)) return false;

  for (const referrer of graph.referrersOf(resource)) {
    for (const source of REF_SOURCE_ACTIONS) {
      if (direct(permissions, referrer, source)) return "ref";
    }
  }

  return false;
};

// Rows `level` may touch, as a query condition. "all" and "ref" add nothing (a "ref" caller is
// confined by field projection, not by row).
export const ownerFilter = (level: Level, userId: string): Condition[] =>
  level === "own" ? [{ field: "createdBy", op: "$eq", value: userId }] : [];

const idOf = (value: unknown) =>
  value && typeof value === "object" && "id" in value
    ? (value as { id: unknown }).id
    : value;

export const isOwner = (row: Record<string, unknown>, userId: string) =>
  idOf(row.createdBy) === userId;

export const minimal = (
  record: Record<string, unknown>,
  labelField?: string,
): Record<string, unknown> => ({
  id: record.id,
  ...(labelField && labelField in record
    ? { [labelField]: record[labelField] }
    : {}),
});

// Cuts the linked records already expanded into `row` down to {id, label} wherever the caller
// may not read the target in full. A link that never expanded (a bare id, null) is left alone.
export const redactRefs = (
  row: Record<string, unknown>,
  fields: RelationField[],
  resolve: (target: string) => Level | false,
  userId: string,
  labelOf: (target: string) => string | undefined,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...row };

  const shrink = (target: string, value: unknown) => {
    if (!value || typeof value !== "object") return value;

    const level = resolve(target);
    const record = value as Record<string, unknown>;
    if (level === "all" || (level === "own" && isOwner(record, userId))) {
      return value;
    }

    return minimal(record, labelOf(target));
  };

  for (const { name, many, target } of fields) {
    const value = out[name];
    if (many && Array.isArray(value)) {
      out[name] = value.map((item) => shrink(target, item));
    } else if (!many) {
      out[name] = shrink(target, value);
    }
  }

  return out;
};
