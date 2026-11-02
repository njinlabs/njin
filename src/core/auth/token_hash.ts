import { timingSafeEqual } from "node:crypto";

// How a token's secret is stored: only its SHA-256 (hex, so it is always plain text), never the
// secret itself. A database read alone is therefore not enough to use a token.
export const hashToken = (plain: string) =>
  new Bun.CryptoHasher("sha256").update(plain).digest("hex");

export const tokenMatches = (stored: string, plain: string) => {
  const left = Buffer.from(stored);
  const right = Buffer.from(hashToken(plain));

  return left.length === right.length && timingSafeEqual(left, right);
};
