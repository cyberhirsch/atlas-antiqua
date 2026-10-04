import { resolve } from "node:path";
import { defineConfig } from "vite";

// GitHub Pages serves the site under /atlas-antiqua/; set ATLAS_BASE for that build.
export default defineConfig({
  base: process.env.ATLAS_BASE ?? "/",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { main: resolve(__dirname, "index.html"), coverage: resolve(__dirname, "coverage.html") } },
  },
});
