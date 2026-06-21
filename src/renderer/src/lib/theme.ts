// ============================================================================
// theme.ts — app-mode -> CSS theme mapping (renderer)
// ----------------------------------------------------------------------------
// The two trackers (cargo / salvage) share one window but swap their entire
// design-token palette. Rather than re-style every component, we flip a single
// attribute on the document root — `data-mode` — and let tokens.css redefine
// the CSS custom properties under `[data-mode="salvage"]`. Cargo keeps the
// default `:root` tokens (the attribute is still set to "cargo" for symmetry,
// but no override block targets it, so nothing changes for cargo).
//
// The mapping (`themeForMode`) is a pure function so it is unit-testable with no
// DOM; `applyTheme` performs the single side effect (setting the attribute) and
// takes an injectable root element so it too can be tested without a browser.
// ============================================================================

import type { AppMode } from "@shared/types";

/** The value written to `document.documentElement[data-mode]` for each mode. */
export type ThemeAttr = "cargo" | "salvage";

/**
 * Pure mapping from an app mode to the theme attribute value. Defensive: any
 * non-salvage value resolves to "cargo" so a corrupt persisted mode can never
 * select a non-existent theme.
 */
export function themeForMode(
  mode: AppMode | string | null | undefined,
): ThemeAttr {
  return mode === "salvage" ? "salvage" : "cargo";
}

/** A minimal element shape that supports the dataset write — for testability. */
interface ModeTarget {
  dataset: { mode?: string };
}

/**
 * Apply a mode's theme by setting `data-mode` on the root element. Returns the
 * attribute value written so callers/tests can assert it. `root` defaults to
 * the live `document.documentElement` but is injectable for unit tests.
 */
export function applyTheme(
  mode: AppMode,
  root: ModeTarget | null = typeof document !== "undefined"
    ? document.documentElement
    : null,
): ThemeAttr {
  const attr = themeForMode(mode);
  if (root) root.dataset.mode = attr;
  return attr;
}
