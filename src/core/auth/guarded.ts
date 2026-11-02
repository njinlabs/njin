import type z from "zod";
import db from "../../modules/db";
import type { Principal } from "../../modules/token";
import type { Condition, TableDef } from "../db/contract";
import { HttpError } from "../http/http_error";
import {
  access,
  buildRelationGraph,
  isOwner,
  type Level,
  minimal,
  ownerFilter,
  type RelationField,
  redactRefs,
  relationFieldsOf,
} from "./access";

// Where the permission engine (core/auth/access.ts) meets a request. A route asks the guard for a
// gate on one model and runs its reads and writes through it, so REST, the admin panel and MCP
// all answer to the same rules:
//
//   gate.read(options)      narrows the options of a list to what the caller may see
//   gate.seeing(id)         before showing one record
//   gate.creating()         before creating one; says who the creator is
//   gate.changing(id, a)    before updating, deleting or publishing one
//   gate.shape(record)      on every record that goes back out
//
// The model layer itself knows nothing about callers.

export type GuardModel = {
  prefix: string;
  def: TableDef;
  validation: z.ZodObject;
  searchFields: readonly string[];
};

// What a gate looks at and may rewrite in the options of a list.
type ReadScope = {
  where?: readonly Condition[];
  filters?: unknown;
  sort?: string;
  select?: readonly string[];
  populate?: unknown;
};

export type Gate = {
  // What the caller may do with this model, or false.
  level(action: string): Level | false;
  // The same, as an error (403) when there is nothing.
  require(action: string): Level;
  read<O extends ReadScope>(options: O): O;
  seeing(id: string): Promise<void>;
  creating(): { createdBy: string };
  changing(id: string, action: "update" | "delete" | "publish"): Promise<void>;
  // A record that was read through this gate, as far as the caller may see it.
  shape(record: Record<string, unknown>): Record<string, unknown>;
  shapeAll(records: Record<string, unknown>[]): Record<string, unknown>[];
  // A record a write hands back (created, updated, deleted). The caller need not be able to
  // read it, so this is the whole record only where they could have read it anyway.
  echo(record: Record<string, unknown>): Record<string, unknown>;
};

// The field a record is shown by when the caller may not see the rest of it: the first plain
// search field (a "relation.field" entry is not a field of this record).
const labelFieldOf = (searchFields: readonly string[]) =>
  searchFields.find((field) => !field.includes("."));

// Listings of a file by name, from models that link to files without the file model being among
// the ones given.
const DEFAULT_LABELS: Record<string, string> = { file: "name" };

export const createGuard = (models: readonly GuardModel[]) => {
  const graph = buildRelationGraph(
    models.map((model) => [model.prefix, model.validation]),
  );

  const labels = new Map<string, string | undefined>(
    Object.entries(DEFAULT_LABELS),
  );
  for (const model of models) {
    labels.set(model.prefix, labelFieldOf(model.searchFields));
  }

  // A form shows a choice by the `labelKey` of the relation that points at it, so that is the
  // label to keep — when the target really has such a field.
  const fieldsOf = new Map(
    models.map((model) => [model.prefix, Object.keys(model.validation.shape)]),
  );
  for (const model of models) {
    for (const { target, labelKey } of relationFieldsOf(model.validation)) {
      if (labelKey && fieldsOf.get(target)?.includes(labelKey)) {
        labels.set(target, labelKey);
      }
    }
  }

  const labelOf = (target: string) => labels.get(target);

  const forbidden = () => new HttpError(403);

  const gate = (principal: Principal, model: GuardModel): Gate => {
    const { permissions, user } = principal;
    const relationFields: RelationField[] = relationFieldsOf(model.validation);
    const label = labelOf(model.prefix);

    const level = (action: string) =>
      access(permissions, model.prefix, action, graph);

    const require = (action: string) => {
      const granted = level(action);
      if (!granted) throw forbidden();
      return granted;
    };

    // Someone else's record is "not found", not "forbidden": its existence is not theirs to know.
    const checkOwner = async (granted: Level, id: string) => {
      if (granted !== "own") return;

      const row = await db().find(model.def, id, { populate: [] });
      if (!row || !isOwner(row, user.id)) throw new HttpError(404);
    };

    const redact = (record: Record<string, unknown>) =>
      redactRefs(
        record,
        relationFields,
        (target) => access(permissions, target, "read", graph),
        user.id,
        labelOf,
      );

    const shape = (record: Record<string, unknown>) =>
      level("read") === "ref" ? minimal(record, label) : redact(record);

    const echo = (record: Record<string, unknown>) => {
      const readable = level("read");

      return readable === "all" ||
        (readable === "own" && isOwner(record, user.id))
        ? redact(record)
        : minimal(record, label);
    };

    return {
      level,
      require,

      read: <O extends ReadScope>(options: O): O => {
        const granted = require("read");
        const where = [
          ...(options.where ?? []),
          ...ownerFilter(granted, user.id),
        ];

        if (granted !== "ref") return { ...options, where };

        // Enough to pick a record from a list, and nothing a filter or a sort could be used to
        // find out about the rest of it.
        return {
          ...options,
          where,
          filters: undefined,
          sort: options.sort === label ? options.sort : undefined,
          select: [label ?? "id"],
          populate: "none" as const,
        };
      },

      seeing: async (id) => checkOwner(require("read"), id),

      creating: () => {
        require("create");
        return { createdBy: user.id };
      },

      changing: async (id, action) => checkOwner(require(action), id),

      shape,
      shapeAll: (records) => records.map(shape),
      echo,
    };
  };

  // Settings groups are singletons: you may read one, or write it (publishing included).
  const vars =
    (principal: Principal, prefix: string) => (action: "read" | "write") => {
      if (!access(principal.permissions, `vars.${prefix}`, action)) {
        throw forbidden();
      }
    };

  return {
    graph,
    gate,
    vars,
    can: (principal: Principal, resource: string, action: string) =>
      access(principal.permissions, resource, action, graph),
  };
};

export type Guard = ReturnType<typeof createGuard>;
