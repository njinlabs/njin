# njin — Claude Code Reference

njin generates a full REST API, admin panel schema, and SSR website from a single Zod model definition. Stack: Bun + Elysia + SurrealDB (embedded) + EdgeJS + Vite + Tailwind CSS v4 + Alpine.js.

---

## IMPORTANT — Read this before doing anything

`@njinlabs/njin` lives in `node_modules/@njinlabs/njin` — there is no framework source in this project to read or modify. Everything you need to know about it is in this file.

**When asked to add a feature, only ever create/edit:**

1. `config.ts` — root-level config: register models, vars, helpers, events, routes, plugins, db, file adapter, port, img hosts
2. `src/models/*.ts` — new model files
3. `src/vars/*.ts` — new vars (singleton settings) groups
4. `src/helpers/*.ts` — new template helper functions
5. `src/events/**/*.ts` — event definitions and listeners
6. `src/views/pages/*.edge` — new pages
7. `src/views/layouts/*.edge` — layouts
8. `src/views/components/*.edge` — components
9. `src/client/main.ts`, `src/client/app.css` — frontend

Plugins are npm packages (not local files) registered directly in `config.ts`'s `plugins: []`.

**Imports:**

- Model-building helpers (`makeModel`, `text`, `relation`, ...) come from the `"@njinlabs/njin"` package itself — no path alias needed: `import { makeModel, text } from "@njinlabs/njin";`
- `defineConfig` comes from `"@njinlabs/njin/config"`; built-in file adapters come from `"@njinlabs/njin/adapters/bun_filesystem"` and `"@njinlabs/njin/adapters/s3"`.
- Everything else (your own model files, `config.ts`, etc.) uses plain relative imports, same as any other TypeScript project.

---

## Your working directories

- `config.ts` — root config (models, vars, helpers, events, routes, plugins, db, file adapter, port, img hosts)
- `src/models/` — data models
- `src/vars/` — singleton settings groups (site name, SEO meta, feature toggles, ...)
- `src/helpers/` — stateless functions exposed as Edge template globals
- `src/events/` — event definitions and listeners
- `src/views/pages/` — page templates (file-based routing)
- `src/views/layouts/` — layout templates
- `src/views/components/` — reusable EdgeJS components
- `src/views/errors/` — optional custom error pages (`404.edge`, `403.edge`, `500.edge`, etc.)
- `src/client/main.ts` — frontend entry point
- `src/client/app.css` — Tailwind CSS (already set up)
- `_admin/` — prebuilt admin panel SPA, already included by this scaffold — served at `/_admin` automatically, no setup needed

---

## Models

### Defining a model

```ts
// src/models/post.ts
import { makeModel, text, richtext, date, email, numeric, boolean, select, object, array, file, multiFile, relation, relationMany } from "@njinlabs/njin";
import z from "zod";

const post = makeModel("post", {
  name: "Post", // display name for admin panel
  // Fields used for fuzzy search. "author.name" reaches one level into a relation field
  // (author must be relation/relationMany/file/multiFile) — throws at makeModel() call
  // time if "author" isn't a relation field, or if the target field doesn't exist.
  searchFields: ["title", "body", "author.name"],
  schema: z.object({
    // --- Data types ---
    title: text({ label: "Title" }),
    slug: text({ label: "Slug", unique: true }), // unique: true → rejects duplicates with 409 before insert
    body: richtext({ label: "Body" }), // rich text editor, stores raw HTML — render with {{{ }}}, not {{ }}
    date: date({ label: "Date" }),
    email: email({ label: "Email" }),
    price: numeric({ label: "Price" }),
    isFeatured: boolean({ label: "Featured?" }, (z) => z.default(false)),
    status: select({ label: "Status" }, ["DRAFT", "PUBLISH"]),

    // Chained validators work on text/email/date/richtext too — the rule callback
    // receives the underlying Zod type (ZodString, ZodEmail, ...), not a wrapper:
    // title: text({ label: "Title" }, (z) => z.min(3).max(100)),

    // Nested object
    seo: object(
      { label: "SEO" },
      {
        metaTitle: text({ label: "Meta Title" }),
        metaDescription: text({ label: "Meta Description" }),
      },
    ),

    // Array of primitives
    tags: array({ label: "Tags" }, text({ label: "Tag" })),

    // Array with validation
    images: array({ label: "Images" }, text({ label: "URL" }), (z) => z.min(1)),

    // Single file upload
    thumbnail: file({ label: "Thumbnail" }),

    // Multiple file upload
    gallery: multiFile({ label: "Gallery" }),

    // Relation (foreign key → another model)
    author: relation({ label: "Author", labelKey: "name" }, user),

    // Relation with validation
    category: relation({ label: "Category", labelKey: "title" }, category, (z) => z.optional()),

    // Many relations
    tags: relationMany({ label: "Tags" }, tag),
  }),
});

export default post;
```

