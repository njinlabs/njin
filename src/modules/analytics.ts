import Elysia from "elysia";
import geoip from "geoip-lite";
import moment from "moment";
import z from "zod";
import type { Condition } from "../core/db/contract";
import { pageviewTable } from "../core/db/internal";
import { makeModule } from "../core/module";
import auth from "./auth";
import db from "./db";
import elysia from "./elysia";
import logger from "./logger";

type TrackInput = {
  path: string;
  referrer: string | null;
  userAgent: string | null;
  ip: string | null;
  requestUrl: string;
};

// Same-origin referrer just means "navigated from another page on this site" —
// not an actual external traffic source, so it shouldn't be counted as one.
export const isSameOrigin = (referrer: string | null, requestUrl: string) => {
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

// `request.url` reflects what the backend itself sees — behind a reverse proxy that
// terminates TLS (the common case), that's `http://` even though visitors hit the site
// over `https://`. That scheme mismatch alone breaks isSameOrigin's exact comparison,
// so every internal navigation gets misclassified as an external referrer. Prefer the
// headers a trusted proxy sets; fall back to request.url for direct connections.
export const resolveRequestOrigin = (request: Request) => {
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    const proto =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
    return `${proto}://${forwardedHost.split(",")[0]!.trim()}`;
  }

  return new URL(request.url).origin;
};

const hashVisitor = (ip: string, userAgent: string) => {
  const today = moment().format("YYYY-MM-DD");
  return new Bun.CryptoHasher("sha256")
    .update(`${ip}:${userAgent}:${today}`)
    .digest("hex");
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
  const where: Condition[] = [];

  if (from) where.push({ field: "createdAt", op: "$gte", value: from });
  if (to) where.push({ field: "createdAt", op: "$lte", value: to });
  if (path) where.push({ field: "path", op: "$eq", value: path });

  return where;
};

const analytics = makeModule(() => {
  const fn = () => ({
    track: async ({
      path,
      referrer,
      userAgent,
      ip,
      requestUrl,
    }: TrackInput) => {
      try {
        const country = lookupCountry(ip);
        const visitorHash = ip && userAgent ? hashVisitor(ip, userAgent) : null;
        const externalReferrer = isSameOrigin(referrer, requestUrl)
          ? null
          : referrer;

        await db().insert(pageviewTable, {
          path,
          referrer: externalReferrer,
          userAgent,
          country,
          visitorHash,
          createdAt: moment().toISOString(),
          updatedAt: moment().toISOString(),
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
          const where = buildWhere(from, to, path);
          const totalPageviews = await db().count(pageviewTable, where);
          const uniqueVisitors = (
            await db().countBy({
              table: "pageview",
              groupBy: "visitorHash",
              where,
            })
          ).filter((r) => r.key).length;

          return { data: { totalPageviews, uniqueVisitors } };
        },
        { auth: true, query: rangeQuery },
      )
      .get(
        "/by-country",
        async ({ query: { from, to, path } }) => {
          const where = buildWhere(from, to, path);
          const rows = await db().countBy({
            table: "pageview",
            groupBy: "country",
            where,
          });

          return {
            data: rows.map(({ key, count }) => ({ country: key, count })),
          };
        },
        { auth: true, query: rangeQuery },
      )
      .get(
        "/by-referrer",
        async ({ query: { from, to, path } }) => {
          const where = buildWhere(from, to, path);
          const rows = await db().countBy({
            table: "pageview",
            groupBy: "referrer",
            where,
          });

          return {
            data: rows.map(({ key, count }) => ({ referrer: key, count })),
          };
        },
        { auth: true, query: rangeQuery },
      )
      .get(
        "/by-page",
        async ({ query: { from, to } }) => {
          const where = buildWhere(from, to, undefined);
          const rows = await db().countBy({
            table: "pageview",
            groupBy: "path",
            where,
          });

          return {
            data: rows.map(({ key, count }) => ({ path: key, count })),
          };
        },
        {
          auth: true,
          query: rangeQuery.omit({ path: true }),
        },
      )
      .get(
        "/timeseries",
        async ({ query: { from, to, path, interval } }) => {
          const where = buildWhere(from, to, path);
          const bucketLen = interval === "hour" ? 13 : 10; // "YYYY-MM-DDTHH" vs "YYYY-MM-DD"

          const rows = await db().countBy({
            table: "pageview",
            groupBy: "createdAt",
            prefix: bucketLen,
            where,
          });

          return {
            data: rows.map(({ key, count }) => ({ date: key, count })),
          };
        },
        {
          auth: true,
          query: rangeQuery.extend({
            interval: z.enum(["day", "hour"]).default("day"),
          }),
        },
      );

    elysia().use(controller);

    return {};
  };

  return fn;
});

export default analytics;
