import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import Elysia from "elysia";
import z from "zod";
import { toAdminSchema } from "../core/admin_schema";
import { getConfig, type ModelFactory, type VarsFactory } from "../core/config";
import type { McpTool } from "../core/mcp_tool";
import { isDraftable, isI18n } from "../core/model";
import { makeModule } from "../core/module";
import { publicBase } from "../core/public_url";
import { isDraftableVars, isI18nVars } from "../core/vars";
import elysia from "./elysia";
import fileModule from "./file";
import logger from "./logger";
import mcpToken from "./mcp_token";
import { createUploadTicket, getUploadStatus } from "./mcp_upload";

type Model = Awaited<ReturnType<ModelFactory>>["default"];
type VarsGroup = Awaited<ReturnType<VarsFactory>>["default"];

const INSTRUCTIONS = `Manage the content of an njin website.

Start with list_models: it returns every content model and settings (vars) group with its JSON schema. Then use read_records / get_record to look at existing content before changing it.

Field conventions:
- A relation or file field takes the id of the related record as a plain string — never an object and never the whole record (an object is stored as a dead copy, not a link). Records you read, create or update come back with their relations expanded one level. A "_warnings" entry means a link points at a record that does not exist, or holds an embedded {id} object instead of a link: fix it with update_record, sending the plain id string.
- A field with renderAs "file" takes the id of a file record, not a URL.
- update_record and update_vars only change the fields you send; omitted fields are kept.
- Validation errors name the offending field — fix it and retry instead of guessing.

Files: you cannot send file bytes through a tool call. To add a file the user gave you, call create_upload_url, then either upload it yourself (curl -F file=@PATH URL, from your sandbox) or — if you cannot reach the URL or have no shell — give the URL to the user so they can open it and drop the file. Then call check_upload to get the file id, and put that id in the model's file field.

Drafts: a model marked "draftable" in list_models keeps a live (published) copy apart from the working copy that create_record, update_record and read_records use. Each record has a "status": "draft" (never published), "published", or "changed" (published, with edits that are not live yet). Editing never changes what is live — call publish_record to put the working copy live, unpublish_record to take it offline (it stays as a draft), or discard_changes to drop unpublished edits.

Publishing on an "i18n" model is per language: publish_record, unpublish_record and discard_changes take a locale (a code or a list; leave it out for every language the record has), and list_models says which models are both. A record's status is then { code: "draft" | "published" | "changed" } per language, and publishing one language leaves the others as they were.

Settings (vars) groups work the same way: list_models marks the groups that are "draftable" and/or "i18n". On an i18n group a localized field is an object keyed by language code in update_vars, and get_vars returns every language unless you pass locale. A draftable group has a working copy (get_vars, update_vars) and a live copy (get_vars with published: true); publish_vars, unpublish_vars and discard_vars move between them, per language (locale) on an i18n group.

A relation field follows the language of the model it points at: where that model is marked "i18n", the related record you read is its record in the language you asked for (locale), or in the default language when you gave none — whichever model you are reading. Only file fields and lists of files can differ per language on a model, never a relation.

Languages: a model marked "i18n" in list_models keeps its localized fields once per language (the "i18n" key of list_models has the language codes). In create_record and update_record such a field is an object keyed by language code, e.g. title: { "en": "About", "id": "Tentang" }; a field you leave out of an update keeps its value, and a language you leave out is untouched. read_records and get_record return every language as { code: value }; pass locale (a code) to get one language as flat fields. A new language needs every required localized field. remove_locale deletes one language of a record.

delete_record and delete_file are permanent.`;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? null) }],
});

// Agents copy ids out of earlier results, and occasionally from a record link they saw as
// "table:id" — tolerate that on the way in.
const bareId = (prefix: string, id: string) =>
  id.startsWith(`${prefix}:`) ? id.slice(prefix.length + 1) : id;

const RELATION_KINDS = new Set([
  "relation",
  "multi_relation",
  "file",
  "multi_file",
]);

type RelationField = { name: string; many: boolean; target: string };

// A model or a vars group — both carry the zod schema the link fields are read from.
type HasSchema = { validation: z.ZodObject };