### Data types

`text`, `email`, `richtext`, `numeric`, `boolean`, `date`, `select`, `array`, `object`, `relation`, `relationMany`, `file`, `multiFile`.

- `richtext` is a plain string field (HTML) under the hood — identical contract to `text`, just a different `renderAs` for the admin panel's editor widget. Render with `{{{ item.body }}}` (unescaped), same as any other trusted HTML field.
- `boolean` maps straight to a JSON boolean — no coercion from `"true"`/`"on"` strings, the API expects a real `true`/`false` in the request body.
- Any field can take `unique: true` in its meta (e.g. `text({ label: "Slug", unique: true })`). Enforced in application code (a pre-insert check), not a DB-level index. Violating it returns `409` with `{ message, field }` from both `POST` and `PUT`. There's a small race-condition window between two concurrent requests — acceptable trade-off, not closed by design.

### Registering a model

```ts
// config.ts  ← project root
import { defineConfig } from "@njinlabs/njin/config";

export default defineConfig({
  models: [() => import("./src/models/post"), () => import("./src/models/category"), () => import("./src/models/product")],
});
```

> Registering a model auto-generates: `GET/POST /api/{prefix}`, `GET/PUT/DELETE /api/{prefix}/:id`, and its schema in `GET /api/schema`.

### Complete working example — copy and adapt

```ts
// src/models/article.ts  ← create this file
import { makeModel, text, date, select, file, relation } from "@njinlabs/njin";
import z from "zod";
import category from "./category";

const article = makeModel("article", {
  name: "Article",
  searchFields: ["title"],
  schema: z.object({
    title: text({ label: "Title" }),
    body: text({ label: "Body" }),
    slug: text({ label: "Slug" }),
    status: select({ label: "Status" }, ["DRAFT", "PUBLISH"]),
    thumbnail: file({ label: "Thumbnail" }),
    publishedAt: date({ label: "Published At" }),
    category: relation({ label: "Category", labelKey: "title" }, category),
  }),
});

export default article;
```

```ts
// config.ts  ← edit this file, add your model
import { defineConfig } from "@njinlabs/njin/config";

export default defineConfig({
  models: [() => import("./src/models/article"), () => import("./src/models/category")],
});
```

---

## Vars — user-editable settings

Singleton settings objects (site name, SEO meta, feature toggles, ...) — unlike a model, there's no list of records, just one object per group.

```ts
// src/vars/general.ts
import { makeVars, text, boolean } from "@njinlabs/njin";
import z from "zod";

const general = makeVars("general", {
  name: "General",
  schema: z.object({
    // Every field needs a .default(...) — get() must always return a complete
    // object even before anything has ever been saved.
    siteName: text({ label: "Site Name" }, (z) => z.default("My Site")),
    maintenanceMode: boolean({ label: "Maintenance Mode" }, (z) => z.default(false)),
  }),
});

export default general;
```

```ts
// config.ts
export default defineConfig({
  vars: [() => import("./src/vars/general")],
});
```

> Registering a vars group auto-generates `GET/PUT /api/vars/{name}` and its schema under `vars` in `GET /api/schema`.

