// How an admin session token's secret is stored: only its SHA-256, never the secret itself.

// Hex, so the stored value is always plain text. Earlier versions stored `digest("utf8")` — the
// raw hash bytes forced into a string — which is lossy and, about one time in eight, contains a
// NUL character that PostgreSQL refuses to store in a text column.
export const hashToken = (plain: string) =>
  new Bun.CryptoHasher("sha256").update(plain).digest("hex");

const legacyHashToken = (plain: string) =>
  new Bun.CryptoHasher("sha256").update(plain).digest("utf8");

// A token issued by an older version is still honoured, so existing sessions survive an upgrade.
export const tokenMatches = (stored: string, plain: string) =>
  stored === hashToken(plain) || stored === legacyHashToken(plain);
