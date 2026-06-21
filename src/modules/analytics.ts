import { makeModule } from "@njin/core/module";
import Elysia from "elysia";
import geoip from "geoip-lite";
import moment from "moment";
import { Table } from "surrealdb";
import z from "zod";
import auth from "./auth";
import elysia from "./elysia";
import logger from "./logger";
import surreal from "./surreal";

const table = new Table("pageview");

type TrackInput = {
  path: string;
  referrer: string | null;
  userAgent: string | null;
  ip: string | null;
  requestUrl: string;
};

// Same-origin referrer just means "navigated from another page on this site" —
// not an actual external traffic source, so it shouldn't be counted as one.
const isSameOrigin = (referrer: string | null, requestUrl: string) => {
  if (!referrer) return false;
  try {
    return new URL(referrer).origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
};

// `server.requestIP()` only sees the direct TCP peer — behind a reverse proxy
// (nginx, etc.) that's the proxy itself, not the real visitor. Prefer the
// headers a trusted proxy sets; fall back to the socket address for direct connections.
export const resolveClientIp = (
  request: Request,
  server: { requestIP: (req: Request) => { address: string } | null } | null,
) => {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]!.trim();

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  return server?.requestIP(request)?.address ?? null;
};

const hashVisitor = (ip: string, userAgent: string) => {
  const today = moment().format("YYYY-MM-DD");
  return new Bun.CryptoHasher("sha256").update(`${ip}:${userAgent}:${today}`).digest("hex");
};

const lookupCountry = (ip: string | null) => {
  if (!ip) return null;
  return geoip.lookup(ip)?.country ?? null;
};

// from/to must be full ISO datetime strings — createdAt comparison is plain string
// comparison, and a date-only value ("YYYY-MM-DD") would silently exclude that whole
// day's records since it sorts before any datetime sharing that prefix.
const rangeQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  path: z.coerce.string().optional(),
});

const buildWhere = (from?: string, to?: string, path?: string) => {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  if (from) {
    parts.push("createdAt >= $from");
    params.from = from;
  }
  if (to) {
    parts.push("createdAt <= $to");
    params.to = to;
  }
  if (path) {
    parts.push("path = $path");
    params.path = path;
  }

  return { where: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
};

const analytics = makeModule(() => {
  const fn = () => ({
    track: async ({ path, referrer, userAgent, ip, requestUrl }: TrackInput) => {
      try {
        const country = lookupCountry(ip);
        const visitorHash = ip && userAgent ? hashVisitor(ip, userAgent) : null;
        const externalReferrer = isSameOrigin(referrer, requestUrl) ? null : referrer;

        await surreal()
          .create(table)
          .content({
            path,
            referrer: externalReferrer,
            userAgent,
            country,
            visitorHash,
            createdAt: moment().toISOString(),
          });
      } catch (e) {
        logger().error(e, "[analytics] failed to track pageview");
      }
    },
  });

  fn.init = async () => {
    const authPlugin = (await auth()).plugin;

    const controller = new Elysia({ prefix: "/api/analytics" })
      .use(authPlugin)
      .get(
        "/summary",
        async ({ query: { from, to, path } }) => {
          const { where, params } = buildWhere(from, to, path);
          const [rows] = await surreal().query<[{ visitorHash: string | null }[]]>(
            `SELECT visitorHash FROM pageview ${where}`,
            params,
          );

          const totalPageviews = rows?.length ?? 0;
          const uniqueVisitors = new Set((rows ?? []).map((r) => r.visitorHash).filter(Boolean)).size;

          return { data: { totalPageviews, uniqueVisitors } };
        },
        { auth: true, query: rangeQuery },
      )
      .get(
        "/by-country",
        async ({ query: { from, to, path } }) => {
          const { where, params } = buildWhere(from, to, path);
          const [rows] = await surreal().query<[{ country: string | null; count: number }[]]>(
            `SELECT country, count() AS count FROM pageview ${where} GROUP BY country ORDER BY count DESC`,
            params,
          );

          return { data: rows ?? [] };
        },
        { auth: true, query: rangeQuery },
      )
      .get(
        "/by-referrer",
        async ({ query: { from, to, path } }) => {
          const { where, params } = buildWhere(from, to, path);
          const [rows] = await surreal().query<[{ referrer: string | null; count: number }[]]>(
            `SELECT referrer, count() AS count FROM pageview ${where} GROUP BY referrer ORDER BY count DESC`,
            params,
          );

          return { data: rows ?? [] };
        },
        { auth: true, query: rangeQuery },
      )
      .get(
        "/by-page",
        async ({ query: { from, to } }) => {
          const { where, params } = buildWhere(from, to, undefined);
          const [rows] = await surreal().query<[{ path: string; count: number }[]]>(
            `SELECT path, count() AS count FROM pageview ${where} GROUP BY path ORDER BY count DESC`,
            params,
          );

          return { data: rows ?? [] };
        },
        {
          auth: true,
          query: rangeQuery.omit({ path: true }),
        },
      )
      .get(
        "/timeseries",
        async ({ query: { from, to, path, interval } }) => {
          const { where, params } = buildWhere(from, to, path);
          const bucketLen = interval === "hour" ? 13 : 10; // "YYYY-MM-DDTHH" vs "YYYY-MM-DD"

          const [rows] = await surreal().query<[{ date: string; count: number }[]]>(
            `SELECT string::slice(createdAt, 0, ${bucketLen}) AS date, count() AS count
             FROM pageview ${where}
             GROUP BY date
             ORDER BY date ASC`,
            params,
          );

          return { data: rows ?? [] };
        },
        {
          auth: true,
          query: rangeQuery.extend({
            interval: z.enum(["day", "hour"]).default("day"),
          }),
        },
      );

    elysia().use(controller);

    return {
      // Runs after surreal's own spin() has connected — init() itself runs too early for DB queries.
      spin: async () => {
        await surreal().query("DEFINE TABLE IF NOT EXISTS pageview SCHEMALESS;");
      },
    };
  };

  return fn;
});

export default analytics;
