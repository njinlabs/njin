# Instructions for AI agents

This is an [njin](https://njin.run) project. **Read `CLAUDE.md` in this folder before you change anything.** It is the full reference for njin: models, vars, views, events, plugins, the REST API, access control and the commands.

The essentials:

- The framework lives in `node_modules/@njinlabs/njin`. There is no framework source in this project to read or modify.
- To add a feature, only create or edit: `config.ts`, `src/models/`, `src/vars/`, `src/helpers/`, `src/events/`, `src/views/` (pages, layouts, components), and `src/client/`.
- Register new models, vars, helpers, events and plugins in `config.ts`.
- Use `logger()` from `@njinlabs/njin/logger` instead of `console.*` inside handlers, hooks and events.
- Run `bun run dev` to start the site and `bun run test` to run the tests.