Available in templates as global async functions — only `get()`/`update()`, not the full model method set:

```edge
@let(settings = await general.get())
<title>{{ settings.siteName }}</title>
```

---

## Helpers — custom template functions

A plain, stateless function registered as an Edge global — no DB record, no auto-generated REST endpoint, just a function callable from any `.edge` template.

```ts
// src/helpers/format_date.ts
import { defineHelper } from "@njinlabs/njin";

export default defineHelper("formatDate", (date: string, format = "DD MMM YYYY") => {
  // ... format `date` and return a string
});
```

```ts
// config.ts
export default defineConfig({
  helpers: [() => import("./src/helpers/format_date")],
});
```

Use it directly in a template — no `await` needed for a synchronous `fn` (an `async` `fn` works too, called with `await` like any other async global):

```edge
<p>{{ formatDate(post.createdAt) }}</p>
```

---

## Events

A type-safe event bus for fan-out notifications (e.g. "an order was paid") — different from model hooks (`beforeCreate`/`afterCreate`/...): hooks are scoped to one model and can abort the operation by throwing, while events are fire-and-forget — a listener that throws is logged but never stops other listeners or the dispatching code.

`makeEvent()` has no name — dispatch and listen are correlated by sharing the same instance (not a string key), so always define one event in one canonical file and import it wherever needed:

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
  // errors here are caught and logged, never bubble back to the dispatcher
});
```

Register the listener file in `config.ts` so it's imported (and its `.listen()` call runs) at boot:

```ts
// config.ts
export default defineConfig({
  events: [() => import("./src/events/listeners/send_receipt")],
});
```

Dispatch from anywhere, e.g. composing with a model's `afterCreate` hook:

```ts
import { afterCreate } from "@njinlabs/njin";
import orderPaid from "../events/order_paid";

afterCreate(order, (record) => {
  orderPaid.dispatch({ orderId: record.id.id, total: record.total });
});
```

---

## Plugins

A plugin bundles models/vars/hooks/events/routes into one reusable, installable npm package — like a self-contained njin app that extends whatever project installs it.

```ts
// config.ts
import myPlugin from "my-plugin";

export default defineConfig({
  // The factory is called directly (not wrapped in another thunk), same as adapters.file:
  plugins: [myPlugin({ apiKey: process.env.MY_PLUGIN_KEY! })],
});
```

Everything a plugin contributes is merged in ahead of your own project's models/vars/hooks/events/routes — your project's own registrations always run after and can build on top of what the plugin sets up. Only reach for this when explicitly asked to build a reusable plugin — most feature requests belong in the project's own `src/models`, `src/vars`, `src/helpers`, `src/events` files instead.

---

## File-based routing

Files in `src/views/pages/` map to routes:

```
pages/index.edge            → GET /
pages/about.edge            → GET /about
pages/blog/index.edge       → GET /blog
pages/blog/[slug].edge      → GET /blog/:slug
pages/portfolio/[id]/index.edge  → GET /portfolio/:id
```

---

## EdgeJS templates

### Layout

```edge
{{-- src/views/layouts/main.edge --}}
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{{{ await $slots.title?.() ?? 'Site' }}}</title>
  {{{ await vite.asset('src/client/main.ts') }}}
</head>
<body class="bg-white text-slate-900 antialiased">
  {{{ await $slots.main() }}}
</body>
</html>
```

### Complete page templates — copy and adapt

```edge
{{-- src/views/pages/blog/index.edge — list page --}}
@component('layouts/main')
  @slot('title')
    Blog
  @end

  @slot('main')
    @let(page = Number(query.page || 1))
    @let(result = await article.read({
      filters: { status: { $eq: 'PUBLISH' } },
      sort: 'publishedAt',
      order: 'desc',
      limit: 12,
      page: page,
    }))

    <div class="max-w-6xl mx-auto px-6 py-16">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
        @each(item in result.data)
          <a href="/blog/{{ item.id.id }}" class="group block">
            <h2 class="font-semibold group-hover:text-violet-600 transition-colors">{{ item.title }}</h2>
            <time class="text-sm text-slate-400">{{ item.publishedAt }}</time>
          </a>
        @end
      </div>

      {{-- Pagination --}}
      @if(result.meta.pageCount > 1)
        <div class="flex gap-2 mt-12">
          @each(p in Array.from({ length: result.meta.pageCount }, (_, i) => i + 1))
            <a href="?page={{ p }}" class="{{ p === result.meta.page ? 'bg-violet-600 text-white' : 'text-slate-600' }} px-3 py-1 rounded">{{ p }}</a>
          @end
        </div>
      @end
    </div>
  @end
