// ============================================================================
// Config loader (main process)
// ----------------------------------------------------------------------------
// Reads config.local.json — shape { "uexToken": "..." } — from the app root.
// The file is gitignored and never tracked; the real token is injected
// separately. If it is missing or malformed, the app still boots with UEX
// inactive (uexToken = null). NEVER hardcode a token here.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

export interface AppConfig {
  /** UEX Corp API bearer token, or null when not configured. */
  uexToken: string | null;
}

const PLACEHOLDER = "REPLACE_ME";

/**
 * Resolve config.local.json location. In dev it sits at the project root
 * (app.getAppPath()); in a packaged build it sits beside the executable
 * (process.resourcesPath / app root). We check the app path first, which is
 * correct for `electron-vite dev` and the unpacked layout.
 */
function configPath(): string {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return join(root, "config.local.json");
}

/**
 * Load config. Returns a safe default ({ uexToken: null }) on any failure so
 * the app boots regardless. Logs a single warning when UEX is inactive.
 */
export function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const token =
      typeof parsed.uexToken === "string" &&
      parsed.uexToken.length > 0 &&
      parsed.uexToken !== PLACEHOLDER
        ? parsed.uexToken
        : null;
    if (!token) {
      console.warn(
        "[config] config.local.json present but no valid uexToken — UEX inactive.",
      );
    }
    return { uexToken: token };
  } catch {
    console.warn(
      "[config] config.local.json not found — UEX inactive. App will boot from cache/empty.",
    );
    return { uexToken: null };
  }
}
