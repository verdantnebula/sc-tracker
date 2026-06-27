// ============================================================================
// cargoTitle.ts — PURE "is this a cargo haul?" title classifier  (Phase 3)
// ----------------------------------------------------------------------------
// Auto OCR Capture only triggers for CARGO contracts: an accepted mission whose
// title looks like a hauling job. The OCR pipeline reads the mobiGlas CARGO
// contract screen, so firing it for a non-cargo contract (bounty, ROC mining,
// etc.) would just capture the wrong screen and waste a pass. We gate on the
// title with a deliberately permissive, case-insensitive keyword test.
//
// PURE + total + defensive: a non-string / empty title is "not cargo" (we never
// trigger on a contract we can't classify). Kept here (not inlined in main.ts)
// so it is unit-testable without Electron and shared by any future caller.
// ============================================================================

/** Keywords that mark a contract title as a cargo haul (case-insensitive). */
const CARGO_TITLE_RE = /haul|cargo/i;

/**
 * True when `title` looks like a cargo-hauling contract (so Auto OCR Capture
 * should fire). Matches the substring "haul" or "cargo" anywhere, ignoring case
 * — covering "… Cargo Haul", "Hauling", "Bulk Cargo", etc. Defensive: a
 * non-string or empty title returns false.
 */
export function isCargoHaulTitle(title: unknown): boolean {
  if (typeof title !== "string" || title.length === 0) return false;
  return CARGO_TITLE_RE.test(title);
}