const relationFieldsOf = (model: HasSchema): RelationField[] =>
  Object.entries(model.validation.shape).flatMap(([name, field]) => {
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

const toLinkId = (target: string, value: unknown) => {
  const raw =
    value && typeof value === "object" && "id" in value
      ? (value as { id: unknown }).id
      : value;

  return typeof raw === "string" ? bareId(target, raw) : value;
};

// A relation written as an object (`{ id }`, or a whole record echoed back from a read) is stored
// by njin as an embedded copy, not a link — it never expands and goes stale. Agents do send that
// shape, so reduce every link field to the plain id string before validation turns it into a
// real record link. Also drops a "table:" prefix that doesn't belong in a link.
const normalizeRelations = (
  model: HasSchema,
  data: Record<string, unknown>,
) => {
  const next = { ...data };

  for (const { name, many, target } of relationFieldsOf(model)) {
    const value = next[name];
    if (value === undefined || value === null) continue;

    next[name] =
      many && Array.isArray(value)
        ? value.map((item) => toLinkId(target, item))
        : toLinkId(target, value);
  }

  return next;
};

// An expanded link always carries the target's own fields; a bare `{ id }` is what an embedded
// stub looks like (a link written as an object before this was normalised).
const isStub = (value: unknown) => {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;

  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === "id");
};

const stubFieldsOf = (model: HasSchema, row: Record<string, unknown>) =>
  relationFieldsOf(model)
    .filter(({ name, many }) =>
      many
        ? Array.isArray(row[name]) && (row[name] as unknown[]).some(isStub)
        : isStub(row[name]),
    )
    .map(({ name }) => name);

const stubWarning = (field: string, recordId?: string) =>
  `${recordId ? `Record ${recordId}: ` : ""}"${field}" holds an embedded {id} object, not a link, so it cannot expand. Fix it with update_record, sending "${field}" as the plain id string.`;

// create()/update() hand back the row exactly as stored, so every relation field is a bare id —
// the agent can't tell a link that resolved from one pointing at nothing (a dangling link
// comes back as a bare id, not as a record). Re-read through show(), the same FETCH
// get_record uses, so related records come back expanded, and flag any link that didn't resolve.
const readBack = async (model: Model, written: Record<string, unknown>) => {
  const id = String(written.id);
  const shown = ((await model.show(id)) ?? written) as Record<string, unknown>;

  const warnings: string[] = [];
  for (const { name: field } of relationFieldsOf(model)) {
    const stored = written[field];
    if (stored === null || stored === undefined) continue;

    const resolved = shown[field];
    const isRecord = (value: unknown) => !!value && typeof value === "object";
    const missing = Array.isArray(stored)
      ? stored.length -
        (Array.isArray(resolved) ? resolved.filter(isRecord).length : 0)
      : isRecord(resolved)
        ? 0
        : 1;

    if (missing > 0) {
      warnings.push(
        `"${field}": ${missing} linked record(s) do not exist — check the id(s) you sent.`,
      );
    }
  }

  return warnings.length ? { ...shown, _warnings: warnings } : shown;
};

const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

// A custom tool may answer in prose — a returned string goes out as-is instead of as a JSON
// string literal.
const okText = (data: unknown): ToolResult =>
  typeof data === "string"
    ? { content: [{ type: "text", text: data }] }
    : ok(data);

// Turns anything a tool body throws into an isError result the agent can read and react to
// (a validation message it can fix, a unique-constraint clash) rather than a protocol-level
// failure that just says "internal error".
const run = async (
  fn: () => Promise<unknown>,
  format: (data: unknown) => ToolResult = ok,
): Promise<ToolResult> => {
  try {
    return format(await fn());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return fail(`Validation failed:\n${z.prettifyError(e)}`);
    }
    if (e instanceof Error) return fail(e.message);
    throw e;
  }
};

const BUILT_IN_TOOLS = new Set([
  "list_models",
  "read_records",
  "get_record",
  "create_record",
  "update_record",
  "delete_record",
  "remove_locale",
  "publish_record",
  "unpublish_record",
  "discard_changes",
  "get_vars",
  "update_vars",
  "publish_vars",
  "unpublish_vars",
  "discard_vars",
  "create_upload_url",
  "check_upload",
  "list_files",
  "get_file",
  "delete_file",
]);

// Stricter than the MCP spec (which also allows "."): the Claude API, which most agents call
// through, rejects any other tool name — and it would only fail once an agent connects.
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

