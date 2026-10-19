import { z } from "zod";
import { getConfig } from "../config";
import { fieldMeta } from "../db/table_def";
import { HttpError } from "../http_error";

// What models (./i18n.ts) and settings groups (../vars) share for fields kept once per language.

export const settings = () => {
  const i18n = getConfig().i18n;
  if (!i18n) {
    throw new Error(
      "`i18n: true` needs `i18n: { locales: [...] }` in config.ts.",
    );
  }
  return i18n;
};

export const assertLocale = (locale: string) => {
  if (!settings().locales.includes(locale)) {
    throw new HttpError(
      400,
      `Unknown locale "${locale}" — configured: ${settings().locales.join(", ")}`,
    );
  }
};

// A single language code; "all" and "" mean every language.
export const isOneLocale = (locale: string | undefined): locale is string =>
  typeof locale === "string" && locale !== "" && locale !== "all";

// Nothing in it: null, an empty list, or an object whose every value is itself empty (a SQL
// database reads an object with nothing set as null, SurrealDB as an object of nulls).
export const isEmpty = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as object).every(isEmpty));

// A value in a form two values can be compared in: key order and "nothing" do not matter.
export const stable = (value: unknown): unknown => {
  if (isEmpty(value)) return null;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, stable(source[key])]),
    );
  }
  return value;
};

type Rec = Record<string, any>;

// A relation field of a model: the model it points at, and whether it holds a list.
export type Link = { name: string; target: string; many: boolean };

// The relation() / relationMany() fields of a schema (a file is a link too, but to the file
// model, which has no languages).
export const linksOf = (schema: z.ZodObject): Link[] =>
  Object.entries(schema.shape as Record<string, z.ZodType>).flatMap(
    ([name, field]) => {
      const meta = fieldMeta(field);
      if (meta.renderAs !== "relation" && meta.renderAs !== "multi_relation") {
        return [];
      }
      return [
        {
          name,
          target: String(meta.model),
          many: meta.renderAs === "multi_relation",
        },
      ];
    },
  );

// The table of an i18n model that has one row per record and language, and the columns that
// say which record and which language a row is.
export const translationTableName = (prefix: string) => `${prefix}__i18n`;
export const TRANSLATION_KEY = "article_id";
export const TRANSLATION_LOCALE = "locale";

// An i18n model, as far as a relation pointing at it is concerned.
export type LocalizedSource = {
  // The records with these ids in one language, flat. An id with no row in the language takes
  // the default language's row when `fallback` allows; an id with no row at all is left out.
  records(
    ids: readonly string[],
    locale: string,
    fallback: boolean,
  ): Promise<Map<string, Rec>>;
};

const sources = new Map<string, LocalizedSource>();

// Called by every i18n model, so a relation to it can be read in the language being read.
export const registerLocalizedSource = (
  prefix: string,
  source: LocalizedSource,
) => {
  sources.set(prefix, source);
};

export const hasLocalizedSource = (prefix: string) => sources.has(prefix);

const isRecord = (value: unknown): value is Rec =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// A relation takes on the language of the model it points at: where that model has i18n, the
// related records that were populated become their record in `locale` (the default language
// when none is given). A relation to a model without i18n is the same in every language and is
// left alone, as is a link that was not populated. A record the target has in no language at all
// stays as the shared row the database populated.
export const localizeLinks = async (
  rows: readonly Rec[],
  links: readonly Link[],
  locale: string | undefined,
  fallback = true,
) => {
  for (const link of links) {
    const source = sources.get(link.target);
    if (!source) continue;

    const populated = rows.flatMap((row) => {
      const value = row[link.name];
      return (link.many ? (Array.isArray(value) ? value : []) : [value]).filter(
        isRecord,
      );
    });
    const ids = [...new Set(populated.map((record) => String(record.id)))];
    if (ids.length === 0) continue;

    const language = isOneLocale(locale) ? locale : settings().defaultLocale;
    const found = await source.records(ids, language, fallback);
    const swap = (value: unknown) =>
      isRecord(value) ? (found.get(String(value.id)) ?? value) : value;

    for (const row of rows) {
      const value = row[link.name];
      row[link.name] =
        link.many && Array.isArray(value) ? value.map(swap) : swap(value);
    }
  }
};

// `{ locale: value }` for a field that is kept once per language. The keys must be configured
// locales (checked when the value is parsed); the field is optional when its own schema is.
export const localeMapSchema = (field: z.ZodType) => {
  const map = z
    .record(z.string(), field)
    .superRefine((value, ctx) => {
      const allowed = new Set(settings().locales);
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          ctx.addIssue({
            code: "custom",
            message: `Unknown locale "${key}"`,
            path: [key],
          });
        }
      }
    })
    .meta({ label: fieldMeta(field).label, localized: true });

  return field.safeParse(undefined).success ? map.optional() : map;
};
