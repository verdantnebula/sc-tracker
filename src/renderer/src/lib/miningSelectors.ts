// ============================================================================
// miningSelectors.ts — pure helpers for the Mining mode views.
// ----------------------------------------------------------------------------
// All functions here are PURE (no DOM, no IPC) so they are unit-testable. The
// centerpiece is `lookupScan`: given a value the player reads off their mining
// scanner, find which rock(s) it matches by comparing against every rock's six
// scan-signature values (with a small tolerance to absorb radar rounding).
// ============================================================================

import type { MiningRock, MiningDeposit } from "@shared/types";
import { depositInArea } from "@shared/miningArea";

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

// ---------------------------------------------------------------------------
// UNIFIED SEARCH — one box that takes EITHER a radar scan value OR a mineral
// name and routes to the right helper. Used by the compact Mining overlay so a
// single input handles both flows. The numeric-vs-name decision is the only new
// logic here; the actual matching reuses lookupScan / searchRocksByName so this
// stays a thin dispatcher (no duplicated lookup logic). Pure: no DOM, no IPC.
// ---------------------------------------------------------------------------

/**
 * Result of {@link searchRocks}: a discriminated union on `mode` so callers can
 * render value-matches (with tier info) vs name-matches (plain rocks) without
 * re-sniffing the query.
 *  - `mode: "value"` -> `matches` are ScanMatch[] (from lookupScan).
 *  - `mode: "name"`  -> `matches` are MiningRock[] (from searchRocksByName).
 */
export type RockSearchResult =
  | { mode: "value"; matches: ScanMatch[] }
  | { mode: "name"; matches: MiningRock[] };

/**
 * Decide whether `query` looks like a radar scan VALUE (a number) or a mineral
 * NAME (text) and dispatch accordingly:
 *
 *  - Numeric string (after stripping thousands separators / spaces, e.g. "4300"
 *    or "4,300") -> VALUE path: lookupScan(value, rocks, tolerancePct).
 *  - Any other non-empty string (e.g. "Gold", "qua") -> NAME path:
 *    searchRocksByName(query, rocks).
 *  - Empty / whitespace-only query -> NAME path with all rocks (matches the
 *    existing searchRocksByName "empty => all" convention), so the overlay can
 *    show the full pickable list before the user types.
 *
 * "Numeric" means the trimmed input parses to a finite number AND contains a
 * digit, so a name like "Gold" never accidentally takes the value path even
 * though Number("") is 0. Reuses the existing helpers internally.
 *
 *   searchRocks("4300", rocks) -> { mode: "value", matches: lookupScan(4300,…) }
 *   searchRocks("Gold", rocks) -> { mode: "name",  matches: searchRocksByName(…) }
 *   searchRocks("", rocks)     -> { mode: "name",  matches: all rocks }
 *
 * Pure: no DOM, no IPC.
 */
export function searchRocks(
  query: string,
  rocks: MiningRock[],
  tolerancePct = 1,
): RockSearchResult {
  const cleaned = query.replace(/[, ]/g, "").trim();
  const isNumeric =
    cleaned.length > 0 &&
    /\d/.test(cleaned) &&
    Number.isFinite(Number(cleaned));

  if (isNumeric) {
    return {
      mode: "value",
      matches: lookupScan(Number(cleaned), rocks, tolerancePct),
    };
  }
  return { mode: "name", matches: searchRocksByName(query, rocks) };
}

// ---------------------------------------------------------------------------
// AREA SCANNABLE ROCKS — the "minerals near you" set for the Mining overlay.
// Extracted from MiningRockValuesView's inline `isNear` predicate so the overlay
// and the main table share ONE tested rule. A scannable rock counts as "near
// you" when its deposit record (matched by name) is minable in the area regions
// derived from the player's current body (see @shared/miningArea). Rocks with no
// matching deposit row can't be located, so they are never "near".
// ---------------------------------------------------------------------------

/** A scan rock paired with its deposit (where it's found) for the area filter. */
export interface AreaScannableRock {
  /** The scannable rock (name, rarity, six scan-signature values). */
  rock: MiningRock;
  /** Its matched deposit record (the FoundAt regions that placed it in-area). */
  deposit: MiningDeposit;
}

/**
 * The set of scannable rocks minable in the player's current area: each rock
 * whose deposit (matched by name) falls inside `areaRegions`. Returns [] when no
 * body resolved (empty regions) — callers degrade gracefully to "show all" or a
 * muted hint. Sorted rarest-first then by name so the most interesting rock to
 * mine leads the compact overlay list. Pure: no DOM, no IPC.
 *
 *   areaScannableRocks(rocks, deposits, areaRegionsForBody("Hurston"))
 *     -> [{ rock: Quantainium, deposit }, { rock: Gold, deposit }, …]
 *   areaScannableRocks(rocks, deposits, [])  -> []
 */
export function areaScannableRocks(
  rocks: MiningRock[],
  deposits: MiningDeposit[],
  areaRegions: string[],
): AreaScannableRock[] {
  if (areaRegions.length === 0) return [];
  const out: AreaScannableRock[] = [];
  for (const rock of rocks) {
    const deposit = depositForRock(rock.name, deposits);
    if (deposit && depositInArea(deposit, areaRegions)) {
      out.push({ rock, deposit });
    }
  }
  return out.sort(
    (a, b) =>
      rarityRank(b.rock.rarity) - rarityRank(a.rock.rarity) ||
      a.rock.name.localeCompare(b.rock.name),
  );
}
