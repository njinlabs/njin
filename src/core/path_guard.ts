import { basename, join, normalize, sep } from "node:path";

// Resolves `requestedPath` against `baseDir` and rejects anything that escapes it
// (e.g. "../../etc/passwd") — shared by every module that serves files straight
// off disk based on a request path (uploads, admin panel SPA, etc).
export const resolveSafePath = (baseDir: string, requestedPath: string): string | null => {
  // A bare `startsWith` prefix check would let "/app/uploads-evil" pass for a
  // baseDir of "/app/uploads" — anchor the comparison to a directory boundary
  // instead so only baseDir itself (or a path inside it) matches.
  const normalizedBase = normalize(baseDir);
  const boundary = normalizedBase.endsWith(sep) ? normalizedBase : normalizedBase + sep;
  const resolved = normalize(join(baseDir, requestedPath));
  return resolved === normalizedBase || resolved.startsWith(boundary) ? resolved : null;
};

// Strips any directory component from a client-supplied filename (e.g. a multipart
// upload's `file.name`), leaving only the final path segment. Without this, a name
// like "../../../config.ts" would let an upload adapter write (or an S3 key target)
// outside the directory/prefix it's meant to be confined to.
export const sanitizeFileName = (name: string): string => {
  const base = basename(name);
  return base === "" || base === "." || base === ".." ? "file" : base;
};
