# njin

[![CI](https://github.com/njinlabs/njin/actions/workflows/ci.yml/badge.svg)](https://github.com/njinlabs/njin/actions/workflows/ci.yml)
[![CodeQL](https://github.com/njinlabs/njin/actions/workflows/codeql.yml/badge.svg)](https://github.com/njinlabs/njin/actions/workflows/codeql.yml)
[![npm version](https://img.shields.io/npm/v/%40njinlabs%2Fnjin.svg)](https://www.npmjs.com/package/@njinlabs/njin)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A modern framework for building company profiles, landing pages, and content-driven websites. Define your data model once — get a full REST API, admin panel schema, and server-rendered website out of the box.

## Stack

- **[Bun](https://bun.sh)** — runtime, package manager, bundler (njin is Bun-only — no Node/Deno support)
- **[Elysia](https://elysiajs.com)** — HTTP framework with type-safe CRUD generation
- **[SurrealDB](https://surrealdb.com)** — multi-model database, embedded by default (no separate server) or pointed at a remote instance
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
  orderPaid.dispatch({ orderId: record.id.id, total: record.total });
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
bunx @njinlabs/njin create my-web  # Scaffold a new project
bunx njin dev       # Start dev server (Elysia + Vite HMR)
bunx njin build     # Build for production -> ./out (public/, _admin/, views/, compiled server)
bunx njin start     # Run from source in production mode (no compile)
bunx njin update    # Update @njinlabs/njin to the latest version and refresh _admin/
```

Wire these as `package.json` scripts (`"dev": "njin dev"`, etc.) if you'd rather run `bun run dev`.

## License

MIT
