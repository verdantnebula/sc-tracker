// Renderer-only Vite config for STANDALONE browser preview/dev (verification).
// Not used by the production electron-vite build (electron.vite.config.ts is the
// shipping config). Mirrors the renderer aliases so the dev mock window.api path
// can be exercised in a plain browser. Lives under src/renderer (owned area).
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "../shared"),
      "@renderer": resolve(__dirname, "./src"),
    },
  },
  plugins: [react()],
  server: { port: 5199 },
});
