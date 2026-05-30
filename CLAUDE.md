# njin — Claude Code Reference

njin generates a full REST API, admin panel schema, and SSR website from a single Zod model definition. Stack: Bun + Elysia + SurrealDB (embedded) + EdgeJS + Vite + Tailwind CSS v4 + Alpine.js.

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
- `src/client/main.ts` — frontend entry point
- `src/client/app.css` — Tailwind CSS (already set up)

---

## Models

### Defining a model

```ts
// src/models/post.ts
import { makeModel, text, date, email, numeric, select, object, array, file, multiFile, relation, relationMany } from "@njin/core/model";
import z from "zod";

const post = makeModel("post", {
  name: "Post",           // display name for admin panel
  searchFields: ["title", "body"],  // fields used for fuzzy search
  schema: z.object({
    // --- Data types ---
    title:    text({ label: "Title" }),
    body:     text({ label: "Body" }),
    date:     date({ label: "Date" }),
    email:    email({ label: "Email" }),
    price:    numeric({ label: "Price" }),
    status:   select({ label: "Status" }, ["DRAFT", "PUBLISH"]),

    // Nested object
    seo: object({ label: "SEO" }, {
      metaTitle:       text({ label: "Meta Title" }),
      metaDescription: text({ label: "Meta Description" }),
    }),

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

### Registering a model

```ts
// src/config/api.ts
import type { makeModel } from "@njin/core/model";

type ModelFactory = () => Promise<{ default: ReturnType<typeof makeModel> }>;

const api: ModelFactory[] = [
  () => import("@njin/models/post"),
  () => import("@njin/models/category"),
  () => import("@njin/models/product"),
];

export default api;
```

> Registering a model auto-generates: `GET/POST /api/{prefix}`, `GET/PUT/DELETE /api/{prefix}/:id`, and its schema in `GET /api/schema`.

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

### Page template

```edge
@component('layouts/main')
  @slot('title') Blog @end

  @slot('main')
    @let(result = await post.read({ filters: { status: { $eq: 'PUBLISH' } }, sort: 'createdAt', order: 'desc', limit: 10 }))

    @each(item in result.data)
      <article>
        <h2>{{ item.title }}</h2>
        <time>{{ item.createdAt }}</time>
      </article>
    @end

    {{-- Pagination --}}
    <p>Page {{ result.meta.page }} of {{ result.meta.pageCount }}</p>
  @end
@end
```

### Template globals (available in every template)

| Global | Type | Description |
|--------|------|-------------|
| `params` | `Record<string, string>` | URL params — `params.slug` |
| `query` | `Record<string, string>` | Query string — `query.page` |
| `request.path` | `string` | Current path — `/blog` |
| `request.url` | `string` | Full URL |
| `vite` | object | Asset injection — `vite.asset('src/client/main.ts')` |
| Each registered model | async functions | `post`, `category`, etc. |

### Model methods in templates (all async, use await)

```edge
{{-- List with options --}}
@let(result = await post.read({ page: 1, limit: 10, sort: 'createdAt', order: 'desc' }))
{{-- result.data → array, result.meta → { total, page, limit, pageCount } --}}

{{-- Single record (auto-fetches relations) --}}
@let(item = await post.show(params.id))

{{-- With search --}}
@let(result = await post.read({ search: query.q }))
```

### read() options

```ts
post.read({
  page: 1,          // default: 1
  limit: 20,        // default: 20, max: 100
  sort: 'title',    // field name (must exist in schema)
  order: 'asc',     // 'asc' | 'desc'
  search: 'hello',  // fuzzy search on searchFields
  populate: ['author', 'thumbnail'],  // relation fields to fetch
  populate: 'none', // skip all relation fetching
  filters: {
    status: 'PUBLISH',                    // shorthand equality
    status: { $eq: 'PUBLISH' },           // explicit equality
    title:  { $contains: 'hello' },       // case-insensitive contains
    title:  { $startsWith: 'intro' },     // starts with
    price:  { $gt: '100' },               // greater than
    price:  { $gte: '100' },              // greater than or equal
    price:  { $lt: '1000' },              // less than
    price:  { $lte: '1000' },             // less than or equal
    status: { $ne: 'DRAFT' },             // not equal
    tags:   { $in: 'javascript' },        // array contains value
  },
})
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

POST   /api/file                  → { data: { id, url, name, size, type } }
DELETE /api/file/:id
```

---

## Environment variables (.env)

```env
PORT=3000
DB_PATH=rocksdb://mydb
DB_NAMESPACE=general
DB_DATABASE=general
FILE_DIR=./uploads
```

---

## Commands

```bash
bun dev      # dev server + Vite HMR (single command)
bun build    # build frontend → /public
bun start    # production (NODE_ENV=production)
```
