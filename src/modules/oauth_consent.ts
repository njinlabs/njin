import Elysia, { status } from "elysia";
import moment from "moment";
import z from "zod";
import { intersectScopes, isScope, scopeCovers } from "../core/auth/access";
import type { Row } from "../core/db/contract";
import { oauthConsentTable, tokenTable } from "../core/db/internal";
import { makeModule } from "../core/module";
import auth from "./auth";
import db from "./db";
import elysia from "./elysia";

// What a user has let an OAuth client do on their behalf — one row per (user, client). It is why
// a client they approved before does not ask again, and the "connected apps" they can look at,
// narrow or take away.

export type Consent = {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  grantedAt: string | null;
  lastUsedAt: string | null;
};

const text = (value: unknown) => (typeof value === "string" ? value : null);

const texts = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const toConsent = (row: Row): Consent | null => {
  const userId = text(row.user);
  const clientId = text(row.clientId);
  if (!userId || !clientId) return null;

  return {
    id: row.id,
    userId,
    clientId,
    clientName: text(row.clientName) ?? "Unknown client",
    scopes: texts(row.scopes),
    grantedAt: text(row.grantedAt),
    lastUsedAt: text(row.lastUsedAt),
  };
};

export const findConsent = async (userId: string, clientId: string) => {
  const { rows } = await db().list(oauthConsentTable, {
    where: [
      { field: "user", op: "$eq", value: userId },
      { field: "clientId", op: "$eq", value: clientId },
    ],
    page: 1,
    limit: 1,
    populate: [],
  });

  const row = rows[0];
  return row ? toConsent(row) : null;
};

// Approving again adds to what was approved before; narrowing is done on purpose, below.
const mergeScopes = (a: readonly string[], b: readonly string[]) =>
  a.includes("*:*") || b.includes("*:*") ? ["*:*"] : [...new Set([...a, ...b])];

export const rememberConsent = async (input: {
  userId: string;
  clientId: string;
  clientName: string;
  scopes: readonly string[];
}) => {
  const now = moment().toISOString();
  const existing = await findConsent(input.userId, input.clientId);

  if (existing) {
    await db().update(oauthConsentTable, existing.id, {
      clientName: input.clientName,
      scopes: mergeScopes(existing.scopes, input.scopes),
      lastUsedAt: now,
    });
    return existing.id;
  }

  const created = await db().insert(oauthConsentTable, {
    user: input.userId,
    clientId: input.clientId,
    clientName: input.clientName,
    scopes: [...input.scopes],
    grantedAt: now,
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return created.id;
};

const tokensOf = async (consentId: string) => {
  const { rows } = await db().list(tokenTable, {
    where: [{ field: "consent", op: "$eq", value: consentId }],
    page: 1,
    limit: 1000,
    populate: [],
  });
  return rows;
};

const toPublic = (consent: Consent, tokens: Row[]) => {
  const lastUsed = [
    consent.lastUsedAt,
    ...tokens.map((token) => text(token.lastUsedAt)),
  ]
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);

  return {
    id: consent.id,
    clientId: consent.clientId,
    clientName: consent.clientName,
    scopes: consent.scopes,
    grantedAt: consent.grantedAt,
    lastUsedAt: lastUsed ?? null,
    tokens: tokens.length,
  };
};

// Only the user's own: someone else's is "not found".
const findOwn = async (userId: string, id: string) => {
  const row = await db().find(oauthConsentTable, id);
  const consent = row ? toConsent(row) : null;
  return consent?.userId === userId ? consent : null;
};

const oauthConsent = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const authPlugin = (await auth()).plugin;

    // Managed with a session only, like the rest of a user's credentials: an agent must not be
    // able to widen, or undo the removal of, its own access.
    const controller = new Elysia({ prefix: "/api/oauth/consents" })
      .use(authPlugin)
      .get(
        "/",
        async ({ principal }) => {
          const { rows } = await db().list(oauthConsentTable, {
            where: [{ field: "user", op: "$eq", value: principal.user.id }],
            page: 1,
            limit: 1000,
            sort: { field: "createdAt", order: "desc" },
            populate: [],
          });

          const data = await Promise.all(
            rows.flatMap((row) => {
              const consent = toConsent(row);
              return consent
                ? [
                    tokensOf(consent.id).then((tokens) =>
                      toPublic(consent, tokens),
                    ),
                  ]
                : [];
            }),
          );

          return { data };
        },
        { auth: { session: true } },
      )
      .put(
        "/:id",
        async ({ params, body, principal }) => {
          const consent = await findOwn(principal.user.id, params.id);
          if (!consent) return status(404, { message: "Not found" });

          if (!scopeCovers(consent.scopes, body.scopes)) {
            return status(422, {
              message: "Access can be narrowed here, not widened",
            });
          }

          await db().update(oauthConsentTable, consent.id, {
            scopes: body.scopes,
          });

          // What the client already holds shrinks with it.
          const tokens = await tokensOf(consent.id);
          for (const token of tokens) {
            await db().update(tokenTable, token.id, {
              scopes: intersectScopes(texts(token.scopes), body.scopes),
            });
          }

          return {
            data: toPublic({ ...consent, scopes: body.scopes }, tokens),
          };
        },
        {
          auth: { session: true },
          params: z.object({ id: z.coerce.string() }),
          body: z.object({
            scopes: z
              .array(z.string().refine(isScope, "Use <resource>:<action>"))
              .min(1),
          }),
        },
      )
      .delete(
        "/:id",
        async ({ params, principal }) => {
          const consent = await findOwn(principal.user.id, params.id);
          if (!consent) return status(404, { message: "Not found" });

          // The client's tokens go with it, so it stops working at once.
          await db().removeWhere(tokenTable, [
            { field: "consent", op: "$eq", value: consent.id },
          ]);
          await db().remove(oauthConsentTable, consent.id);

          return { data: toPublic(consent, []) };
        },
        {
          auth: { session: true },
          params: z.object({ id: z.coerce.string() }),
        },
      );

    elysia().use(controller);

    return {};
  };

  return fn;
});

export default oauthConsent;
