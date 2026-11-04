# njin-app

This website is built with [njin](https://njin.run).

## Getting Started

Start the development server:

```bash
bun run dev
```

Open `http://localhost:3000` to see the site, and `http://localhost:3000/_admin` for the admin panel. The first time, the panel asks you to create your admin account.

## Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Start the development server |
| `bun run build` | Build the site for production into `out/` |
| `bun run start` | Run the site in production mode |
| `bun run test` | Run the tests |

## Project Structure

```
config.ts          Your site's settings and the list of models
src/models/        What your site stores: posts, pages, products...
src/views/         Pages and layouts
src/client/        Styles and browser scripts
static/            Images and other files served as they are
_admin/            The admin panel
```

## Working with AI

This project includes `CLAUDE.md` and `AGENTS.md`, which teach AI coding agents how to build with njin, so you can ask an agent to add a page or a model.

Agents can also manage the site's content by connecting to `/mcp` on your site (for example `http://localhost:3000/mcp`). In the admin panel, open **Connected apps** to see what is connected and to take access back at any time.

## Learn More

Read the documentation at [njin.run/docs](https://njin.run/docs).
