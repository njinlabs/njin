import { defineConfig } from "@njinlabs/njin/config";
import bunFilesystemAdapter from "@njinlabs/njin/adapters/bun_filesystem";

export default defineConfig({
  port: Number(process.env.PORT ?? 3000),
  db: {
    path: process.env.DB_PATH ?? "rocksdb://data",
    namespace: process.env.DB_NAMESPACE ?? "general",
    database: process.env.DB_DATABASE ?? "general",
    // Only needed for a remote db.path (ws://, wss://, http://, https://) — root/system auth or a token:
    // auth: process.env.DB_TOKEN
    //   ? process.env.DB_TOKEN
    //   : process.env.DB_USERNAME && process.env.DB_PASSWORD
    //     ? { username: process.env.DB_USERNAME, password: process.env.DB_PASSWORD }
    //     : undefined,
  },
  img: {
    hosts: process.env.IMG_HOSTS
      ? process.env.IMG_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
      : [],
  },
  adapters: {
    file: bunFilesystemAdapter({ dir: "./uploads" }),
  },
  models: [
    // Register your models here, e.g.:
    // () => import("./src/models/post"),
  ],
  vars: [
    // Singleton settings objects (site name, SEO meta, ...), e.g.:
    // () => import("./src/vars/general"),
  ],
  helpers: [
    // Stateless functions exposed as Edge template globals, e.g.:
    // () => import("./src/helpers/format_date"),
  ],
  events: [
    // Listener files — imported here so their .listen() calls run at boot, e.g.:
    // () => import("./src/events/listeners/send_receipt"),
  ],
  routes: [
    // Custom Elysia routes, e.g.:
    // () => import("./src/routes/webhook"),
  ],
  plugins: [
    // Installable bundles of models/vars/hooks/events/routes, e.g.:
    // myPlugin({ apiKey: process.env.MY_PLUGIN_KEY! }),
  ],
});
