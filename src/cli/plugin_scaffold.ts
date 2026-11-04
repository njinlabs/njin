// What `njin plugin:create` and `njin create --plugin` write. Kept as code (not a template fetched
// from GitHub) so both share it, it works offline and a test can read it.

export type Files = Record<string, string>;

const NAME = /^[a-z][a-z0-9-]*$/;

// The plugin's name as the admin sees it: the last part of a package name, which must be a plain
// lowercase word (it prefixes a field renderer, `<name>:slugify`, and names a route).
export const pluginName = (input: string): string => {
  const name = input.split("/").pop() ?? "";
  if (!NAME.test(name)) {
    throw new Error(
      `"${input}" is not a usable plugin name — use lowercase letters, digits and dashes, starting with a letter.`,
    );
  }
  return name;
};

export const camelCase = (name: string) =>
  name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const title = (name: string) =>
  name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

// The plugin's admin side: one page and its menu entry.
export const adminFiles = (name: string): Files => ({
  "admin/index.tsx": `import { defineAdminPlugin } from "@njinlabs/njin-admin/sdk";
import "./index.css";

const Page = () => (
  <div className="p-4">
    <h1 className="text-xl font-semibold text-foreground">${title(name)}</h1>
  </div>
);

export default defineAdminPlugin({
  name: "${name}",
  navs: [
    { icon: () => <span aria-hidden>•</span>, label: "${title(name)}", to: "/${name}" },
  ],
  routes: [{ path: "/${name}", component: Page }],
});
`,
  "admin/index.css": `@import "@njinlabs/njin-admin/plugin.css";
@source "./";
`,
});

// A plugin that lives in the project: \`<dir>/index.ts\` and its admin side beside it.
export const inlineFiles = (name: string): Files => ({
  "index.ts": `import { definePlugin } from "@njinlabs/njin";

export default () =>
  definePlugin({
    admin: [import.meta.resolve("./admin/index.tsx")],
  });
`,
  ...adminFiles(name),
});

// What to tell the person once an inline plugin is written. Nothing is changed for them.
export const inlineHints = (
  name: string,
  dir: string,
  adminInstalled: boolean,
): string => {
  const id = camelCase(name);
  const lines = [
    `Register it in config.ts:`,
    ``,
    `  import ${id} from "./${dir}";`,
    `  ...`,
    `  plugins: [${id}()],`,
  ];

  if (!adminInstalled) {
    lines.push(
      ``,
      `Its admin side needs the admin package, which is not in package.json yet:`,
      ``,
      `  bun add @njinlabs/njin-admin`,
    );
  }

  return lines.join("\n");
};

type Versions = {
  // Version ranges for package.json: the njin this was created with, and the admin package to
  // build against.
  njin: string;
  admin: string;
};

// A whole package for a plugin to publish, with a small project (dev/) to try it in.
export const packageFiles = (
  packageName: string,
  name: string,
  versions: Versions,
): Files => ({
  "package.json": `${JSON.stringify(
    {
      name: packageName,
      version: "0.0.0",
      type: "module",
      exports: { ".": "./src/index.ts" },
      // The admin side is published built (admin/dist): a project that installs the plugin needs
      // neither Vite nor Tailwind to use it.
      files: ["src", "admin/dist"],
      scripts: {
        dev: "cd dev && njin dev",
        "dev:admin": "cd dev && njin update --admin",
        build: "bunx --bun vite build --config admin/vite.config.ts",
        prepublishOnly: "bun run build",
      },
      peerDependencies: {
        "@njinlabs/njin": versions.njin,
        "@njinlabs/njin-admin": versions.admin,
      },
      devDependencies: {
        "@njinlabs/njin": versions.njin,
        "@njinlabs/njin-admin": versions.admin,
        "@types/bun": "latest",
        "@types/react": "^19.2.14",
        typescript: "^5",
        vite: "^8.0.14",
      },
    },
    null,
    2,
  )}\n`,

  "tsconfig.json": `${JSON.stringify(
    {
      compilerOptions: {
        lib: ["ESNext", "DOM"],
        target: "ESNext",
        module: "Preserve",
        moduleDetection: "force",
        jsx: "react-jsx",
        types: ["bun"],
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
      },
      include: ["src", "admin", "dev"],
    },
    null,
    2,
  )}\n`,

  ".gitignore": `node_modules
admin/dist
dev/_admin
dev/*.db
dev/uploads
`,

  "src/index.ts": `import { definePlugin } from "@njinlabs/njin";

export default () =>
  definePlugin({
    // The built admin side: \`bun run build\` writes it. \`dev/\` loads the source instead.
    admin: [import.meta.resolve("../admin/dist/index.js")],
  });
`,

  ...adminFiles(name),

  "admin/vite.config.ts": `import { adminPluginConfig } from "@njinlabs/njin-admin/vite";
import { defineConfig } from "vite";

export default defineConfig(
  adminPluginConfig({ entry: "admin/index.tsx", outDir: "admin/dist" }),
);
`,

  "dev/config.ts": `import sqliteAdapter from "@njinlabs/njin/adapters/sqlite";
import { defineConfig } from "@njinlabs/njin/config";
import plugin from "../src";

export default defineConfig({
  port: Number(process.env.PORT ?? 3000),
  adapters: { db: sqliteAdapter({ path: "dev.db" }) },
  plugins: [
    // The plugin's own admin side is the build; here it is swapped for the source, so a change
    // shows without building.
    { ...plugin(), admin: [import.meta.resolve("../admin/index.tsx")] },
  ],
});
`,

  "README.md": `# ${packageName}

A plugin for [njin](https://github.com/njinlabs/njin).

## Develop

\`\`\`sh
bun install
bun run dev:admin   # once: downloads the admin panel into dev/_admin
bun run dev         # runs dev/ on http://localhost:3000, with the plugin from source
\`\`\`

\`dev/\` is a small njin project that only exists to try the plugin in. Add the plugin's models,
routes and the rest to \`src/index.ts\`, and its pages to \`admin/\`.

## Publish

\`\`\`sh
bun publish
\`\`\`

\`prepublishOnly\` builds the admin side into \`admin/dist\`, which the package ships: a project
that installs the plugin needs neither Vite nor Tailwind for it.

## Use it in a project

\`\`\`sh
bun add ${packageName} @njinlabs/njin-admin
\`\`\`

\`\`\`ts
// config.ts
import ${camelCase(name)} from "${packageName}";

export default defineConfig({
  plugins: [${camelCase(name)}()],
});
\`\`\`

## Styling the admin side

The plugin's page is drawn inside the admin, on the same page as its own styles.

- Keep \`@source "./";\` in \`admin/index.css\`. Without it Tailwind scans the whole project it runs
  in and the stylesheet carries every class the rest of the site uses.
- Prefix classes of your own (\`${name}-card\`): a common name such as \`.card\` can override the
  admin's or another plugin's.
- Take colors from the admin's tokens (\`text-foreground\`, \`bg-primary\`, \`var(--color-*)\`), not
  from hex values, so dark mode and themes follow.
`,
});
