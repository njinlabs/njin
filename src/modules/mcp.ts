import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import Elysia from "elysia";
import { RecordId } from "surrealdb";
import z from "zod";
import { toAdminSchema } from "../core/admin_schema";
import { getConfig, type ModelFactory, type VarsFactory } from "../core/config";
import { makeModule } from "../core/module";
import { publicBase } from "../core/public_url";
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
- A relation field takes the id of the related record (a string, not the whole record). Records you read, create or update come back with their relations expanded one level; a "_warnings" entry means a link you sent points at a record that does not exist.
- A field with renderAs "file" takes the id of a file record, not a URL.
- update_record and update_vars only change the fields you send; omitted fields are kept.
- Validation errors name the offending field — fix it and retry instead of guessing.

Files: you cannot send file bytes through a tool call. To add a file the user gave you, call create_upload_url, then either upload it yourself (curl -F file=@PATH URL, from your sandbox) or — if you cannot reach the URL or have no shell — give the URL to the user so they can open it and drop the file. Then call check_upload to get the file id, and put that id in the model's file field.

delete_record and delete_file are permanent.`;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// Record ids go out as the bare id ("abc123"), never "post:abc123": that bare form is what
// every tool parameter and every relation/file field takes back in. A relation field given the
// full "file:abc123" would silently become a record id of its own and dangle.
function plainIds(this: Record<string, unknown>, key: string, value: unknown) {
  const raw = this[key];
  return raw instanceof RecordId ? String(raw.id) : value;
}

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? null, plainIds) }],
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

const relationFieldsOf = (model: Model) =>
  Object.entries(model.validation.shape)
    .filter(([, field]) =>
      RELATION_KINDS.has((field as z.ZodType).meta()?.renderAs as string),
    )
    .map(([name]) => name);

// create()/update() hand back the row exactly as stored, so every relation field is a bare id —
// the agent can't tell a link that resolved from one pointing at nothing (SurrealDB drops a
// dangling link from a FETCH instead of erroring). Re-read through show(), the same FETCH
// get_record uses, so related records come back expanded, and flag any link that didn't resolve.
const readBack = async (model: Model, written: Record<string, unknown>) => {
  const id =
    written.id instanceof RecordId ? String(written.id.id) : String(written.id);
  const shown = ((await model.show(id)) ?? written) as Record<string, unknown>;

  const warnings: string[] = [];
  for (const field of relationFieldsOf(model)) {
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

// Turns anything a tool body throws into an isError result the agent can read and react to
// (a validation message it can fix, a unique-constraint clash) rather than a protocol-level
// failure that just says "internal error".
const run = async (fn: () => Promise<unknown>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return fail(`Validation failed:\n${z.prettifyError(e)}`);
    }
    if (e instanceof Error) return fail(e.message);
    throw e;
  }
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

    // Static for the process lifetime (config can't change without a restart), so computed
    // once instead of on every list_models call.
    const catalog = {
      models: [...models.values()].map((model) => ({
        name: model.name,
        prefix: model.prefix,
        schema: toAdminSchema(model.validation),
      })),
      vars: [...groups.values()].map((group) => ({
        name: group.name,
        prefix: group.prefix,
        schema: toAdminSchema(group.validation),
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
            filters: z
              .record(
                z.string(),
                z.union([z.string(), z.record(z.string(), z.string())]),
              )
              .optional()
              .describe("Field -> value, or field -> { operator: value }"),
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
            return getModel(model).read({ ...options, populate });
          }),
      );

      server.registerTool(
        "get_record",
        {
          title: "Get record",
          description: "Get one record by id, with its relations expanded.",
          inputSchema: { model: z.string(), id: z.string() },
          annotations: { readOnlyHint: true },
        },
        async ({ model, id }) =>
          run(async () => {
            audit("get_record", model, id);
            const record = await getModel(model).show(bareId(model, id));
            if (!record) throw new Error(`No ${model} record with id "${id}"`);
            return record;
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
                target.validation.parse(data) as never,
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
                target.validation.partial().parse(data) as never,
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

      server.registerTool(
        "get_vars",
        {
          title: "Get settings",
          description:
            "Get the current values of a settings (vars) group, defaults filled in.",
          inputSchema: { group: z.string().describe("Group prefix") },
          annotations: { readOnlyHint: true },
        },
        async ({ group }) =>
          run(async () => {
            audit("get_vars", group);
            return getGroup(group).get();
          }),
      );

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
              target.validation.partial().parse(data) as never,
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
