import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// electron-vite three-target config.
// - main:     Electron main process (Node). Entry = electron/main.ts. All domain
//             modules (logWatcher, logParsers, missionStore, uexClient) live in /electron.
// - preload:  the typed contextBridge. Entry = src/preload/index.ts.
// - renderer: Vite + React UI. Root = src/renderer, entry = src/renderer/index.html.
// Shared contracts (src/shared) are imported by all three targets via the @shared alias.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@electron": resolve("electron"),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve("electron/main.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve("src/renderer/index.html") },
      },
    },
  },
});
