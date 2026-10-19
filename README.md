# njin

[![CI](https://github.com/njinlabs/njin/actions/workflows/ci.yml/badge.svg)](https://github.com/njinlabs/njin/actions/workflows/ci.yml)
[![CodeQL](https://github.com/njinlabs/njin/actions/workflows/codeql.yml/badge.svg)](https://github.com/njinlabs/njin/actions/workflows/codeql.yml)
[![npm version](https://img.shields.io/npm/v/%40njinlabs%2Fnjin.svg)](https://www.npmjs.com/package/@njinlabs/njin)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A modern framework for building company profiles, landing pages, and content-driven websites. Define your data model once — get a full REST API, admin panel schema, and server-rendered website out of the box.

## Stack

- **[Bun](https://bun.sh)** — runtime, package manager, bundler (njin is Bun-only — no Node/Deno support)
- **[Elysia](https://elysiajs.com)** — HTTP framework with type-safe CRUD generation
- **[SurrealDB](https://surrealdb.com)** — the default database, embedded (no separate server) or pointed at a remote instance. Storage goes through a swappable database adapter (see [Database adapters](#database-adapters))
- **[EdgeJS](https://edgejs.dev)** — server-side template engine with file-based routing
- **[Vite](https://vitejs.dev)** + **[Tailwind CSS v4](https://tailwindcss.com)** + **[Alpine.js](https://alpinejs.dev)** — frontend tooling

## Quick start

```bash
bunx @njinlabs/njin create my-web
cd my-web
bunx njin dev
```

## Project structure

```
config.ts           ← registers models, db, file adapter, etc. (see below)
src/
  models/            ← your data models
  views/
    layouts/         ← base layout templates
    pages/           ← file-based routes (.edge files)
    components/      ← reusable .edge components
  client/
    main.ts          ← frontend entry point
    app.css          ← Tailwind CSS
_admin/              ← optional — drop a built admin panel SPA here (not bundled with njin)
vite.config.ts       ← Vite config
```

`@njinlabs/njin` itself lives in `node_modules/@njinlabs/njin` — there's no framework source to look at or modify inside your project.

## Defining a model

```ts
// src/models/post.ts
import { makeModel, text, date, select } from "@njinlabs/njin";
import z from "zod";

const post = makeModel("post", {
  name: "Post",
  searchFields: ["title"],
  schema: z.object({
    title:     text({ label: "Title" }),
    body:      text({ label: "Body" }),
    status:    select({ label: "Status" }, ["DRAFT", "PUBLISH"]),
    publishedAt: date({ label: "Published At" }),
  }),
});

export default post;
```

`searchFields` can also reach one level into a `relation`/`multiRelation`/`file`/`multiFile` field
using dot notation, e.g. `searchFields: ["title", "author.name"]` to search `post` by its related
`author`'s `name` field. A bad reference (the local field isn't a relation, or more than one level
of nesting is used) throws when `makeModel()` is called, not at query time.

Register it in `config.ts` at the project root:

```ts
// config.ts
import { defineConfig } from "@njinlabs/njin/config";

export default defineConfig({
  models: [
    () => import("./src/models/post"),
  ],
});
```

This automatically generates:

| Method | Endpoint | Description |
|--------|----------|--------------|
| `GET` | `/api/post` | List with pagination, search, filter, sort |
| `POST` | `/api/post` | Create |
| `GET` | `/api/post/:id` | Show (with relations fetched) |
| `PUT` | `/api/post/:id` | Update |
| `DELETE` | `/api/post/:id` | Delete |
| `GET` | `/api/schema` | Full schema for admin panel |

### Draft & publish

Add `draftable: true` to `makeModel` and each record gets a `status` and `publishedAt`. Editing a published record never takes it offline: edits go to the *working copy*, and the live copy only changes when you publish.

```ts
const post = makeModel("post", {
  name: "Post",
  draftable: true,
  searchFields: ["title"],
  schema: z.object({ title: text({ label: "Title" }) }),
});

await post.read();             // working copies — everything, newest edits (what the admin panel shows)
await post.published.read();   // what is live; same options as read()
await post.published.show(id);
await post.publish(id);        // working copy → live
await post.unpublish(id);      // takes it offline, keeps the working copy as a draft
await post.discard(id);        // drops unpublished edits (working copy ← live)
```

`status` is `draft` (never published, or unpublished), `published`, or `changed` (published, with edits that are not live yet). It is filterable like any field: `post.read({ filters: { status: "changed" } })`. Nothing is filtered for you — pick `read()` or `published.read()` where you query.

The live copies are kept in a second table, `_published_<prefix>`, created automatically with the same fields. `publish`, `unpublish` and `discard` each run as one database transaction, so a failure halfway leaves both tables as they were, and the `after*` hooks only fire once it has committed. Turning `draftable` on for a model that already has records publishes them once at boot, so the site does not go empty. `afterPublish(model, fn)` and `afterUnpublish(model, fn)` hooks exist for things like purging static pages. Over the API: `POST /api/{prefix}/:id/publish`, `/unpublish` and `/discard`; over MCP: `publish_record`, `unpublish_record`, `discard_changes`.

### Languages (i18n)

> Combined with `draftable: true` (below) every language of a record is drafted and published on its own.

Declare the languages in `config.ts`, then mark a model with `i18n: true` and the fields that differ per language with `localized: true`:

```ts
// config.ts
export default defineConfig({
  i18n: { locales: ["id", "en"], defaultLocale: "id" },
});

// src/models/article.ts
const article = makeModel("article", {
  name: "Article",
  i18n: true,
  searchFields: ["title"],
  schema: z.object({
    slug: text({ label: "Slug", unique: true, localized: true }), // unique per language
    title: text({ label: "Title", localized: true }),
    views: numeric({ label: "Views" }).optional(),                // the same in every language
    author: relation({ label: "Author" }, user),                  // the same in every language
    faq: array({ label: "FAQ", localized: true }, z.string()).optional(), // per language: any field can be
    labels: array({ label: "Labels" }, z.string()).optional(),    // ...or shared, like this one (the default)
  }),
});
```

Writes take a localized field as an object keyed by language; a language you leave out is untouched, `null` clears an optional field:

```ts
await article.create({
  slug: { id: "tentang", en: "about" },
  title: { id: "Tentang kami", en: "About us" },
  views: 0,
});
await article.update(id, { title: { en: "About" } });   // only the English title changes
await article.removeLocale(id, "en");                   // the last language cannot be removed
```

Reading is where the language is chosen:

```ts
await article.read({ locale: "en", filters: { slug: "about" } }); // flat records of one language; `id` is the record's id
await article.show(id, { locale: "en" });
await article.read();                                             // every language: title is { id: "...", en: "..." }
```

With a `locale`, filters, sorting, search and pagination work on every field — the language's own and the shared ones alike. A field the language has no value for is filled from the default locale (`fallback: false` turns that off), and only the records that have that language are listed. Without a locale, a condition on a localized field is answered across all languages and a record that matches in several is listed once (so a page can hold fewer than `limit` records).

Every field — an array or an object included — is shared unless it says `localized: true`; an `object()` is changed key by key (`seo: { description: "x" }` leaves `seo.title` alone, `null` clears it), inside one language when it is localized and in every language when it is shared, and a localized object with nothing set falls back to the default language as a whole; a localized array is written like the other localized fields (`faq: { id: [...], en: [...] }`), a shared one as usual (`labels: [...]`). Behind the scenes the model is two tables: `article` holds what is shared and is what other models link to, and `article__i18n` has one row per record and language (`<id>.<locale>`) with the localized fields plus a copy of the shared ones (shared arrays included), which the writes keep in step. Deleting a record deletes its languages. **Decide on languages when you create the model.** Turning `i18n: true` (or `localized: true` on a field) on for a model or settings group that already holds data is not supported yet: the existing records have no language rows, so they do not show up in `read({ locale })`, and a saved plain value in a field that became localized is not read as one. There is no migration for it. **Links.** A `relation()` / `relationMany()` takes on the language of the model it points at, and is never `localized` itself. Pointing at a model without `i18n`, it is the same record in every language. Pointing at one with `i18n`, a record read in `locale: "en"` has the related record *in English* (its default-language row when it has no English one, unless `fallback: false`) — and in the default language when no locale is given. This holds for any model that reads the relation, i18n or not: `post.read({ locale: "en" })`, `post.show(id, { locale })`. A `file()` / `multiFile()` is the other case: it can differ per language (`cover: file({ label: "Cover", localized: true })`, written as `cover: { id: fileId, en: otherFileId }`; an empty language falls back to the default language's file). `select: ["category.name"]` and `searchFields: ["category.name"]` reach a localized field of the related model as well: the projection is taken from the related record in the language being read, and a search matches that language's text — or the text of every language when no `locale` is given. Links to a model with drafts are read from its working copy. Over the API: `GET /api/{prefix}?locale=en`, `GET /api/{prefix}/:id?locale=en` and `DELETE /api/{prefix}/:id/locale/:locale`; over MCP: the `locale` argument of `read_records` / `get_record` and `remove_locale`.

#### Draft & publish per language

```ts
const article = makeModel("article", { i18n: true, draftable: true, /* ... */ });

article.create({ title: { id: "Tentang", en: "About" }, /* ... */ });  // every language starts as a draft
await article.publish(id, { locale: "en" });      // only English goes live (a list, or nothing for every language)
await article.update(id, { title: { en: "About us" } });   // English is now "changed"; what is live stays
await article.unpublish(id, { locale: "en" });
await article.discard(id, { locale: "en" });      // drops that language's unpublished localized edits

await article.published.read({ locale: "en", filters: { slug: "about" } }); // what is live, one language at a time
await article.read({ locale: "en", filters: { status: "changed" } });       // the working copies of a language
(await article.show(id)).status;                  // { id: "draft", en: "published" } — one status per language
```

A language has its own status (`draft` / `published` / `changed`) and its own live copy, in `_published_<prefix>__i18n` (one row per record and language). A change to a field shared by every language marks each language that is live as `changed`, and goes live with the next publish; publishing one language also brings the shared fields of the other live languages level, so a language that only differed in those is `published` again. `published.read()` needs a `locale`, and a missing value falls back to the default language's *live* copy. Deleting a record, or one language of it, takes its live copy with it. Over the API: `POST /api/{prefix}/:id/publish?locale=en,id` (likewise `unpublish`, `discard`); over MCP: the `locale` argument of `publish_record`, `unpublish_record` and `discard_changes`.

## Vars — user-editable settings

`vars` groups are singleton settings objects (site name, SEO meta, feature toggles, ...) meant to be edited later through an admin panel — unlike a model, there's no list of records, just one object per group.

```ts
// src/vars/general.ts
import { makeVars, text, boolean } from "@njinlabs/njin";
import z from "zod";

const general = makeVars("general", {
  name: "General",
  schema: z.object({
    // Every field needs a .default(...) — there's no "create" step, so
    // get() must always return a complete object even before anything
    // has ever been saved.
    siteName: text({ label: "Site Name" }, (z) => z.default("My Site")),
    maintenanceMode: boolean({ label: "Maintenance Mode" }, (z) => z.default(false)),
  }),
});

export default general;
```

Register it in `config.ts`:

```ts
// config.ts
export default defineConfig({
  vars: [
    () => import("./src/vars/general"),
  ],
});
```

This automatically generates:

| Method | Endpoint | Description |
|--------|----------|--------------|
| `GET` | `/api/vars/general` | Read current values (defaults-filled even before the first save) |
| `PUT` | `/api/vars/general` | Partial update — merges into the existing values |
| `GET` | `/api/schema` | Also lists every registered vars group's schema, under a `vars` key |

`vars` groups are also available in templates as global async functions, same as models — but only `get()`/`update()`, not the full model method set:

```edge
@let(settings = await general.get())
<title>{{ settings.siteName }}</title>
```

### Languages and drafts for vars

A group takes the same two options as a model. `i18n: true` keeps the fields marked `localized: true` once per language (`config.i18n`); `draftable: true` keeps a live copy apart from the working copy:

```ts
const site = makeVars("site", {
  name: "Site",
  i18n: true,
  draftable: true,
  schema: z.object({
    tagline: text({ label: "Tagline", localized: true }, (z) => z.default("Selamat datang")),
    phone: text({ label: "Phone" }, (z) => z.default("")),     // the same in every language
  }),
});

await site.update({ tagline: { en: "Welcome" } });   // only English changes; a language you leave out is untouched, null clears it
await site.get();                                    // working copy, every language: tagline is { id: "...", en: "..." }
await site.get({ locale: "en" });                    // one language, flat (a missing value falls back to the default language)

await site.publish({ locale: "en" });                // English goes live (a list, or nothing for every language)
await site.published.get({ locale: "en" });          // what is live — use this in public templates
await site.unpublish({ locale: "en" });
await site.discard({ locale: "en" });                // that language's unpublished localized edits are dropped
(await site.get()).status;                           // { id: "draft", en: "published" }; a plain string without i18n
```

A localized field is stored as a `{ locale: value }` map inside the group's one document (a group is only read and written as a whole, so no translation table is needed). `status` is `draft`, `published` or `changed`, worked out by comparing the working copy with the live one: editing a field shared by every language marks each live language `changed`, and publishing one language puts the shared fields live for all of them. The values a language really has are what get published — an empty language stays empty live and falls back to the default language's *live* value. Not-yet-published groups read as their `.default()`s on `published.get()`; turning `draftable` on for a group that already has saved values publishes them once at boot. A localized field can be a file or a list of files, not a relation. Over the API: `GET /api/vars/{name}?locale=en`, `GET /api/vars/{name}/published?locale=en`, `POST /api/vars/{name}/publish?locale=en,id` (likewise `unpublish`, `discard`); over MCP: the `locale` and `published` arguments of `get_vars`, and `publish_vars` / `unpublish_vars` / `discard_vars`. Hooks: `afterVarsPublish`, `afterVarsUnpublish`.

## Helpers — custom template functions

`helpers` register a plain, stateless function as an Edge global — unlike `vars`/`models`, there's no DB record and no auto-generated REST endpoint, just a function callable from any `.edge` template.

```ts
// src/helpers/format_date.ts
import { defineHelper } from "@njinlabs/njin";
import moment from "moment";

export default defineHelper("formatDate", (date: string, format = "DD MMM YYYY") =>
  moment(date).format(format),
);
```

Register it in `config.ts`:

```ts
// config.ts
export default defineConfig({
  helpers: [
    () => import("./src/helpers/format_date"),
  ],
});
```

Use it directly in a template, no `await` needed since it's a plain synchronous function (an `async` `fn` works too, called with `await` like any other async global):

```edge
<p>{{ formatDate(post.createdAt) }}</p>
```

## Events

A type-safe event bus for fan-out notifications (e.g. "an order was paid", "a user registered") — different from model hooks (`beforeCreate`/`afterCreate`/...): hooks are scoped to one model and can abort the operation by throwing, while events are fire-and-forget — a listener that throws is logged but never stops other listeners or the code that dispatched.

`makeEvent()` has no name — dispatch and listen are correlated by sharing the same instance (not a string key), so always define one event in one canonical file and import it wherever you need it:

```ts
// src/events/order_paid.ts
import { makeEvent } from "@njinlabs/njin";

const orderPaid = makeEvent<{ orderId: string; total: number }>();

export default orderPaid;
```

```ts
// src/events/listeners/send_receipt.ts
import orderPaid from "../order_paid";

orderPaid.listen(async (payload) => {
  // errors here are caught and logged, they never bubble back to whoever dispatched
  console.log(`Sending receipt for order ${payload.orderId} ($${payload.total})`);
});
```

Register the listener file in `config.ts` so it's imported (and its `.listen()` call runs) at boot:

```ts
// config.ts
export default defineConfig({
  events: [
    () => import("./src/events/listeners/send_receipt"),
  ],
});
```

## Plugins

A plugin bundles models/vars/hooks/events/routes into one reusable, installable unit — like a self-contained njin app that extends whatever project installs it. It's a factory function that takes options and returns its bundle, so it ships as a plain npm package:

```ts
// my-plugin/index.ts
import { definePlugin } from "@njinlabs/njin";

export default (options: { apiKey: string }) =>
  definePlugin({
    models: [() => import("./models/order")],
    routes: [() => import("./routes/webhook")],
    init: async () => {
      // runs once at boot, before any model/route/hook/event goes live —
      // validate options, construct an SDK client, etc.
    },
  });
```

Register it in `config.ts` — the factory is called directly (not wrapped in another thunk), same as `adapters.file`:

```ts
// config.ts
import myPlugin from "my-plugin";

export default defineConfig({
  plugins: [myPlugin({ apiKey: process.env.MY_PLUGIN_KEY! })],
});
```

Everything a plugin contributes is merged in ahead of your own project's models/vars/hooks/events/routes — so your project's own registrations always run after, and can build on top of what the plugin sets up.

Dispatch from anywhere — for example, composing with a model's `afterCreate` hook:

```ts
// src/models/order.ts
import { makeModel, afterCreate } from "@njinlabs/njin";
import orderPaid from "../events/order_paid";

const order = makeModel("order", { /* ... */ });

afterCreate(order, (record) => {
  orderPaid.dispatch({ orderId: record.id, total: record.total });
});

export default order;
```

## File-based routing

Files in `src/views/pages/` map to routes automatically:

```
pages/index.edge          → GET /
pages/about.edge          → GET /about
pages/blog/index.edge     → GET /blog
pages/blog/[slug].edge    → GET /blog/:slug
```

## Static pages

List page routes under `static` in `config.ts`. In production each URL is rendered on its **first request**, the HTML is cached on disk, and every later request is served from that file until you purge it (or it goes stale).

```ts
export default defineConfig({
  static: [
    "/",
    "/about",
    "/blog/:slug", // dynamic: every slug is cached on its own (`[slug]` works too)
    { route: "/news", revalidate: 60 }, // refresh in the background once it is 60s old
  ],
});
```

Purge from anywhere in your code (a hook, event, custom route…) — call it **after** the content changed:

```ts
import { purgeStatic } from "@njinlabs/njin/static";

await purgeStatic("/about"); // one URL
await purgeStatic("/blog/hello"); // one URL of a dynamic route
await purgeStatic("/blog/*"); // /blog and everything under it
await purgeStatic(); // every static page
await purgeStatic("/about", { warm: false }); // don't re-render it right away
```

- Pages render live, so models, vars and helpers all work.
- **Warm-up:** plain routes (no `:param`) are rendered at server start and again right after a purge, so visitors don't pay for the render. Dynamic URLs render on their first hit.
- **Revalidate:** with `revalidate: <seconds>`, a page older than that is still served immediately while a fresh render replaces it in the background. If that render fails, the old page stays.
- **Debugging:** responses carry `X-Njin-Cache: HIT | MISS | STALE` (`BYPASS` for a URL that can't be cached, e.g. malformed encoding).
- The cache lives in `.cache/static/` (add it to `.gitignore`) and is cleared on every server start, so a deploy never serves stale HTML. It is shared by every process using the project directory, so a purge applies to all of them.
- Served with the same headers/ETag as a live page. Analytics still records the visit. Errors and `abort()` responses are never cached — a dynamic page should `abort(404)` for unknown params, otherwise every URL a visitor invents becomes a cache file.
- A static page is the same for everyone: `query` is empty, and `request.url` is built from `publicUrl` (the request's origin if unset). Don't put per-user or per-query content in it.
- `njin dev` ignores `static` and always renders live.

### Behind Varnish / a CDN

Static pages are sent with `Cache-Control: public, max-age=0, s-maxage=<n>, stale-while-revalidate=<m>`: browsers still revalidate through the ETag (`max-age=0`), while a shared cache may keep the page. `s-maxage` is the route's `revalidate` (with `stale-while-revalidate` of the same length); a route without `revalidate` gets `s-maxage=86400` and relies on `purgeStatic()`. Live pages, `BYPASS` responses and errors are never marked `public`.

Because a route with `revalidate` can be served stale by njin and then cached again by the proxy, a page may be up to about twice `revalidate` old.

To have `purgeStatic()` clear the cache in front as well, point `edgeCache` at it:

```ts
export default defineConfig({
  edgeCache: { ban: "http://127.0.0.1:6081", headers: { "X-Purge-Token": "…" } },
});
```

Each purge (including the full purge at server start) sends an HTTP `BAN` request per URL, with the regex of the affected URLs in `X-Ban-Url` and `Host` taken from `publicUrl`. A failing cache is logged and skipped. Varnish needs a VCL that accepts it, e.g.:

```vcl
sub vcl_recv {
  if (req.method == "BAN") {
    if (req.http.X-Purge-Token != "…") { return (synth(403)); }
    ban("obj.http.X-Ban-Path ~ " + req.http.X-Ban-Url);
    return (synth(200, "Banned"));
  }
}
sub vcl_backend_response { set beresp.http.X-Ban-Path = bereq.url; }
sub vcl_deliver { unset resp.http.X-Ban-Path; }
```

## Template example

Models are available as global async functions in every template:

```edge
@component('layouts/main')
  @slot('title') Blog @end

  @slot('main')
    @let(result = await post.read({ filters: { status: 'PUBLISH' }, limit: 10 }))

    @each(item in result.data)
      <article>
        <h2>{{ item.title }}</h2>
        <time>{{ item.publishedAt }}</time>
      </article>
    @end
  @end
@end
```

Available template context:

```edge
{{ params.slug }}       {{-- URL params --}}
{{ query.page }}        {{-- Query string --}}
{{ request.path }}      {{-- Current path, e.g. /blog --}}
{{ request.url }}       {{-- Full URL --}}
```

## API query parameters

```
GET /api/post?page=1&limit=10&sort=publishedAt&order=desc
GET /api/post?search=hello
GET /api/post?filters[status][$eq]=PUBLISH
GET /api/post?filters[title][$contains]=hello
GET /api/post?populate=author,thumbnail
GET /api/post?populate=none
GET /api/post?select=title,slug
GET /api/post?select=title,author.name   # pick fields of a related record
```

## Setup (first run)

On first startup, create the admin user:

```bash
# Check if setup is needed
GET /api/setup/status

# Create first admin user
POST /api/setup
{ "name": "Admin", "email": "admin@example.com", "password": "yourpassword" }
# Returns: { data: { token, user } }
```

After the first user is created, this endpoint is permanently disabled.

## Auth

```bash
POST   /api/auth/login         # { email, password } → { data: { token, user } }
GET    /api/auth/check-token   # Bearer <token> → { data: user }
DELETE /api/auth/logout        # Bearer <token>
```

All `/api/*` endpoints require `Authorization: Bearer <token>`.

## MCP — manage the site with AI agents

njin exposes a remote [MCP](https://modelcontextprotocol.io) server at `POST /mcp` (Streamable HTTP), so an agent such as Claude Cowork or Claude Desktop can read and edit content, change settings and upload files.

**Other AI clients.** Any MCP client that speaks Streamable HTTP and OAuth with dynamic client registration can connect. These OAuth callbacks are accepted out of the box: Claude, ChatGPT, Cursor, VS Code, and any loopback address (`localhost` / `127.0.0.1` — what Gemini CLI, Claude Code, Codex CLI, MCP Inspector and similar desktop clients use). For a client with its own hosted callback, allow it in `config.ts` — and only for clients you trust, since it is where the sign-in code is sent:

```ts
export default defineConfig({
  mcp: {
    redirectUris: [
      "https://app.example.com/oauth/callback",   // exact
      "https://client.example.com/connectors/*",  // path prefix
    ],
  },
});
```

A client that can't do OAuth but can send a header can use a token from `POST /api/mcp-token` instead.

**Connecting Claude:** add a custom connector and enter only the URL, `https://your-site.com/mcp`. Claude opens an njin sign-in page, you log in with your normal njin account and click **Allow** — no token to copy. The site must be reachable from the internet over HTTPS; set `publicUrl` in `config.ts` if it sits behind a proxy that rewrites the host.

| Tool | |
| --- | --- |
| `list_models` | Every model and `vars` group with its JSON schema — agents call this first |
| `read_records`, `get_record` | Search, filter, sort, paginate, populate |
| `create_record`, `update_record`, `delete_record` | Validated through the model's own schema, so hooks and transforms run exactly as over REST |
| `get_vars`, `update_vars` | Settings groups |
| `create_upload_url`, `check_upload` | Add files (below) |
| `list_files`, `get_file`, `delete_file` | Manage uploaded files |

**Custom tools.** Give agents your own actions next to the built-in ones — one tool per file, with `defineTool`:

```ts
// src/mcp/publish_post.ts
import { defineTool } from "@njinlabs/njin";
import z from "zod";
import post from "../models/post";

export default defineTool({
  name: "publish_post",
  title: "Publish post",
  description: "Publish a draft post now. Use the id from read_records.",
  input: {
    id: z.string().describe("Post id"),
    notify: z.boolean().default(false).describe("Email subscribers"),
  },
  annotations: { idempotentHint: true },
  handler: async ({ id, notify }, { token, baseUrl }) => {
    const updated = await post.update(id, { status: "published" });
    return { id, notify, url: `${baseUrl}/blog/${updated.slug}`, by: token.name };
  },
});
```

```ts
// config.ts
export default defineConfig({
  mcp: {
    tools: [() => import("./src/mcp/publish_post")],
  },
});
```

- `input` is a set of zod fields: the agent sees them as JSON schema, and the handler only runs once they validate.
- Whatever the handler returns is sent back as JSON (a string is sent as-is). A thrown error goes back as a tool error the agent can read, so throw with a message that says what to fix.
- The second argument tells you who is calling (`token`, the same connection listed under `/api/mcp-token`) and the site's public `baseUrl`.
- Names may only use letters, digits, `_` and `-` (max 64), and must not reuse a built-in tool's name. A bad name stops the app at boot.
- A plugin can ship tools too: `definePlugin({ mcp: { tools: [...] } })`.
- Custom tools run with the same full access as the built-in ones — every connected agent can call them.

**Links.** A relation or file field takes the related record's id as a plain string, and that is what `list_models` tells the agent. If an agent sends an object instead (`{ "id": "..." }`, or a whole record read earlier) it is reduced to the id before saving — otherwise njin would store a dead embedded copy rather than a link. Created and updated records come back with their relations expanded, with a `_warnings` entry if a link points at nothing, and reads flag records that already hold an embedded `{ id }` copy so they can be repaired.

**Files.** File bytes can't go through a tool call, so `create_upload_url` returns a short-lived link (10 minutes, up to 10 files of 10 MB). The agent uploads with `curl -F file=@photo.jpg <url>`, or — if it has no shell or network — shows the link so you can open it and drop the file. `check_upload` then returns the file ids to put in a model's file field. Only safe types are accepted (images except SVG, PDF, Office documents, audio, video, zip, fonts); HTML, SVG and scripts are rejected because `/uploads` is served from the site's own origin.

**Managing connections.** Every connected agent is a token you can revoke:

```bash
GET    /api/mcp-token       # connected agents (OAuth) and manually created tokens
DELETE /api/mcp-token/:id   # revoke — takes effect immediately
POST   /api/mcp-token       # { name } → a long-lived token, shown once, for clients that can send an Authorization header
```

These need an admin session token, never an MCP token. There is no per-agent permission scoping yet: an agent can do anything an admin can in the content API (it cannot touch users or sessions).

## Admin panel

njin doesn't bundle an admin panel — `_admin/` at your project root is just a static folder the server looks for at startup (`GET /_admin`). Drop a built admin SPA's `index.html`/assets into it (your own, or one shared by the community) and it's served automatically; if it's missing, the startup banner just notes it wasn't found.

## Configuration

Everything that used to be an environment variable now lives in a `config.ts` you write at the project root — njin no longer owns `.env` parsing, so reading from `process.env` (or not) is entirely your call:

```ts
// config.ts
import { defineConfig } from "@njinlabs/njin/config";
import bunFilesystemAdapter from "@njinlabs/njin/adapters/bun_filesystem";

export default defineConfig({
  port: Number(process.env.PORT ?? 3000),
  publicUrl: "https://your-site.com", // optional — only needed behind a proxy; used by the MCP/OAuth discovery documents
  db: {
    path: process.env.DB_PATH ?? "rocksdb://data",
    namespace: process.env.DB_NAMESPACE ?? "general",
    database: process.env.DB_DATABASE ?? "general",
    // only needed for a remote db.path — username/password (root/system auth) or a token
    auth: process.env.DB_TOKEN
      ? process.env.DB_TOKEN
      : process.env.DB_USERNAME && process.env.DB_PASSWORD
        ? { username: process.env.DB_USERNAME, password: process.env.DB_PASSWORD }
        : undefined,
  },
  img: {
    hosts: ["cdn.example.com"], // external hosts allowed for GET /img besides same-origin/localhost
  },
  adapters: {
    file: bunFilesystemAdapter({ dir: "./uploads" }), // default — omit entirely to use this with its own default ("./uploads")
  },
  models: [
    () => import("./src/models/post"),
  ],
  vars: [
    () => import("./src/vars/general"),
  ],
  events: [
    () => import("./src/events/listeners/send_receipt"),
  ],
});
```

`db.path` accepts either an embedded scheme — `rocksdb://<dir>` (default), `mem://` (in-memory, wiped on restart), `surrealkv://<dir>` — or a remote one — `ws://`, `wss://`, `http://`, `https://` — pointed at a running `surreal start` instance or SurrealDB Cloud. `db.auth` is only needed for a remote instance that requires it, and accepts either `{ username, password }` (root/system auth) or a bearer token string. Switching between embedded and remote is just a config/env change for `njin dev`/`njin start`; a compiled `njin build` binary bakes in whichever mode was resolved at build time (see below).

### Database adapters

The database sits behind an adapter (`adapters.db`), so njin is not tied to one engine: SurrealDB (the default), PostgreSQL, SQLite, MySQL and MariaDB. `db: { ... }` above is shorthand for the default adapter, SurrealDB. To construct it yourself, or to use another adapter:

```ts
import surrealAdapter from "@njinlabs/njin/adapters/surreal";

adapters: {
  db: surrealAdapter({ path: "rocksdb://data", namespace: "general", database: "general" }),
},
```

An adapter implements the `DbAdapter` interface in [`src/core/db/contract.ts`](src/core/db/contract.ts) and can be checked against the shared contract tests in `tests/core/db/contract_suite.ts` (`describeAdapter(name, factory)`). Things every adapter guarantees:

- **Record ids are plain strings** — `record.id` is `"abc123"`, never a `table:id` or a driver type. Relation and file fields take and return the same plain id.
- `object()` fields are one-to-one and `array()` fields one-to-many — adapters keep them structured (a SQL adapter can flatten objects into columns and give arrays a child table) rather than storing opaque JSON.
- `update()` is partial: only the keys you send change; an `object()` field is merged key by key, an `array()` or relation list is replaced whole.
- Full-text search is the adapter's own business (`capabilities.search`); SurrealDB ranks with BM25 plus a containment boost.

#### PostgreSQL

```ts
import postgresAdapter from "@njinlabs/njin/adapters/postgres";

adapters: {
  db: postgresAdapter({ url: process.env.DATABASE_URL!, tls: true }),
},
```

No extra dependency: it talks to Postgres through Bun's built-in SQL client. Every value travels to the database as a bound parameter, separate from the statement text, and the adapter has no way to put user text into SQL (names are quoted, numbers validated, column types come from a fixed list). Use `tls` for anything but a local database. `schema: "tenant_1"` puts every table in that schema (it must already exist), and `connect: () => ({ client, close })` lets you supply your own driver wrapped as an `SqlClient` (`src/core/adapters/sql/builder.ts`).

Tables are created and migrated automatically on boot, and the data is stored as real, queryable columns — not JSON:

| Model field | In Postgres |
| --- | --- |
| `text`, `richtext`, `email`, `select` | `text` column |
| `numeric` / `boolean` / `date` | `double precision` / `boolean` / `timestamptz` column |
| `relation()` / `file()` | a `text` column holding the target id, indexed, with a foreign key (`ON DELETE SET NULL`) |
| `object()` | its fields flattened into columns on the same table (`seo__title`) |
| `array()` | a child table `post__tags (_id, _owner, _parent, _pos, value ...)`, one row per element (`_owner` is a foreign key, `ON DELETE CASCADE`) |
| `relationMany()` / `multiFile()` | a pivot table `post__categories (_parent, _pos, target)`, both ends foreign keys with `ON DELETE CASCADE` |
| `z.any()`, `z.record()` and other shapeless types | the only `jsonb` columns |

- **Migrations only add.** A new field becomes a new column or table; nothing is ever dropped or retyped, so removing a field leaves its column (and data) in place. The applied layout is recorded in `njin_schema_meta`, so a warm boot skips all DDL.
- **Links are foreign keys.** A `relation()` / `file()` can only hold the id of a record that exists (otherwise the write fails, and the API answers `422`); deleting a record sets the links that point at it to `null`, and removes it from `relationMany()` lists. Deleting a record deletes its array and pivot rows. When a database that predates this has rows linking to records that are gone, the migration still succeeds: on Postgres the constraint is added `NOT VALID` (enforced for new writes, old rows left alone), on MySQL / MariaDB it is added with the check switched off, and a warning names the link so you can clean it up.
- **Ids** are UUIDv7 strings; datetimes are `timestamptz` and still come out as ISO-8601 strings.
- **Search** uses the `pg_trgm` extension (substring match plus typo-tolerant ranking) when the database lets it be created, and falls back to the portable search described below otherwise.
- Filters, sorting and search work on top-level fields; an element of an `array()` or `relationMany()` can be matched with `$in`.
- An `object()` whose every field is empty reads back as `null` — it is stored as columns, so it can't be told apart from an absent one.

The adapter is checked against the same contract suite as SurrealDB (`bun test tests/core/db`, on an in-process Postgres — PGlite), and the whole test suite can be run on it with `NJIN_TEST_ADAPTER=postgres bun test --isolate`. To run the contract suite against a real server: `NJIN_TEST_POSTGRES_URL=postgres://user:pass@host/db bun test tests/core/db/postgres_server.test.ts` (it only creates and drops schemas of its own).

#### SQLite

```ts
import sqliteAdapter from "@njinlabs/njin/adapters/sqlite";

adapters: {
  db: sqliteAdapter({ path: "data/app.db" }),
},
```

One file and no server — a good fit for a small site. It runs on `bun:sqlite` (built into Bun, so nothing to install and nothing to ship next to a compiled binary). `path: ":memory:"` gives a database that lives as long as the process. Several njin processes can share one file: writes take turns (`busyTimeout`, 5 s by default, is how long one waits for another), and the file is kept in WAL mode so readers never block the writer.

The layout, ids, migrations, foreign keys and filter/sort behaviour are the same as on Postgres (everything above applies, with one limit: SQLite cannot add a constraint to a table that already exists, so a table created before foreign keys existed keeps working without them — only tables created from now on have them); only the column types differ: `text` / `real` / `integer` (booleans are 0/1), and datetimes and JSON are stored as text (datetimes as UTC ISO-8601, which sorts correctly). Search is the portable fuzzy search (below); SQLite folds case for ASCII letters only, so `É` and `é` count as different letters there.

#### MySQL and MariaDB

```ts
import mysqlAdapter from "@njinlabs/njin/adapters/mysql";

adapters: {
  db: mysqlAdapter({ url: process.env.DATABASE_URL! /* mysql://user:pass@host:3306/app */, tls: true }),
},
```

One adapter for both servers: it asks the server which one it is on connect. Like Postgres it uses Bun's built-in SQL client, takes `url`, `max`, `tls`, `schema` (here: a database that must already exist) and `connect`, and stores the same real columns. Differences worth knowing:

- Tables are `utf8mb4` with the **binary collation**, so `=`, unique columns and ids compare exactly (case- and accent-sensitive) as they do everywhere else; MySQL's default collation would not.
- A column that is indexed, unique or a primary key is `varchar(255)` — MySQL cannot index unbounded text — so a **unique string longer than 255 characters** is refused. Every other string is `longtext`.
- MySQL commits DDL implicitly, so a migration is not atomic. Every step is idempotent and the next boot finishes what a crashed one started; processes booting together take turns through a named lock.
- Search is the portable fuzzy search (below), not `FULLTEXT`: that is word-based, cannot find part of a word and has no typo tolerance.
- Tested against MySQL 8.0 and MariaDB 11.4.

Run the shared contract suite against a server with `NJIN_TEST_MYSQL_URL=mysql://user:pass@host/mysql bun test tests/core/db/mysql_server.test.ts` (it creates and drops databases of its own), and the whole test suite with `NJIN_TEST_ADAPTER=mysql NJIN_TEST_MYSQL_URL=... bun test --isolate`; `NJIN_TEST_ADAPTER=sqlite` needs nothing.

#### Search on SQLite, MySQL and MariaDB

These databases have no native typo-tolerant search (SQLite FTS5 and MySQL `FULLTEXT` match whole words or exact slices), so the adapter does it in plain SQL, identically on all three — and on Postgres when `pg_trgm` is unavailable. A field matches when it contains the search string (ignoring case and spaces, so `red wing` finds `REDWING`) **or** shares at least half of its trigrams (three-letter slices): `helo wrld` finds `Hello World`. Results rank by containment first, then by how many trigrams they share. A search string shorter than three letters matches by containment only.

The cost is a scan: each search is evaluated per row, with no index behind it. That is instant for the thousands of rows a content site holds; for a table with hundreds of thousands, use Postgres (`pg_trgm` with a GIN index) or SurrealDB.

To store uploads in S3 (or an S3-compatible service like R2/Spaces/MinIO) instead:

```ts
import s3Adapter from "@njinlabs/njin/adapters/s3";

adapters: {
  file: s3Adapter({
    bucket: process.env.S3_BUCKET!,
    region: process.env.S3_REGION,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    endpoint: process.env.S3_ENDPOINT, // for R2/Spaces/MinIO
  }),
}
```

### Logging

njin logs with [pino](https://getpino.io). By default that is pretty-printed output in the console. Add your own destinations with `logger.streams` — any pino destination (a `Writable`, or any object with `write(line)`), so ready-made streams such as `pino-loki` work as-is:

```ts
export default defineConfig({
  logger: {
    level: "info", // minimum level logged at all
    console: true, // set false to log only to `streams`
    streams: [
      { stream: createWriteStream("app.log", { flags: "a" }) },
      { stream: lokiStream, level: "error" }, // only errors and above
    ],
  },
});
```

- Streams receive JSON lines. A stream's `level` can only be stricter than the global `level`.
- Streams run in-process (no worker threads), so they work in the compiled binary too.
- A plugin can add streams: `definePlugin({ logger: { streams: [...] } })`. Plugin streams come before the project's own.
- Errors nobody caught (an uncaught exception, an unhandled promise rejection) are logged at `fatal` level — to the console and every stream — and then the process exits with code 1, the same as it would without them. Console output is written synchronously, so the last line before a crash isn't lost.
- Use the same logger in your own hooks, events and routes — it goes to the same console and streams:

  ```ts
  import logger from "@njinlabs/njin/logger";

  logger().info({ orderId }, "order paid");
  logger().error(err, "payment webhook failed");
  ```

  `logger()` returns a pino instance, so it has `info`, `warn`, `error`, `debug`, `child`, ... It is ready once the app has booted, so call it inside handlers rather than at the top level of a file.

## Commands

```bash
bunx @njinlabs/njin create my-web  # Scaffold a new project
bunx njin dev       # Start dev server (Elysia + Vite HMR)
bunx njin build     # Build for production -> ./out (public/, _admin/, views/, compiled server)
bunx njin start     # Run from source in production mode (no compile)
bunx njin update    # Update @njinlabs/njin to the latest version and refresh _admin/
bunx njin update --beta  # Follow the beta channel instead (or --tag <name>)
```

**Trying a beta.** Prereleases never become `latest`, so a normal install or update never picks one up. New project: `bunx @njinlabs/njin@beta create my-web`. Existing project: `bunx njin update --beta` (the dependency is pinned to that exact version). To go back to stable, set `@njinlabs/njin` to a stable version in `package.json` and run `bunx njin update`.

Wire these as `package.json` scripts (`"dev": "njin dev"`, etc.) if you'd rather run `bun run dev`.

## License

MIT
