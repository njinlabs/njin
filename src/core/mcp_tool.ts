import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type z from "zod";

export type McpToolShape = Record<string, z.ZodType>;

export type McpToolContext = {
  // The connection the agent called through — the same token listed under /api/mcp-token.
  token: { id: string; name: string; createdBy: string | null };
  // Public base URL of the site ("https://example.com"), for building absolute links.
  baseUrl: string;
};

export type McpTool<Shape extends McpToolShape = McpToolShape> = {
  // Must be unique and must not clash with a built-in tool (list_models, create_record, ...).
  name: string;
  title?: string;
  // What the agent reads to decide when to call the tool — say what it does and when to use it.
  description: string;
  // zod fields for the arguments. Validated by the MCP server before the handler runs, and
  // shown to the agent as JSON schema (`.describe()` on a field becomes its description).
  input?: Shape;
  annotations?: ToolAnnotations;
  // Whatever it returns is sent to the agent as JSON (a string is sent as-is). Throwing sends
  // the error message back as a tool error the agent can read and react to.
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
    context: McpToolContext,
  ) => unknown;
};

// Identity function — DX/typing only, same purpose as defineHelper/definePlugin.
export const defineTool = <Shape extends McpToolShape = Record<never, never>>(
  tool: McpTool<Shape>,
): McpTool<Shape> => tool;