// Checked at boot so a bad tool file fails `njin dev` immediately, not the first agent that
// connects.
const loadCustomTools = async () => {
  const tools: McpTool[] = [];
  const seen = new Set<string>();

  for (const factory of getConfig().mcp?.tools ?? []) {
    const { default: tool } = await factory();

    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(
        `MCP tool "${tool.name}": names may only use letters, digits, "_" and "-" (max 64).`,
      );
    }
    if (BUILT_IN_TOOLS.has(tool.name)) {
      throw new Error(
        `MCP tool "${tool.name}" clashes with a built-in tool of the same name.`,
      );
    }
    if (seen.has(tool.name)) {
      throw new Error(`MCP tool "${tool.name}" is registered twice.`);
    }

    seen.add(tool.name);
    tools.push(tool);
  }

  return tools;
};

const mcp = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const { plugin: tokenPlugin } = await mcpToken();

    const models = new Map<string, Model>();
    for (const factory of getConfig().models) {
      const { default: model } = await factory();
      models.set(model.prefix, model);
    }

    const groups = new Map<string, VarsGroup>();
    for (const factory of getConfig().vars) {
      const { default: group } = await factory();
      groups.set(group.prefix, group);
    }

    const customTools = await loadCustomTools();

    // Static for the process lifetime (config can't change without a restart), so computed
    // once instead of on every list_models call.
    const catalog = {
      models: [...models.values()].map((model) => ({
        name: model.name,
        prefix: model.prefix,
        draftable: isDraftable(model),
        i18n: isI18n(model),
        schema: toAdminSchema(model.validation, { forAgent: true }),
      })),
      vars: [...groups.values()].map((group) => ({
        name: group.name,
        prefix: group.prefix,
        draftable: isDraftableVars(group),
        i18n: isI18nVars(group),
        schema: toAdminSchema(group.validation, { forAgent: true }),
      })),
    };

    const getModel = (prefix: string) => {
      const model = models.get(prefix);
      if (!model) {
        throw new Error(
          `Unknown model "${prefix}". Available: ${[...models.keys()].join(", ") || "(none)"}`,
        );
      }
      return model;
    };

    const getGroup = (prefix: string) => {
      const group = groups.get(prefix);
      if (!group) {
        throw new Error(
          `Unknown vars group "${prefix}". Available: ${[...groups.keys()].join(", ") || "(none)"}`,
        );
      }
      return group;
    };

    // One server per request — the endpoint is stateless (no session to keep alive), which
    // also suits njin's workers being evicted when idle.
    const buildServer = (
      token: { id: string; name: string; createdBy: string | null },
      base: string,
    ) => {
      const server = new McpServer(
        { name: "njin", version: "1.0.0" },
        { instructions: INSTRUCTIONS },
      );

      const audit = (tool: string, target?: string, id?: string) =>
        logger()?.info({ mcpToken: token.name, tool, target, id }, "mcp tool");

      server.registerTool(
        "list_models",
        {
          title: "List models",
          description:
            "List every content model and settings (vars) group with its JSON schema. Call this first.",
          annotations: { readOnlyHint: true },
        },
        async () => {
          audit("list_models");
          return ok(catalog);
        },
      );

      server.registerTool(
        "read_records",
        {
          title: "Read records",
          description:
            "List records of a model with search, filters, sorting and pagination.",
          inputSchema: {
            model: z.string().describe("Model prefix from list_models"),
            search: z.string().optional(),
            page: z.number().int().positive().default(1),
            limit: z.number().int().positive().max(100).default(20),
            sort: z.string().optional().describe("Field name to sort by"),
            order: z.enum(["asc", "desc"]).default("asc"),
            populate: z
              .union([z.literal("none"), z.array(z.string())])
              .optional()
              .describe(
                'Relation fields to expand. Omit for the default, "none" for ids only.',
              ),
            select: z
              .array(z.string().max(100))
              .max(100)
              .optional()
              .describe(
                'Fields to return ("id" is always included). Use "relation.field" (e.g. "author.name") to pick fields of a related record. Omit for all fields.',
              ),
            filters: z
              .record(
                z.string(),
                z.union([z.string(), z.record(z.string(), z.string())]),
              )
              .optional()
              .describe("Field -> value, or field -> { operator: value }"),
            locale: z
              .string()
              .optional()
              .describe(
                'A language code: models marked "i18n" return that language as flat fields (omit for every language), and related records of other i18n models come in that language (the default language when omitted).',
              ),
          },
          annotations: { readOnlyHint: true },
        },
        async ({ model, ...options }) =>
          run(async () => {
            audit("read_records", model);
            // [] means "not specified", same as an empty value over REST — passing it through
            // would suppress every FETCH and leave relations as bare ids.
            const populate =
              Array.isArray(options.populate) && options.populate.length === 0
                ? undefined
                : options.populate;
            const target = getModel(model);
            const result = await target.read({ ...options, populate });

            const warnings = (result.data as Record<string, unknown>[]).flatMap(
              (row) =>
                stubFieldsOf(target, row).map((field) =>
                  stubWarning(field, String(row.id)),
                ),
            );

            return warnings.length
              ? { ...result, _warnings: warnings.slice(0, 20) }
              : result;
          }),
      );

      server.registerTool(
        "get_record",
        {
          title: "Get record",
          description: "Get one record by id, with its relations expanded.",
          inputSchema: {
            model: z.string(),
            id: z.string(),
            locale: z
              .string()
              .optional()
              .describe(
                'A language code: models marked "i18n" return that language as flat fields, and related records of other i18n models come in that language (the default language when omitted).',
              ),
          },
          annotations: { readOnlyHint: true },
        },
        async ({ model, id, locale }) =>
          run(async () => {
            audit("get_record", model, id);
            const target = getModel(model);
            const record = (await target.show(bareId(model, id), {
              locale,
            })) as Record<string, unknown> | undefined;
            if (!record) throw new Error(`No ${model} record with id "${id}"`);

            const stubs = stubFieldsOf(target, record);
            return stubs.length
              ? { ...record, _warnings: stubs.map((f) => stubWarning(f)) }
              : record;
          }),
      );

      server.registerTool(
        "create_record",
        {
          title: "Create record",
          description:
            "Create a record. `data` must satisfy the model's schema from list_models.",
          inputSchema: {
            model: z.string(),
            data: z.record(z.string(), z.unknown()),
          },
        },
        async ({ model, data }) =>
          run(async () => {
            audit("create_record", model);
            const target = getModel(model);
            return readBack(
              target,
              (await target.create(
                target.validation.parse(
                  normalizeRelations(target, data),
                ) as never,
              )) as Record<string, unknown>,
            );
          }),
      );

      server.registerTool(
        "update_record",
        {
          title: "Update record",
          description:
            "Update a record. Only the fields in `data` change; the rest are kept.",
          inputSchema: {
            model: z.string(),
            id: z.string(),
            data: z.record(z.string(), z.unknown()),
          },
          annotations: { idempotentHint: true },
        },
        async ({ model, id, data }) =>
          run(async () => {
            audit("update_record", model, id);
            const target = getModel(model);
            return readBack(
              target,
              (await target.update(
                bareId(model, id),
                target.validation
                  .partial()
                  .parse(normalizeRelations(target, data)) as never,
              )) as Record<string, unknown>,
            );
          }),
      );

      server.registerTool(
        "delete_record",
        {
          title: "Delete record",
          description: "Permanently delete a record by id. Cannot be undone.",
          inputSchema: { model: z.string(), id: z.string() },
          annotations: { destructiveHint: true },
        },
        async ({ model, id }) =>
          run(async () => {
            audit("delete_record", model, id);
            return getModel(model).destroy(bareId(model, id));
          }),
      );

      const getDraftable = (prefix: string) => {
        const target = getModel(prefix);
        if (!isDraftable(target)) {
          throw new Error(`Model "${prefix}" is not draftable.`);
        }
        return target;
      };

      server.registerTool(
        "publish_record",
        {
          title: "Publish record",
          description:
            "Put a draftable record's current working copy live. Only models marked draftable in list_models support it.",
          inputSchema: {
            model: z.string(),
            id: z.string(),
            locale: z
              .union([z.string(), z.array(z.string())])
              .optional()
              .describe(
                'Models marked "i18n": the language code(s) to act on. Omit for every language the record has.',
              ),
          },
          annotations: { idempotentHint: true },
        },
        async ({ model, id, locale }) =>
          run(async () => {
            audit("publish_record", model, id);
            const target = getDraftable(model);
            await target.publish(bareId(model, id), { locale });
            return readBack(
              target,
              (await target.show(bareId(model, id))) as never,
            );
          }),
      );

      server.registerTool(
        "unpublish_record",
        {
          title: "Unpublish record",
          description:
            "Take a published record offline. Its working copy is kept as a draft and can be published again.",
          inputSchema: {
            model: z.string(),
            id: z.string(),
            locale: z
              .union([z.string(), z.array(z.string())])
              .optional()
              .describe(
                'Models marked "i18n": the language code(s) to act on. Omit for every language the record has.',
              ),
          },
          annotations: { idempotentHint: true },
        },
        async ({ model, id, locale }) =>
          run(async () => {
            audit("unpublish_record", model, id);
            const target = getDraftable(model);
            await target.unpublish(bareId(model, id), { locale });
            return readBack(
              target,
              (await target.show(bareId(model, id))) as never,
            );
          }),
      );

      server.registerTool(
        "discard_changes",
        {
          title: "Discard unpublished changes",
          description:
            "Throw away a published record's unpublished edits: the working copy goes back to what is live. Fails if the record is not published.",
          inputSchema: {
            model: z.string(),
            id: z.string(),
            locale: z
              .union([z.string(), z.array(z.string())])
              .optional()
              .describe(
                'Models marked "i18n": the language code(s) to act on. Omit for every language the record has.',
              ),
          },
          annotations: { destructiveHint: true },
        },
        async ({ model, id, locale }) =>
          run(async () => {
            audit("discard_changes", model, id);
            const target = getDraftable(model);
            await target.discard(bareId(model, id), { locale });
            return readBack(
              target,
              (await target.show(bareId(model, id))) as never,
            );
          }),
      );

      server.registerTool(
        "remove_locale",
        {
          title: "Remove a language of a record",
          description:
            'Delete one language of a record of a model marked "i18n". The last language cannot be removed; delete the record instead.',
          inputSchema: {
            model: z.string(),
            id: z.string(),
            locale: z.string().describe("Language code"),
          },
          annotations: { destructiveHint: true },
        },
        async ({ model, id, locale }) =>
          run(async () => {
            audit("remove_locale", model, id);
            const target = getModel(model);
            if (!isI18n(target)) {
              throw new Error(`Model "${model}" is not marked "i18n".`);
            }
            return target.removeLocale(bareId(model, id), locale);
          }),
      );

      server.registerTool(
        "get_vars",
        {
          title: "Get settings",
          description:
            "Get the current values of a settings (vars) group, defaults filled in. Relation and file fields come back as ids (use get_record / get_file to look them up).",
          inputSchema: {
            group: z.string().describe("Group prefix"),
            locale: z
              .string()
              .optional()
              .describe(
                'Groups marked "i18n": a language code to get that language as flat fields. Omit for every language.',
              ),
            published: z
              .boolean()
              .optional()
              .describe(
                'Groups marked "draftable": true reads the live copy instead of the working copy.',
              ),
          },
          annotations: { readOnlyHint: true },
        },
        async ({ group, locale, published }) =>
          run(async () => {
            audit("get_vars", group);
            const target = getGroup(group);
            const values = (await (published
              ? getDraftableGroup(group).published.get({ locale })
              : target.get({ locale }))) as Record<string, unknown>;

            const stubs = stubFieldsOf(target, values);
            return stubs.length
              ? { ...values, _warnings: stubs.map((f) => stubWarning(f)) }
              : values;
          }),
      );

      const getDraftableGroup = (prefix: string) => {
        const target = getGroup(prefix);
        if (!isDraftableVars(target)) {
          throw new Error(`Settings group "${prefix}" is not draftable.`);
        }
        return target;
      };

      for (const [name, action, title, description] of [
        [
          "publish_vars",
          "publish",
          "Publish settings",
          "Put a draftable settings group's working copy live (per language on an i18n group).",
        ],
        [
          "unpublish_vars",
          "unpublish",
          "Unpublish settings",
          "Take a draftable settings group offline; its working copy is kept.",
        ],
        [
          "discard_vars",
          "discard",
          "Discard unpublished settings",
          "Throw away a draftable settings group's unpublished edits: the working copy goes back to what is live.",
        ],
      ] as const) {
        server.registerTool(
          name,
          {
            title,
            description,
            inputSchema: {
              group: z.string().describe("Group prefix"),
              locale: z
                .union([z.string(), z.array(z.string())])
                .optional()
                .describe(
                  'Groups marked "i18n": the language code(s) to act on. Omit for every language.',
                ),
            },
            annotations:
              action === "discard"
                ? { destructiveHint: true }
                : { idempotentHint: true },
          },
          async ({ group, locale }) =>
            run(async () => {
              audit(name, group);
              return getDraftableGroup(group)[action]({ locale });
            }),
        );
      }

      server.registerTool(
        "update_vars",
        {
          title: "Update settings",
          description:
            "Update a settings (vars) group. Only the fields in `data` change.",
          inputSchema: {
            group: z.string(),
            data: z.record(z.string(), z.unknown()),
          },
          annotations: { idempotentHint: true },
        },
        async ({ group, data }) =>
          run(async () => {
            audit("update_vars", group);
            const target = getGroup(group);
            return target.update(
              target.validation
                .partial()
                .parse(normalizeRelations(target, data)) as never,
            );
          }),
      );

      server.registerTool(
        "create_upload_url",
        {
          title: "Create upload URL",
          description:
            "Get a short-lived URL for adding files to the site (the way to upload — file bytes cannot go through tool calls). Upload with `curl -F file=@PATH URL` (repeat -F file=@... for several files), or give the URL to the user to open and drop files on. Returns upload_id for check_upload. Only some file types are accepted (see allowed_extensions).",
        },
        async () =>
          run(async () => {
            audit("create_upload_url");
            return {
              ...(await createUploadTicket({
                tokenId: token.id,
                userId: token.createdBy,
                base,
              })),
              how_to: [
                "From a shell: curl -F file=@/path/to/file URL",
                "No shell or network access: show the URL to the user and ask them to open it and drop the file(s).",
                "Then call check_upload with upload_id to get the new file ids.",
              ],
            };
          }),
      );

      server.registerTool(
        "check_upload",
        {
          title: "Check upload",
          description:
            "List the files that have arrived through an upload URL, with their ids. Call after uploading or after asking the user to.",
          inputSchema: { upload_id: z.string() },
          annotations: { readOnlyHint: true },
        },
        async ({ upload_id }) =>
          run(async () => {
            audit("check_upload", undefined, upload_id);
            const status = await getUploadStatus(upload_id);
            if (!status) throw new Error("Unknown upload_id.");
            return status;
          }),
      );

      server.registerTool(
        "list_files",
        {
          title: "List files",
          description:
            "List uploaded files (newest first by default) with search and pagination.",
          inputSchema: {
            search: z.string().optional().describe("Match on file name"),
            page: z.number().int().positive().default(1),
            limit: z.number().int().positive().max(100).default(20),
            sort: z.string().optional(),
            order: z.enum(["asc", "desc"]).default("desc"),
          },
          annotations: { readOnlyHint: true },
        },
        async (options) =>
          run(async () => {
            audit("list_files");
            return fileModule().model.read({
              ...options,
              sort: options.sort ?? "createdAt",
            });
          }),
      );

      server.registerTool(
        "get_file",
        {
          title: "Get file",
          description: "Get a file's metadata and URL by id.",
          inputSchema: { id: z.string() },
          annotations: { readOnlyHint: true },
        },
        async ({ id }) =>
          run(async () => {
            audit("get_file", undefined, id);
            const record = await fileModule().model.show(bareId("file", id));
            if (!record) throw new Error(`No file with id "${id}"`);
            return record;
          }),
      );

      server.registerTool(
        "delete_file",
        {
          title: "Delete file",
          description:
            "Permanently delete a file from storage. Records that still reference it are not updated and will point at nothing — check usage first.",
          inputSchema: { id: z.string() },
          annotations: { destructiveHint: true },
        },
        async ({ id }) =>
          run(async () => {
            audit("delete_file", undefined, id);
            return fileModule().remove(bareId("file", id));
          }),
      );

      for (const tool of customTools) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: tool.input ?? {},
            annotations: tool.annotations,
          },
          async (args) =>
            run(async () => {
              audit(tool.name);
              return tool.handler(args, { token, baseUrl: base });
            }, okText),
        );
      }

      return server;
    };

    const controller = new Elysia().use(tokenPlugin).all(
      "/mcp",
      async ({ request, mcpToken }) => {
        const server = buildServer(mcpToken, publicBase(request));
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        try {
          await server.connect(transport);
          return await transport.handleRequest(request);
        } finally {
          await server.close();
        }
      },
      // The transport reads the raw request body itself — Elysia must not consume it first.
      { mcpAuth: true, parse: "none" },
    );

    elysia().use(controller);

    return {};
  };

  return fn;
});

export default mcp;
