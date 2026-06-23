import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Vitest config. The app build uses electron-vite (electron.vite.config.ts),
// which vitest does NOT read. Tests import shared contracts via the @shared
// alias — previously this only ever appeared in `import type` (elided at
// transform), so no runtime alias was needed. @shared/location is a VALUE import
// (isConfidentLocationMatch), so the alias must resolve at runtime here too.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@electron": resolve(__dirname, "electron"),
      "@renderer": resolve(__dirname, "src/renderer/src"),
    },
  },
  test: {
    // Store/parser/watcher tests live under electron/; pure renderer-selector
    // tests live alongside the renderer lib; pure shared-contract modules
    // (e.g. payout.ts) keep their tests beside them under src/shared. All run
    // under the same Node ABI.
    include: [
      "electron/**/*.test.ts",
      "src/renderer/src/**/*.test.ts",
      "src/shared/**/*.test.ts",
    ],
  },
});
