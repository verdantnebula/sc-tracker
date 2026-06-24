// ============================================================================
// miningSelectors.ts — pure helpers for the Mining mode views.
// ----------------------------------------------------------------------------
// All functions here are PURE (no DOM, no IPC) so they are unit-testable. The
// centerpiece is `lookupScan`: given a value the player reads off their mining
// scanner, find which rock(s) it matches by comparing against every rock's six
// scan-signature values (with a small tolerance to absorb radar rounding).
// ============================================================================

import type { MiningRock, MiningDeposit } from "@shared/types";

/** Number formatting used across the mining views. */
export const fmt = (n: number): string =>
  Math.round(n || 0).toLocaleString("en-US");

// ---------------------------------------------------------------------------
// Rarity — canonical order + theme-token color mapping. The source data uses
// the five tiers Common/Uncommon/Rare/Epic/Legendary (matching the user's
// table). Colors are theme tokens so they re-skin with the active mode.
// ---------------------------------------------------------------------------

export const RARITY_ORDER = [
  "Common",
  "Uncommon",
  "Rare",
  "Epic",
  "Legendary",
] as const;

export type Rarity = (typeof RARITY_ORDER)[number];

/**
 * Map a rarity label to a CSS color token (var(--…)). Mirrors the user's table:
 * common = blue/teal, uncommon = green, rare = purple, epic = orange,
 * legendary = light/gold. Unknown rarities fall back to the muted token.
 */
export function rarityColor(rarity: string): string {
  switch (rarity) {
    case "Common":
      return "var(--rarity-common)";
    case "Uncommon":
      return "var(--rarity-uncommon)";
    case "Rare":
      return "var(--rarity-rare)";
    case "Epic":
      return "var(--rarity-epic)";
    case "Legendary":
      return "var(--rarity-legendary)";
    default:
      return "var(--muted)";
  }
}

/** Sort-key index for a rarity (lower = more common). Unknown sorts last. */
export function rarityRank(rarity: string): number {
  const i = (RARITY_ORDER as readonly string[]).indexOf(rarity);
  return i === -1 ? RARITY_ORDER.length : i;
}

// ---------------------------------------------------------------------------
// SCAN LOOKUP — the centerpiece.
// ---------------------------------------------------------------------------

/** A single rock that matched a scanned value, with which tier it matched. */
export interface ScanMatch {
  /** The matched rock's name. */
  name: string;
  /** The matched rock's rarity. */
  rarity: string;
  /** Which of the six scan tiers matched (1..6). */
  tier: number;
  /** The exact scan-signature value of the matched tier. */
  tierValue: number;
  /** Absolute difference between the queried value and the tier value. */
  delta: number;
  /** The full rock record (for cross-linking to deposit info, etc.). */
  rock: MiningRock;
}

/**
 * Find every rock/tier whose scan-signature value matches `value`, within an
 * optional tolerance. Tolerance is a PERCENT of the candidate tier value (so a
 * larger tier absorbs proportionally more radar rounding); pass 0 for exact.
 *
 * A rock can match more than once if two of its tiers fall within tolerance of
 * the query (rare, but possible near boundaries) — each matching tier is its
 * own entry. Results are sorted by smallest delta first, then rarity, then name
 * so the closest, rarest match leads.
 *
 *   lookupScan(8600, rocks)         -> exact: Ice tier 2 (8600)
 *   lookupScan(8590, rocks, 1)      -> within 1%: Ice tier 2 (Δ10), Aluminum t2…
 *   lookupScan(123, rocks)          -> [] (no rock matches)
 *
 * Pure: no DOM, no IPC.
 */
export function lookupScan(
  value: number,
  rocks: MiningRock[],
  tolerancePct = 1,
): ScanMatch[] {
  if (!Number.isFinite(value)) return [];
  const tol = Math.max(0, tolerancePct) / 100;

  const matches: ScanMatch[] = [];
  for (const rock of rocks) {
    rock.scanValues.forEach((tierValue, i) => {
      const delta = Math.abs(value - tierValue);
      // Exact match OR within tolerance of this tier's value.
      if (delta === 0 || delta <= tierValue * tol) {
        matches.push({
          name: rock.name,
          rarity: rock.rarity,
          tier: i + 1,
          tierValue,
          delta,
          rock,
        });
      }
    });
  }

  return matches.sort(
    (a, b) =>
      a.delta - b.delta ||
      rarityRank(b.rarity) - rarityRank(a.rarity) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Cross-link a matched rock to its deposit record (where it's found), matched
 * by name. Returns null when the rock has no corresponding deposit entry (some
 * rocks in the scan table may not appear in the deposits list, and vice versa).
 */
export function depositForRock(
  rockName: string,
  deposits: MiningDeposit[],
): MiningDeposit | null {
  return deposits.find((d) => d.name === rockName) ?? null;
}

// ---------------------------------------------------------------------------
// NAME LOOKUP — the primary mining-lookup path. The player types/selects a
// metal name and we show its detail (rarity, the six scan values to expect, its
// mining type, and where it's found). This replaces the numeric radar-value
// reverse-lookup as the default; a small "by scan value" affordance remains.
// ---------------------------------------------------------------------------

/**
 * Filter the rocks by a name query (case-insensitive substring), ranked so the
 * best matches lead: a name that STARTS WITH the query first, then any name that
 * merely CONTAINS it, each group sorted by rarity (rarest first) then name. An
 * empty/whitespace query returns ALL rocks (sorted the same way) so the view can
 * render the full pickable list before the user types. Pure: no DOM, no IPC.
 *
 *   searchRocksByName("qua", rocks)  -> [Quantainium, Quartz, ...]
 *   searchRocksByName("", rocks)     -> every rock, rarity-desc then name
 */
export function searchRocksByName(
  query: string,
  rocks: MiningRock[],
): MiningRock[] {
  const q = query.trim().toLowerCase();
  const byRank = (a: MiningRock, b: MiningRock): number =>
    rarityRank(b.rarity) - rarityRank(a.rarity) || a.name.localeCompare(b.name);

  if (q === "") return [...rocks].sort(byRank);

  const starts: MiningRock[] = [];
  const contains: MiningRock[] = [];
  for (const r of rocks) {
    const n = r.name.toLowerCase();
    if (n.startsWith(q)) starts.push(r);
    else if (n.includes(q)) contains.push(r);
  }
  return [...starts.sort(byRank), ...contains.sort(byRank)];
}
