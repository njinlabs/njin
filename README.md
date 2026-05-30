# njin

A modern framework for building company profiles, landing pages, and content-driven websites. Define your data model once — get a full REST API, admin panel schema, and server-rendered website out of the box.

> **Beta** — functional and usable, but APIs may change before stable release.

## Stack

- **[Bun](https://bun.sh)** — runtime, package manager, bundler
- **[Elysia](https://elysiajs.com)** — HTTP framework with type-safe CRUD generation
- **[SurrealDB](https://surrealdb.com)** — embedded multi-model database (no separate server)
- **[EdgeJS](https://edgejs.dev)** — server-side template engine with file-based routing
- **[Vite](https://vitejs.dev)** + **[Tailwind CSS v4](https://tailwindcss.com)** + **[Alpine.js](https://alpinejs.dev)** — frontend tooling

## Quick start

```bash
bun create njinlabs/njin my-project
cd my-project
cp .env.example .env   # configure your environment
bun dev
```

## Project structure

```
src/
  config/
    api.ts        ← register your models here
    adapter.ts    ← file storage adapter
    env.ts        ← environment variable schema & defaults
    module.ts     ← framework module registry
  core/           ← framework internals (do not modify)
  models/         ← your data models
  modules/        ← framework modules (do not modify)
  views/
    layouts/      ← base layout templates
    pages/        ← file-based routes (.edge files)
  client/
    main.ts       ← frontend entry point
    app.css       ← Tailwind CSS
.env              ← environment variables (git-ignored)
.env.example      ← environment variable reference
vite.config.ts    ← Vite config
```

## Defining a model

```ts
// src/models/post.ts
import { makeModel, text, date, select } from "@njin/core/model";
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

Register in `src/config/api.ts`:

```ts
const api = [
  () => import("@njin/models/post"),
] as const;
```

This automatically generates:

| Method | Endpoint | Description |
|--------|----------|-------------|
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

## Configuration

Copy `.env.example` to `.env` and edit:

```env
PORT=3000

DB_PATH=rocksdb://mydb
DB_NAMESPACE=general
DB_DATABASE=general

FILE_DIR=./uploads
```

## Commands

```bash
bun dev       # Start dev server (Elysia + Vite HMR)
bun build     # Build frontend assets to /public
bun start     # Start production server
```

## Known limitations (beta)

- User model is accessible via the general CRUD API
- No change password endpoint yet
- No email/forgot password support

## License

MIT
