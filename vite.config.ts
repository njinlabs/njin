import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  publicDir: false,
  build: {
    outDir: "public",
    emptyOutDir: true,
    manifest: "manifest.json",
    rollupOptions: {
      input: "src/client/main.ts",
    },
  },
});