@end
```

```edge
{{-- src/views/pages/blog/[slug].edge — detail page --}}
@component('layouts/main')
  @slot('title')
    {{ item.title }}
  @end

  @slot('main')
    @let(item = await article.show(params.slug))

    <article class="max-w-3xl mx-auto px-6 py-16">
      <h1 class="text-4xl font-bold mb-4">{{ item.title }}</h1>
      <time class="text-slate-400">{{ item.publishedAt }}</time>
      <div class="mt-8 prose">{{{ item.body }}}</div>
    </article>
  @end
@end
```

### Template globals (available in every template)

| Global                    | Type                     | Description                                                        |
| ------------------------- | ------------------------ | ------------------------------------------------------------------ |
| `params`                  | `Record<string, string>` | URL params — `params.slug`                                         |
| `query`                   | `Record<string, string>` | Query string — `query.page`                                        |
| `request.path`            | `string`                 | Current path — `/blog`                                             |
| `request.url`             | `string`                 | Full URL                                                           |
| `vite.asset(entry)`       | `string`                 | Inject Vite JS/CSS — `{{{ vite.asset('src/client/main.ts') }}}`    |
| `vite.static(path)`       | `string`                 | URL to file in `/static` — `vite.static('logo.png')`               |
| `imgOptimize(url, opts?)` | `string`                 | Optimized WebP URL — `imgOptimize(item.thumbnail.url, { w: 800 })` |
| `abort`                   | function                 | Throw HTTP error — `abort(404)`, `abort(404, 'Not found')`         |
| Each registered model     | async functions          | `post`, `category`, etc.                                           |

### Model methods in templates (all async, use await)

```edge
{{-- List with options --}}
@let(result = await post.read({ page: 1, limit: 10, sort: 'createdAt', order: 'desc' }))
{{-- result.data → array, result.meta → { total, page, limit, pageCount } --}}

{{-- Single record (auto-fetches relations) --}}
@let(item = await post.show(params.id))
@if(!item){{ abort(404) }}@end

{{-- With search --}}
@let(result = await post.read({ search: query.q }))
```

### read() options

```ts
post.read({
  page: 1, // default: 1
  limit: 20, // default: 20, max: 100
  sort: "title", // field name in schema, or "id" / "createdAt" / "updatedAt"
  order: "asc", // 'asc' | 'desc'
  search: "hello", // fuzzy search on searchFields
  populate: ["author", "thumbnail"], // relation fields to fetch
  populate: "none", // skip all relation fetching
  filters: {
    status: "PUBLISH", // shorthand equality
    status: { $eq: "PUBLISH" }, // explicit equality
    title: { $contains: "hello" }, // case-insensitive contains
    title: { $startsWith: "intro" }, // starts with
    price: { $gt: "100" }, // greater than
    price: { $gte: "100" }, // greater than or equal
    price: { $lt: "1000" }, // less than
    price: { $lte: "1000" }, // less than or equal
    status: { $ne: "DRAFT" }, // not equal
    tags: { $in: "javascript" }, // array contains value
  },
});
```

Over HTTP, `filters`/`populate` are query params using standard bracket notation (works out of the box with Axios, `qs`, jQuery, etc. — no JSON-encoding needed):

```
GET /api/post?filters[status]=PUBLISH
GET /api/post?filters[price][$gte]=100&filters[status][$ne]=DRAFT
GET /api/post?sort=createdAt&order=desc
```

### EdgeJS syntax reference

```edge
{{-- Variable --}}
{{ variable }}          {{-- escaped --}}
{{{ rawHtml }}}         {{-- unescaped (safe HTML) --}}

