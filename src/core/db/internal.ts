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
const strings = (name: string): FieldDef => ({
  kind: "array",
  name,
  of: { kind: "scalar", type: "string" },
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

// Every credential: admin sessions, personal access tokens, and the tokens OAuth hands to agents
// (modules/token.ts). `kind` says which; the secret is stored only as a hash. A session carries
// the user's full permissions, any other kind is narrowed to `scopes`.
export const tokenTable = table("token", [
  str("hash"),
  one("user", "user"),
  str("kind"),
  str("name"),
  str("clientId"),
  one("consent", "oauth_consent"),
  strings("scopes"),
  datetime("expiresAt"),
  datetime("lastUsedAt"),
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
  // What the user agreed to hand the client, as "<resource>:<action>" scopes.
  strings("scopes"),
  datetime("expiresAt"),
]);

// What a user has let an OAuth client do on their behalf — one row per (user, client), the source
// for "connected apps". Revoking it takes the client's tokens with it.
export const oauthConsentTable = table("oauth_consent", [
  one("user", "user"),
  str("clientId"),
  str("clientName"),
  strings("scopes"),
  datetime("grantedAt"),
  datetime("lastUsedAt"),
]);

// Failed-attempt counters (core/rate_limit.ts). The record id is the thing being limited, e.g.
// "login:alice@example.com".
export const rateLimitTable = table("rate_limit", [
  num("count"),
  datetime("resetAt"),
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

// The live copy of each settings group made with `draftable: true` (core/vars): one document
// per group, keyed by the group's prefix like the working copy in `vars`.
export const varsPublishedTable: TableDef = {
  name: "vars_published",
  fields: [],
  search: [],
  document: true,
};

export const internalTables: readonly TableDef[] = [
  tokenTable,
  oauthClientTable,
  oauthCodeTable,
  oauthConsentTable,
  rateLimitTable,
  mcpUploadTable,
  pageviewTable,
  varsTable,
  varsPublishedTable,
];
