# njin — Claude Code Reference

njin generates a full REST API, admin panel schema, and SSR website from a single Zod model definition. Stack: Bun + Elysia + SurrealDB (embedded) + EdgeJS + Vite + Tailwind CSS v4 + Alpine.js.

---

## IMPORTANT — Read this before doing anything

**Do NOT read any files in these directories. Everything you need is in this file.**

- `src/core/` — do not read
- `src/modules/` — do not read
- `src/config/module.ts` — do not read
- `src/models/user.ts`, `src/models/file.ts` — do not read

**When asked to add a feature, only ever create/edit:**

1. `src/models/*.ts` — new model files
2. `src/config/api.ts` — register models
3. `src/views/pages/*.edge` — new pages
4. `src/views/layouts/*.edge` — layouts
5. `src/views/components/*.edge` — components
6. `src/client/main.ts`, `src/client/app.css` — frontend

**Path aliases (already configured in tsconfig, use as-is):**

- `@njin/core/model` → `src/core/model/index.ts`
- `@njin/models/name` → `src/models/name.ts`
- `@njin/modules/name` → `src/modules/name.ts`
- `@njin/config/api` → `src/config/api.ts`

---

## NEVER modify these

- `src/core/` — framework internals
- `src/modules/` — framework services
- `src/config/module.ts` — module registry
- `src/config/env.ts` — env schema (only add new vars here if needed)
- `src/models/user.ts`, `src/models/file.ts` — framework-managed models

## Your working directories

- `src/models/` — data models
- `src/config/api.ts` — model registry
- `src/views/pages/` — page templates (file-based routing)
- `src/views/layouts/` — layout templates
- `src/views/components/` — reusable EdgeJS components
- `src/views/errors/` — optional custom error pages (`404.edge`, `403.edge`, `500.edge`, etc.)
- `src/client/main.ts` — frontend entry point
- `src/client/app.css` — Tailwind CSS (already set up)

---

## Models

### Defining a model

```ts
// src/models/post.ts
import { makeModel, text, richtext, date, email, numeric, boolean, select, object, array, file, multiFile, relation, relationMany } from "@njin/core/model";
import z from "zod";

const post = makeModel("post", {
  name: "Post", // display name for admin panel
  searchFields: ["title", "body"], // fields used for fuzzy search
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
// src/config/api.ts
import type { makeModel } from "@njin/core/model";

type ModelFactory = () => Promise<{ default: ReturnType<typeof makeModel> }>;

const api: ModelFactory[] = [() => import("@njin/models/post"), () => import("@njin/models/category"), () => import("@njin/models/product")];

export default api;
```

> Registering a model auto-generates: `GET/POST /api/{prefix}`, `GET/PUT/DELETE /api/{prefix}/:id`, and its schema in `GET /api/schema`.

### Complete working example — copy and adapt

```ts
// src/models/article.ts  ← create this file
import { makeModel, text, date, select, file, relation } from "@njin/core/model";
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
// src/config/api.ts  ← edit this file, add your model
import type { makeModel } from "@njin/core/model";

type ModelFactory = () => Promise<{ default: ReturnType<typeof makeModel> }>;

const api: ModelFactory[] = [() => import("@njin/models/article"), () => import("@njin/models/category")];

export default api;
```

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
<html lang="id" class="scroll-smooth">
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
  @slot('title') Blog @end

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
  @slot('title') {{ item.title }} @end

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

| Global                    | Type                     | Description                                                         |
| ------------------------- | ------------------------ | ------------------------------------------------------------------- |
| `params`                  | `Record<string, string>` | URL params — `params.slug`                                          |
| `query`                   | `Record<string, string>` | Query string — `query.page`                                         |
| `request.path`            | `string`                 | Current path — `/blog`                                              |
| `request.url`             | `string`                 | Full URL                                                            |
| `vite.asset(entry)`       | `string`                 | Inject Vite JS/CSS — `{{{ vite.asset('src/client/main.ts') }}}`     |
| `vite.static(path)`       | `string`                 | URL to file in `/static` — `vite.static('logo.png')`               |
| `imgOptimize(url, opts?)` | `string`                 | Optimized WebP URL — `imgOptimize(item.thumbnail.url, { w: 800 })`  |
| `abort`                   | function                 | Throw HTTP error — `abort(404)`, `abort(404, 'Not found')`          |
| Each registered model     | async functions          | `post`, `category`, etc.                                            |

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
  @slot('body') content @end
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

| Param | Required | Default | Description       |
| ----- | -------- | ------- | ----------------- |
| `url` | ✓        | —       | Source image URL  |
| `w`   |          | original | Width in px      |
| `h`   |          | original | Height in px     |
| `q`   |          | `80`    | Quality 1–100     |

Resize preserves aspect ratio (`fit: inside`) and never upscales.

**Allowed sources:**
- Relative paths (`/api/file/...`) — always allowed
- Same hostname as the request — always allowed (works in dev and production automatically)
- `localhost` / `127.0.0.1` — always allowed (covers Vite dev server on port 5173)
- Other external hosts — must be listed in `IMG_HOSTS` env var

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
GET    /uploads/*                 → uploaded file bytes (no auth — public URLs, served from FILE_DIR)

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

## Environment variables (.env)

```env
PORT=3000
DB_PATH=rocksdb://mydb
DB_NAMESPACE=general
DB_DATABASE=general
FILE_DIR=./uploads
IMG_HOSTS=example.com,cdn.mysite.com
```

---

## Commands

```bash
bun dev      # dev server + Vite HMR (single command)
bun build    # build frontend → /public
bun start    # production (NODE_ENV=production)
```
