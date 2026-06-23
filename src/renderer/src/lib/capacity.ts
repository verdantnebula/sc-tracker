// ============================================================================
// capacity.ts — pure hold-capacity helper (Phase A ship picker / capacity bar).
// ----------------------------------------------------------------------------
// Maps "total SCU still owed" (grandTotalRemaining) against "the selected ship's
// hold (scu)" into the small view-model the CapacityBar renders. Pure + total:
// no React, no IPC, fully unit-tested (see capacity.test.ts).
// ============================================================================

/** A tier driving the capacity bar's color + messaging. */
export type CapacityTier = "ok" | "warn" | "over" | "none";

export interface CapacityStatus {
  /**
   * Fraction of the hold used, 0..1. CAPPED at 1 so the bar fill never exceeds
   * 100% — the over-capacity story is told by `overflowScu` / `trips` / `tier`,
   * not by an >100% bar. The label renders raw `total / cap` separately.
   */
  usedPct: number;
  /**
   * - none : no ship selected (or a non-positive hold) — nothing to compare.
   * - ok   : usedPct < 0.8 (comfortable).
   * - warn : 0.8 <= usedPct <= 1.0 (tight; one trip but near/at the brim).
   * - over : usedPct > 1.0 (won't fit in one trip).
   */
  tier: CapacityTier;
  /** SCU that won't fit in the hold: max(0, total - shipScu). 0 with no ship. */
  overflowScu: number;
  /**
   * Trips needed to move all the cargo: ceil(total / shipScu), min 1 when there
   * is any cargo. 0 when there is no ship OR no cargo owed.
   */
  trips: number;
}

/** The warn threshold (>= this fraction full -> 'warn'). */
const WARN_AT = 0.8;

/**
 * Compute the capacity view-model.
 *
 * @param totalScu  total SCU still to deliver (grandTotalRemaining). Coerced to
 *                  a finite, non-negative number.
 * @param shipScu   selected ship's hold (SCU), or null/<=0 when no ship is set.
 */
export function capacityStatus(
  totalScu: number,
  shipScu: number | null,
): CapacityStatus {
  const total = Number.isFinite(totalScu) && totalScu > 0 ? totalScu : 0;

  // No ship (null, non-finite, or non-positive hold) -> nothing to compare.
  if (shipScu == null || !Number.isFinite(shipScu) || shipScu <= 0) {
    return { usedPct: 0, tier: "none", overflowScu: 0, trips: 0 };
  }

  const rawPct = total / shipScu;
  const usedPct = Math.min(1, rawPct); // cap the bar fill at 100%
  const overflowScu = Math.max(0, total - shipScu);
  const trips = total > 0 ? Math.max(1, Math.ceil(total / shipScu)) : 0;

  let tier: CapacityTier;
  if (rawPct > 1) tier = "over";
  else if (rawPct >= WARN_AT) tier = "warn";
  else tier = "ok";

  return { usedPct, tier, overflowScu, trips };
}
