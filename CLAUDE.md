# njin

A framework for company profiles, landing pages and content sites on Bun and Elysia. One Zod model gives a REST API, the
schema the admin panel draws its forms from, an MCP server for agents, and SSR pages (EdgeJS). Published as
`@njinlabs/njin`; the TypeScript source is what ships (`files: src`), so there is no build step for the package. The admin
panel is a separate repo, [njin-admin](https://github.com/njinlabs/njin-admin), downloaded into a project's `_admin/` by
`njin create` and `njin update`. `README.md` is the user-facing documentation.

## Layout

- `src/cli/`: the `njin` command (`create`, `dev`, `build`, `build:worker`, `start`, `update`, `plugin:create`).
- `src/config/module.ts`: the list of modules, in boot order. Order matters (the config loads first, `db` is awaited before
  anything that queries it, `plugin` before `api`).
- `src/modules/`: one feature per file (auth, oauth, mcp, api, users, file, view, ...). Each is `makeModule(...)` with an
  `init()` that registers its routes through the shared `elysia()` singleton.
- `src/core/`: what modules are built on.
  - `adapters/`: databases (SurrealDB, Postgres, SQLite, MySQL/MariaDB; the SQL ones share `adapters/sql/`) and files
    (Bun filesystem, S3), behind the contracts in `db/contract.ts`.
  - `model/`: model and data-type definitions, hooks, i18n, and `admin_schema.ts` (JSON schema for the admin).
  - `auth/`: access grants and scopes, guards, rate limiting, token hashing, the session cookie.
  - `api/`: what a project or plugin defines (routes, events, helpers, MCP tools, `definePlugin`).
  - `http/`, `runtime/` (config, boot, worker), `vars/` (settings), `module/`, `db/` (internal tables).
- `src/models/`: built-in models (`user`, `file`, `access_group`).
- `template/`: what `njin create` copies. `template/CLAUDE.md` is the guide for projects built *with* njin; it is not about
  this repo.
- `playground/` is gitignored: a project for trying things, linked to this package with `bun link`.
- `tests/` mirrors `src/`: `tests/core/**` for `src/core`, `tests/modules` for `src/modules`, `tests/cli`; shared helpers
  in `tests/helpers`, fixture models in `tests/fixtures`.

## Commands

```bash
bun install
bun run test          # bun test --isolate: each file in its own process
bun run test:coverage
bun run lint           # biome check .   (lint:fix / format to apply)
bunx tsc --noEmit
```

CI runs `biome ci`, `tsc --noEmit` and the tests. All three must pass.

## Tests

- Bun's test runner with `--isolate` (use `bun run test`; a bare `bun test` leaves it off). Tests use a real in-memory database, not a hand-written fake: `await useTestDb()` at the
  top of the file, before importing the modules under test, then `db.sync([...models])`. SurrealDB is the default;
  `NJIN_TEST_ADAPTER=postgres|sqlite|mysql` runs the same tests on another engine.
- Modules are mounted on `makeFakeElysia()` (`tests/helpers/fake_elysia.ts`) and exercised with `app.handle(new Request(...))`.
- Code that reads config (`publicBase`, the session cookie's `Secure` flag) needs `getConfig` mocked with `mock.module`.
- Each new behaviour gets a test in the mirrored folder; a change to an endpoint's contract updates `README.md` and
  `template/CLAUDE.md` in the same commit.

## Auth model (what several files depend on)

- Three kinds of token, `njt:<id>:<secret>` with only a hash stored: `session` (login), `pat` (personal token), `oauth`
  (a connected MCP client, short-lived with a rotating refresh token). `resolveBearer` (`modules/token.ts`) resolves a token
  to a principal; `auth: true | { session: true } | { mcp: true } | { can: [resource, action] }` on a route is the only way
  to protect it. Managing users, groups and tokens is session-only so a leaked agent token cannot mint a replacement.
- A browser keeps the session in the `njin_session` HttpOnly cookie (`core/auth/session_cookie.ts`), set at login and
  setup. The `auth` macro accepts it for sessions only, and a request on it that changes data must carry `X-Requested-With`.
- Permissions are worked out per request from the user's access groups, narrowed by a token's scopes; nothing is copied into
  the token.
- The OAuth sign-in and consent screens are the admin's. Core serves JSON (`/api/oauth/authorize`, `/api/oauth/consents`),
  the standard endpoints (`/oauth/register`, `/oauth/token`, `/oauth/revoke`, `.well-known/*`), and no HTML for them.

## Conventions

- English code and comments. Comments say why, not what, and match the density of the code around them.
- Keep it simple and explicit: plain functions and modules over layers of abstraction.
- Formatting and lint are Biome (`biome.json`: 2 spaces, LF, line width 80). Do not hand-format.
- Dependencies in `package.json` stay alphabetical. njin is Bun-only.
- A new feature module is registered in `src/config/module.ts` and gets its own test file in `tests/modules/`.
- Public API is the `exports` map in `package.json`; moving a file that one points at is a breaking change.
- A release is a GitHub release whose tag equals `package.json`'s version (the workflow checks it). A breaking change to
  the API, the config or the admin contract is called out in the commit message (`feat!:` or a `BREAKING CHANGE` note).
