// Kept apart from ./index.ts so the model files that need it (i18n.ts) can import it without a
// cycle; ./index.ts re-exports it, so `import { UniqueConstraintError } from "../core/model"`
// keeps working.
export class UniqueConstraintError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
  ) {
    super(`Field "${field}" must be unique — value already exists`);
  }
}
