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

The database sits behind an adapter (`adapters.db`), so njin is not tied to one engine. `db: { ... }` above is shorthand for the default adapter, SurrealDB. To construct it yourself, or to use another adapter:

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
| `relation()` / `file()` | a `text` column holding the target id (indexed, no foreign key) |
| `object()` | its fields flattened into columns on the same table (`seo__title`) |
| `array()` | a child table `post__tags (_id, _owner, _parent, _pos, value ...)`, one row per element |
| `relationMany()` / `multiFile()` | a pivot table `post__categories (_parent, _pos, target)` |
| `z.any()`, `z.record()` and other shapeless types | the only `jsonb` columns |

- **Migrations only add.** A new field becomes a new column or table; nothing is ever dropped or retyped, so removing a field leaves its column (and data) in place. The applied layout is recorded in `njin_schema_meta`, so a warm boot skips all DDL.
- **Ids** are UUIDv7 strings; datetimes are `timestamptz` and still come out as ISO-8601 strings.
- **Search** uses the `pg_trgm` extension (substring match plus typo-tolerant ranking) when the database lets it be created, and falls back to plain substring matching otherwise.
- Filters, sorting and search work on top-level fields; an element of an `array()` or `relationMany()` can be matched with `$in`.
- An `object()` whose every field is empty reads back as `null` — it is stored as columns, so it can't be told apart from an absent one.

The adapter is checked against the same contract suite as SurrealDB (`bun test tests/core/db`, on an in-process Postgres — PGlite), and the whole test suite can be run on it with `NJIN_TEST_ADAPTER=postgres bun test --isolate`. To run the contract suite against a real server: `NJIN_TEST_POSTGRES_URL=postgres://user:pass@host/db bun test tests/core/db/postgres_server.test.ts` (it only creates and drops schemas of its own).

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
