import type { FieldDef } from "../db/contract";

// The user who created a record (null when it was not created on behalf of anyone). It is what
// an "own" permission is measured against, so it is set by the server from the caller and can
// never come from a request body. Kept apart from model/index.ts so i18n.ts can use it without
// a circular import.
export const OWNER_FIELD = "createdBy";

export const OWNER_FIELDS: FieldDef[] = [
  { kind: "one", name: OWNER_FIELD, target: "user" },
];

export type CreateOptions = { createdBy?: string };
