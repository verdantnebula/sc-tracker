// ============================================================================
// location.ts — shared location matching for the "YOU ARE HERE" highlight.
// ----------------------------------------------------------------------------
// Imported by BOTH the renderer selectors and the main-process store so the
// highlight rule is identical everywhere. The humanized current-location id
// (from a terminal/inventory event) often will NOT match a mission's dropoff
// DISPLAY name at all — that's expected. Only light up the highlight on a
// CONFIDENT match; if unsure, don't highlight (a false "YOU ARE HERE" is worse
// than none).
// ============================================================================

import type { Terminal } from "./types";

/**
 * Order destinations for a dropdown: real cargo centers first (the common drops),
 * then everything else, each group alphabetical. We OFFER every known location —
 * this is purely a SORT, never a filter (the dropdown-too-small bug was caused by
 * filtering to `isCargoCenter`). Returns a new array; input is not mutated.
 */
export function sortDestinations(terminals: Terminal[]): Terminal[] {
  return [...terminals].sort((a, b) => {
    if (a.isCargoCenter !== b.isCargoCenter) return a.isCargoCenter ? -1 : 1;
    return (a.displayname || a.name).localeCompare(b.displayname || b.name);
  });
}

/**
 * Confident match between the player's humanized current location and a
 * dropoff's display name. True only when:
 *  - both sides are present, and
 *  - they are case-insensitively equal, OR one fully contains the other and the
 *    shorter side is >= 4 chars (so a tiny fragment can't false-positive).
 */
export function isConfidentLocationMatch(
  current: string | null | undefined,
  dropoff: string | null | undefined,
): boolean {
  if (!current || !dropoff) return false;
  const a = current.trim().toLowerCase();
  const b = dropoff.trim().toLowerCase();
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 4) return false;
  return longer.includes(shorter);
}