{{-- Assign variable --}}
@let(name = 'value')
@let(result = await post.read({}))

{{-- Conditionals --}}
@if(condition)
@elseif(otherCondition)
@else
@end

{{-- Loop --}}
@each(item in array)
  {{ item.title }}
@end

{{-- Include --}}
@include('partials/header')

{{-- Component with slots --}}
@component('components/card', { title: item.title })
  @slot('body')
    content
  @end
@end

{{-- Active nav helper --}}
<a class="{{ request.path === '/about' ? 'active' : '' }}" href="/about">About</a>
```

---

## Static assets

Put files in `/static`. In dev they are served by Vite at their original URL. On `bun build` Vite copies them to `/public`.

Use `vite.static()` in templates — never hardcode paths or ports:

```edge
<img src="{{ vite.static('logo.png') }}" />
<link rel="icon" href="{{ vite.static('favicon.ico') }}" />
```

---

## Image optimization

Endpoint `GET /img` converts any image to WebP on-the-fly. Output is cached by the browser via `Cache-Control: immutable`.

| Param | Required | Default  | Description      |
| ----- | -------- | -------- | ---------------- |
| `url` | ✓        | —        | Source image URL |
| `w`   |          | original | Width in px      |
| `h`   |          | original | Height in px     |
| `q`   |          | `80`     | Quality 1–100    |

Resize preserves aspect ratio (`fit: inside`) and never upscales.

**Allowed sources:**

- Relative paths (`/api/file/...`) — always allowed
- Same hostname as the request — always allowed (works in dev and production automatically)
- `localhost` / `127.0.0.1` — always allowed (covers Vite dev server on port 5173)
- Other external hosts — must be listed in `config.ts`'s `img.hosts`

Use `imgOptimize()` in templates:

```edge
{{-- Resize only --}}
<img src="{{ imgOptimize(item.thumbnail.url, { w: 800 }) }}" />

{{-- Resize + quality --}}
<img src="{{ imgOptimize(item.thumbnail.url, { w: 800, q: 85 }) }}" />

{{-- OG image with fixed dimensions --}}
<meta property="og:image" content="{{ imgOptimize(item.thumbnail.url, { w: 1200, h: 630 }) }}" />

{{-- WebP-only, no resize --}}
<img src="{{ imgOptimize(item.thumbnail.url) }}" />
```

---

## Frontend (Tailwind + Alpine.js)

Tailwind v4 — utility classes, no config file. Alpine.js v3 — inline directives.

```edge
{{-- Alpine component --}}
<div x-data="{ open: false }">
  <button @click="open = !open">Toggle</button>
  <div x-show="open" x-transition>Content</div>
</div>

{{-- Alpine with fetch --}}
<div x-data="{ items: [] }" x-init="items = await (await fetch('/api/post')).json()">
  <template x-for="item in items.data">
    <div x-text="item.title"></div>
  </template>
</div>
```

Add custom JavaScript/CSS in `src/client/main.ts` and `src/client/app.css`.

---

## API reference

All endpoints require `Authorization: Bearer <token>` header.

```
GET    /img?url=&w=&h=&q=         → image/webp  (no auth required, browser-cached)

GET    /api/setup/status          → { needsSetup: bool }
POST   /api/setup                 → { data: { token, user } }   first-run only

POST   /api/auth/login            → { data: { token, user } }
GET    /api/auth/check-token      → { data: user }
DELETE /api/auth/logout

GET    /api/schema                → full schema for admin panel

GET    /api/{prefix}              → { data: [...], meta: { total, page, limit, pageCount } }
POST   /api/{prefix}              → { data: {...} }
GET    /api/{prefix}/:id          → { data: {...} }   (relations auto-fetched)
PUT    /api/{prefix}/:id          → { data: {...} }
DELETE /api/{prefix}/:id          → { data: {...} }
                                     422 on validation error, 409 if a `unique: true` field collides

