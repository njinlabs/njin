# njin

A modern framework for building company profiles, landing pages, and content-driven websites. Define your data model once — get a full REST API, admin panel schema, and server-rendered website out of the box.

## Stack

- **[Bun](https://bun.sh)** — runtime, package manager, bundler (njin is Bun-only — no Node/Deno support)
- **[Elysia](https://elysiajs.com)** — HTTP framework with type-safe CRUD generation
- **[SurrealDB](https://surrealdb.com)** — embedded multi-model database (no separate server)
- **[EdgeJS](https://edgejs.dev)** — server-side template engine with file-based routing
- **[Vite](https://vitejs.dev)** + **[Tailwind CSS v4](https://tailwindcss.com)** + **[Alpine.js](https://alpinejs.dev)** — frontend tooling

## Quick start

```bash
bun create njin-app my-web
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

## File-based routing

Files in `src/views/pages/` map to routes automatically:

```
pages/index.edge          → GET /
pages/about.edge          → GET /about
pages/blog/index.edge     → GET /blog
pages/blog/[slug].edge    → GET /blog/:slug
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
  db: {
    path: process.env.DB_PATH ?? "rocksdb://data",
    namespace: process.env.DB_NAMESPACE ?? "general",
    database: process.env.DB_DATABASE ?? "general",
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
});
```

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

## Commands

```bash
bunx njin dev       # Start dev server (Elysia + Vite HMR)
bunx njin build     # Build for production -> ./out (public/, _admin/, views/, compiled server)
bunx njin start     # Run from source in production mode (no compile)
```

Wire these as `package.json` scripts (`"dev": "njin dev"`, etc.) if you'd rather run `bun run dev`.

## License

MIT
