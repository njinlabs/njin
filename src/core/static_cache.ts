import { mkdir, rename, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import logger from "../modules/logger";
import { getConfig } from "./config";

// On-demand static pages (ISR-style): a route listed under `static` in config.ts is rendered the
// first time a URL is requested, the HTML is kept on disk, and every later request is served from
// that file until it is purged (purgeStatic) or, with `revalidate`, gets old enough to be
// refreshed in the background. Disk (not memory) so every worker/process sharing the project
// directory sees the same cache — and the same purge.
const cacheDir = () => join(getConfig().rootDir, ".cache", "static");

const MAX_KEY_LENGTH = 512;

// A cache key is the decoded URL path without a trailing slash: "/", "/about", "/blog/hello".
// Returns null for paths that must never be cached (malformed encoding, "." / ".." / empty
// segments, absurd length) — the caller then renders live.
export const cacheKey = (path: string): string | null => {
  if (!path.startsWith("/") || path.length > MAX_KEY_LENGTH) return null;
  const segments = path.split("/").slice(1);
  if (
    segments.length > 1 &&
    segments[segments.length - 1] === "" &&
    segments[segments.length - 2] !== ""
  ) {
    segments.pop();
  }
  if (segments.length === 1 && segments[0] === "") return "/";
  try {
    const decoded = segments.map(decodeURIComponent);
    if (decoded.some((s) => s === "" || s === "." || s === "..")) return null;
    if (
      decoded.some(
        (s) => s.includes("/") || s.includes("\\") || s.includes("\0"),
      )
    )
      return null;
    return `/${decoded.join("/")}`;
  } catch {
    return null;
  }
};

const encoder = new TextEncoder();
// Lowercase letters, digits, "_", "-" and "~" stay as they are; everything else is %-escaped —
// including uppercase letters and ".", so "/blog/A" and "/blog/a" never share a file on a
// case-insensitive filesystem and no segment can ever be a dot-segment or a reserved name.
const encodeSegment = (segment: string) =>
  Array.from(segment, (char) =>
    /[a-z0-9_~-]/.test(char)
      ? char
      : Array.from(
          encoder.encode(char),
          (b) => `%${b.toString(16).padStart(2, "0")}`,
        ).join(""),
  ).join("");

const keyDir = (key: string) =>
  key === "/"
    ? cacheDir()
    : join(cacheDir(), ...key.slice(1).split("/").map(encodeSegment));
const keyFile = (key: string) => join(keyDir(key), "index.html");

// A purge cancels the renders already running for the URLs it drops, so a render that started
// before the purge never writes its (possibly stale) result into the cache afterwards.
type Job = { promise: Promise<string>; cancelled: boolean };
const inflight = new Map<string, Job>();

const cancelInflight = (match: (key: string) => boolean) => {
  for (const [key, job] of inflight) {
    if (!match(key)) continue;
    job.cancelled = true;
    inflight.delete(key);
  }
};

const writeStatic = async (key: string, html: string) => {
  const file = keyFile(key);
  await mkdir(dirname(file), { recursive: true });
  // Write + rename, so a concurrent reader never sees a half-written file.
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await Bun.write(tmp, html);
  await rename(tmp, file);
};

export const readStatic = async (key: string): Promise<string | null> => {
  const file = Bun.file(keyFile(key));
  return (await file.exists()) ? file.text() : null;
};

// One shared render per key. A render that throws is never cached; a render that was cancelled
// by a purge still answers its own callers but doesn't write.
const startRender = (
  key: string,
  render: () => Promise<string>,
): Promise<string> => {
  const pending = inflight.get(key);
  if (pending) return pending.promise;

  const job: Job = { cancelled: false, promise: Promise.resolve("") };
  job.promise = (async () => {
    const html = await render();
    if (!job.cancelled) {
      await writeStatic(key, html).catch(() => {
        // Caching is best-effort — a read-only disk just means rendering on every hit.
      });
    }
    return html;
  })().finally(() => {
    if (inflight.get(key) === job) inflight.delete(key);
  });
  inflight.set(key, job);
  return job.promise;
};

export type CacheState = "HIT" | "MISS" | "STALE";

// Returns the cached HTML for `key`, rendering (and caching) it on a miss. With `revalidate`
// (seconds), a page older than that is still served as-is (STALE) while a fresh render replaces
// it in the background; if that render fails the old page stays.
export const getOrRenderStatic = async (
  key: string,
  render: () => Promise<string>,
  revalidate?: number,
): Promise<{ html: string; state: CacheState }> => {
  const file = keyFile(key);
  const info = await stat(file).catch(() => null);
  const cached = info
    ? await Bun.file(file)
        .text()
        .catch(() => null)
    : null;

  if (info && cached !== null) {
    const stale =
      revalidate !== undefined && Date.now() - info.mtimeMs > revalidate * 1000;
    if (stale) {
      startRender(key, render).catch((err) =>
        logger().error(err, `[static] failed to revalidate ${key}`),
      );
    }
    return { html: cached, state: stale ? "STALE" : "HIT" };
  }

  return { html: await startRender(key, render), state: "MISS" };
};

// Plain (param-less) static routes are known up front, so they can be rendered ahead of the
// first visitor — at boot, and again right after a purge.
type Warmable = { render: () => Promise<string>; revalidate?: number };
const warmable = new Map<string, Warmable>();

export const registerStaticRoute = (key: string, entry: Warmable) => {
  warmable.set(key, entry);
};

// Renders (and caches) the given plain static routes — all of them by default — one after the
// other, so warming never floods the database. Failures are logged, never thrown.
export const warmStatic = async (keys?: string[]): Promise<void> => {
  for (const key of keys ?? [...warmable.keys()]) {
    const entry = warmable.get(key);
    if (!entry) continue;
    try {
      await getOrRenderStatic(key, entry.render, entry.revalidate);
    } catch (err) {
      logger().error(err, `[static] failed to warm ${key}`);
    }
  }
};

// Regex (matched against the request URL, query string included) for the URLs a purge covers.
// Case-insensitive because clients disagree on the case of %-escapes.
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const banRegex = (key: string | null, subtree: boolean) => {
  if (key === null) return "^/";
  const path =
    key === "/"
      ? ""
      : key
          .slice(1)
          .split("/")
          .map((s) => `/${escapeRegex(encodeURIComponent(s))}`)
          .join("");
  if (subtree) return `(?i)^${path}([/?].*)?$`;
  return `(?i)^${path}/?(\\?.*)?$`;
};

// Tells the shared cache in front of njin (config `edgeCache`) to drop what it holds. Best-effort:
// a cache that is down just keeps its copy until s-maxage runs out.
const banEdge = async (key: string | null, subtree: boolean) => {
  const { edgeCache: edge, publicUrl } = getConfig();
  if (!edge) return;
  const regex = banRegex(key, subtree);
  const host = publicUrl ? new URL(publicUrl).host : null;
  await Promise.all(
    edge.ban.map(
      (base) =>
        // node:http, not fetch — Bun's fetch rewrites unknown methods like BAN to GET.
        new Promise<void>((resolve) => {
          const done = (err?: unknown) => {
            if (err)
              logger().error(err, `[static] failed to BAN ${regex} on ${base}`);
            resolve();
          };
          try {
            const req = httpRequest(
              `${base}${key === null ? "/" : key}`,
              {
                method: "BAN",
                timeout: 3000,
                headers: {
                  ...(host ? { Host: host } : {}),
                  ...edge.headers,
                  "X-Ban-Url": regex,
                },
              },
              (res) => {
                res.resume();
                res.on("end", () =>
                  done(
                    (res.statusCode ?? 0) >= 400
                      ? new Error(`HTTP ${res.statusCode}`)
                      : undefined,
                  ),
                );
              },
            );
            req.on("timeout", () => req.destroy(new Error("timeout")));
            req.on("error", done);
            req.end();
          } catch (err) {
            done(err);
          }
        }),
    ),
  );
};

// Drops cached HTML so the next request renders it again. Call it AFTER the content changed —
// from a hook, event, route or anywhere else in the app:
//
//   import { purgeStatic } from "@njinlabs/njin/static";
//   await purgeStatic("/about");      // that one URL
//   await purgeStatic("/blog/hello"); // one URL of a dynamic route
//   await purgeStatic("/blog/*");     // /blog and everything under it
//   await purgeStatic();              // every static page
//
// Plain routes are re-rendered right away in the background (so no visitor pays for it); pass
// `{ warm: false }` to leave them until their next request.
export const purgeStatic = async (
  path?: string,
  options: { warm?: boolean } = {},
): Promise<void> => {
  let affected: string[] | undefined;
  if (path === undefined || path === "/*") {
    cancelInflight(() => true);
    await rm(cacheDir(), { recursive: true, force: true });
    await banEdge(null, true);
  } else if (path.endsWith("/*")) {
    const prefix = cacheKey(path.slice(0, -2) || "/");
    if (prefix === null) throw new Error(`Invalid purge path "${path}"`);
    cancelInflight((k) => k === prefix || k.startsWith(`${prefix}/`));
    await rm(keyDir(prefix), { recursive: true, force: true });
    await banEdge(prefix, true);
    affected = [...warmable.keys()].filter(
      (k) => k === prefix || k.startsWith(`${prefix}/`),
    );
  } else {
    const key = cacheKey(path);
    if (key === null) throw new Error(`Invalid purge path "${path}"`);
    cancelInflight((k) => k === key);
    await rm(keyFile(key), { force: true });
    await banEdge(key, false);
    affected = [key];
  }

  if (options.warm !== false) void warmStatic(affected);
};
