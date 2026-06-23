// ============================================================================
// payout.ts — pure partial-delivery payout model (shared; main + renderer).
// ----------------------------------------------------------------------------
// APPROXIMATION — RE-VALIDATE PER PATCH. Star Citizen does not log the full
// contract reward before completion, and the partial-payout curve below is the
// community-observed model, not an official figure. Treat every number here as a
// best-effort estimate to re-check against the live game each patch. The ACTUAL
// logged payout (captured on completion in missionStore) remains the source of
// truth once a mission is done; this module is for the BEFORE / PARTIAL preview.
//
// The model (community-observed):
//   - You earn a step-function fraction of the reward based on the delivered
//     ratio (deliveredScu / totalScu). The brackets are SCU thresholds, NOT a
//     linear scale, and crossing a threshold is what bumps the payout.
//   - There is NO "+25% reputation" cash bonus. That was a myth: the 25% figure
//     is an SCU completion threshold, not extra credits. Do not add it.
//   - The estimated cash payout is snapped to the nearest 250 aUEC, matching how
//     the game tends to round contract rewards.
//
// Pure: no DB, no IO, no clock — trivially unit-testable and reused identically
// by the store/preview and the renderer readout.
// ============================================================================

/**
 * The fraction of the reward earned for a given delivered ratio (0..1+).
 *
 * Step function (community model). Boundaries use `>` (strictly greater than),
 * so a ratio sitting EXACTLY on a threshold falls into the LOWER bracket — except
 * a full delivery (ratio >= 1) which pays the whole reward:
 *
 *   ratio >= 1     -> 1     (100% — full delivery)
 *   ratio  > 0.75  -> 0.76  (76%)
 *   ratio  > 0.5   -> 0.45  (45%)
 *   ratio  > 0.25  -> 0.15  (15%)
 *   ratio  > 0     -> 0     (anything delivered but at/under 25% earns nothing)
 *   ratio <= 0     -> 0
 *
 * NOTE on boundaries: at ratio === 0.75 the factor is 0.45 (not 0.76); at 0.5 it
 * is 0.15; at 0.25 it is 0. You must DELIVER MORE THAN the threshold to claim the
 * higher bracket. Full (>= 1) is the only inclusive boundary.
 */
export function payoutFactor(ratio: number): number {
  if (ratio >= 1) return 1;
  if (ratio > 0.75) return 0.76;
  if (ratio > 0.5) return 0.45;
  if (ratio > 0.25) return 0.15;
  return 0;
}

/** Snap an aUEC amount to the nearest 250 (how contract rewards tend to round). */
export function snapPayout(n: number): number {
  return Math.round(n / 250) * 250;
}

/**
 * Estimate the cash payout for a partial delivery.
 *
 *   partialPayout(reward, deliveredScu, totalScu)
 *     = snapPayout(reward * payoutFactor(deliveredScu / totalScu))
 *
 * Edge cases:
 *   - totalScu <= 0 (unknown/suppressed leg quantities): we cannot compute a
 *     ratio, so we fall back to snapping the raw reward (assume the contract pays
 *     out in full rather than implying "you earned nothing"). The caller should
 *     prefer the actual logged payout in that situation anyway.
 *   - A 0 / negative reward snaps to 0.
 */
export function partialPayout(
  reward: number,
  deliveredScu: number,
  totalScu: number,
): number {
  if (totalScu <= 0) return snapPayout(reward);
  const ratio = deliveredScu / totalScu;
  return snapPayout(reward * payoutFactor(ratio));
}