GET    /api/file                  → { data: [...], meta: {...} }   (search/page/limit/sort/order — no filters)
POST   /api/file                  → { data: { id, url, name, size, type } }   (multipart, field name "file")
DELETE /api/file/:id
GET    /uploads/*                 → uploaded file bytes (no auth — public URLs; only mounted when the configured file
                                     adapter has a `dir`, e.g. the default filesystem adapter. S3-backed adapters serve
                                     files from their own public URL instead.)

GET    /api/user                  → { data: [...], meta: {...} }   (same shape as /api/{prefix}, password always stripped)
POST   /api/user                  → { data: {...} }   body: { name, email, password } — password is hashed server-side
GET    /api/user/:id              → { data: {...} | null }
PUT    /api/user/:id              → { data: {...} }
DELETE /api/user/:id              → { data: {...} }   400 if deleting your own account (setup is permanently locked after first user)

GET    /api/analytics/summary     → { data: { totalPageviews, uniqueVisitors } }
GET    /api/analytics/by-country  → { data: [{ country, count }] }
GET    /api/analytics/by-referrer → { data: [{ referrer, count }] }
GET    /api/analytics/by-page     → { data: [{ path, count }] }
GET    /api/analytics/timeseries  → { data: [{ date, count }] }
                                     query: from, to (full ISO datetime, required if filtering — date-only strings are rejected),
                                     path, interval ("day" | "hour", default "day")
                                     Pageviews are tracked automatically for every rendered .edge page — no setup needed.
                                     Visitor IP is never stored; only the resolved country + a daily-rotating hash for uniqueVisitors.
```

---

## Configuration (`config.ts`, project root)

There's no `.env` schema owned by njin anymore — `config.ts` is the single source of truth, and reading from `process.env` inside it is your own choice:

```ts
// config.ts
import { defineConfig } from "@njinlabs/njin/config";
import bunFilesystemAdapter from "@njinlabs/njin/adapters/bun_filesystem";

export default defineConfig({
  port: Number(process.env.PORT ?? 3000),
  db: {
    path: process.env.DB_PATH ?? "rocksdb://data",
    namespace: process.env.DB_NAMESPACE ?? "general",
    database: process.env.DB_DATABASE ?? "general",
    // Only needed for a remote db.path (ws://, wss://, http://, https://) — root/system
    // auth or a bearer token; embedded engines (rocksdb/mem/surrealkv) never need this.
    auth: process.env.DB_TOKEN
      ? process.env.DB_TOKEN
      : process.env.DB_USERNAME && process.env.DB_PASSWORD
        ? { username: process.env.DB_USERNAME, password: process.env.DB_PASSWORD }
        : undefined,
  },
  img: {
    hosts: ["example.com", "cdn.mysite.com"],
  },
  adapters: {
    file: bunFilesystemAdapter({ dir: "./uploads" }), // default if `adapters.file` is omitted entirely
  },
  models: [() => import("./src/models/post")],
  vars: [() => import("./src/vars/general")],
  helpers: [() => import("./src/helpers/format_date")],
  events: [() => import("./src/events/listeners/send_receipt")],
  routes: [() => import("./src/routes/webhook")],
  plugins: [], // see "Plugins" above
});
```

For S3 (or R2/Spaces/MinIO), use `s3Adapter` from `"@njinlabs/njin/adapters/s3"` instead — it requires `bucket` and accepts `region`, `accessKeyId`, `secretAccessKey`, `endpoint`, `publicUrl`.

---

## Commands

```bash
bunx njin dev      # dev server + Vite HMR (single command)
bunx njin build    # build for production -> ./out (public/, _admin/, views/, compiled server)
bunx njin start    # production, run from source (no compile)
bunx njin update   # update @njinlabs/njin to the latest version and refresh _admin/
```

Wire these as `package.json` scripts (`"dev": "njin dev"`, etc.) to run them via `bun run dev` instead.
