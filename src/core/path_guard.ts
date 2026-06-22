import { join, normalize } from "node:path";

// Resolves `requestedPath` against `baseDir` and rejects anything that escapes it
// (e.g. "../../etc/passwd") — shared by every module that serves files straight
// off disk based on a request path (uploads, admin panel SPA, etc).
export const resolveSafePath = (baseDir: string, requestedPath: string): string | null => {
  const resolved = normalize(join(baseDir, requestedPath));
  return resolved.startsWith(baseDir) ? resolved : null;
};
