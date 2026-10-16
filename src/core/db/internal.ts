import type { FieldDef, TableDef } from "./contract";

// Tables njin itself reads and writes, as opposed to the ones user models describe. They live
// here (not next to their modules) so the db module can sync every one of them at boot without
// importing each module.

const str = (name: string): FieldDef => ({
  kind: "scalar",
  name,
  type: "string",
});
const datetime = (name: string): FieldDef => ({
  kind: "scalar",
  name,
  type: "datetime",
});
const bool = (name: string): FieldDef => ({
  kind: "scalar",
  name,
  type: "boolean",
});
const num = (name: string): FieldDef => ({
  kind: "scalar",
  name,
  type: "number",
});
const one = (name: string, target: string): FieldDef => ({
  kind: "one",
  name,
  target,
});

const table = (name: string, fields: FieldDef[]): TableDef => ({
  name,
  fields,
  search: [],
});

// Admin session tokens (modules/auth.ts, modules/setup.ts).
export const tokenTable = table("token", [str("hash"), one("user", "user")]);

// MCP connections, manual and OAuth-issued (modules/mcp_token.ts).
export const mcpTokenTable = table("mcp_token", [
  str("name"),
  str("hash"),
  str("kind"),
  str("clientId"),
  one("createdBy", "user"),
  datetime("expiresAt"),
  str("refreshHash"),
  datetime("refreshExpiresAt"),
]);

export const oauthClientTable = table("oauth_client", [
  str("clientName"),
  {
    kind: "array",
    name: "redirectUris",
    of: { kind: "scalar", type: "string" },
  },
  bool("used"),
]);

// The record id is the hash of the code, so redeeming is a direct lookup.
export const oauthCodeTable = table("oauth_code", [
  str("clientId"),
  one("userId", "user"),
  str("redirectUri"),
  str("codeChallenge"),
  datetime("expiresAt"),
]);

export const mcpUploadTable = table("mcp_upload", [
  str("hash"),
  str("createdBy"),
  str("tokenId"),
  datetime("expiresAt"),
  num("remaining"),
  { kind: "array", name: "files", of: { kind: "scalar", type: "string" } },
]);

export const pageviewTable = table("pageview", [
  str("path"),
  str("referrer"),
  str("userAgent"),
  str("country"),
  str("visitorHash"),
]);

// Every VARS group is one row (id = the group's prefix) with its own shape, so they share a
// free-form document table.
export const varsTable: TableDef = {
  name: "vars",
  fields: [],
  search: [],
  document: true,
};

export const internalTables: readonly TableDef[] = [
  tokenTable,
  mcpTokenTable,
  oauthClientTable,
  oauthCodeTable,
  mcpUploadTable,
  pageviewTable,
  varsTable,
];
