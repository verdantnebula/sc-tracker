// ============================================================================
// ocrMatch.ts — PURE fuzzy matcher for OCR'd commodity/location spans (Phase F)
// ----------------------------------------------------------------------------
// EXPERIMENTAL. The OCR parser ([[ocrParse]]) returns RAW commodity/location
// strings as tesseract.js read them off the mobiGlas screen. Those will rarely
// be byte-identical to the bundled reference names (OCR drops/garbles letters,
// the screen abbreviates, casing differs). This module maps a noisy input span
// to the best candidate in a known list, with a confidence score, so the
// review-before-apply dialog can pre-fill the field AND show how sure it is.
//
// PURE + dependency-free: a normalized-equality fast path, then a bounded
// Levenshtein edit distance turned into a 0..1 similarity. No network, no I/O —
// fully unit-testable on sanitized fixture strings. We deliberately keep the
// algorithm simple and explainable (the user is the final authority in the
// review step); the goal is a sensible pre-fill, not perfect recognition.
// ============================================================================

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Canonical form for comparison: lowercase, strip everything but [a-z0-9],
 * collapsing case/space/punctuation differences. "Baijini Point" and
 * "baijini  point." both normalize to "baijinipoint". Used by both the
 * fast-path equality check and the edit-distance normalization.
 */
export function normalizeForMatch(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Edit distance (bounded Levenshtein)
// ---------------------------------------------------------------------------

/**
 * Levenshtein edit distance between two strings. Classic two-row DP, O(a*b)
 * time, O(min) space. Inputs here are short reference names so this is cheap.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

/**
 * Similarity in [0,1] derived from edit distance over the longer length.
 * 1 = identical (after normalization); 0 = completely different. Empty-vs-empty
 * is treated as 1 (both blank "match"); empty-vs-nonempty is 0.
 */
export function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

// ---------------------------------------------------------------------------
// Confusable-character weighted edit distance (Item 1)
// ---------------------------------------------------------------------------
//
// WHY. The plain Levenshtein above charges EVERY substitution a flat 1.0, so an
// OCR glyph misread ("Quagtz" for "Quartz", "Baljini" for "Baijini", "5tims"
// for "Stims") costs exactly as much as a genuinely different letter. But OCR
// errors are NOT uniform — a small, well-known set of glyph pairs account for
// most of them (i/l/1, o/0, s/5, b/8, g/9/q). Charging those pairs LESS than a
// real substitution lets a noisy read snap to the correct reference entry while
// a genuinely different name still accumulates full-cost edits and stays
// unmatched.
//
// OVER-CORRECTION GUARD (the critical constraint). Cheap swaps make EVERYTHING
// look a little closer, which could pull an unrelated name over the threshold.
// Two things prevent that:
//   1. Only the small confusable set is discounted; cross-group and arbitrary
//      substitutions still cost the full 1.0, so a different name racks up
//      full-cost edits and can't sneak in on cheap swaps alone.
//   2. fuzzyMatch keeps the SAME 0.6 accept threshold as before (it never
//      lowers it), so the discount only helps inputs that were already close.
//      A clearly-different string ("Zworblax Station" vs "Baijini Point") has
//      far more than a couple of confusable positions and stays well below 0.6.

/** Per-character cost of a CONFUSABLE substitution (vs 1.0 for a normal one). */
export const CONFUSABLE_SUB_COST = 0.4;

/**
 * OCR look-alike groups (defined in NORMALIZED space — lowercase a-z0-9, since
 * normalizeForMatch strips everything else, so "|"/"!" never reach this map).
 * A substitution between two members of the SAME group is "cheap"
 * ({@link CONFUSABLE_SUB_COST}); any other substitution costs the full 1.0.
 */
const CONFUSABLE_GROUPS: readonly string[] = [
  "il1", // i / l / 1  (and |,! — stripped by normalize before they arrive)
  "o0", // o / 0
  "s5", // s / 5
  "b8", // b / 8  (B lowercases to b)
  "g9q", // g / 9 / q
];

/** char -> group id, for O(1) "are these two chars confusable?" checks. */
const CHAR_GROUP: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  CONFUSABLE_GROUPS.forEach((group, gi) => {
    for (const ch of group) m.set(ch, gi);
  });
  return m;
})();

/** Substitution cost for replacing `a` with `b`: 0 if equal, cheap if they are
 *  in the same confusable group, else the full 1.0. */
function subCost(a: string, b: string): number {
  if (a === b) return 0;
  const ga = CHAR_GROUP.get(a);
  if (ga !== undefined && ga === CHAR_GROUP.get(b)) return CONFUSABLE_SUB_COST;
  return 1;
}

/**
 * Confusable-aware Levenshtein. Same two-row DP as {@link levenshtein}, but the
 * substitution cost comes from {@link subCost}, so an OCR look-alike swap is
 * charged {@link CONFUSABLE_SUB_COST} instead of 1.0. Insertions/deletions stay
 * at 1.0. The optional `{rn -> m}` / `{m -> rn}` collapse is handled as a cheap
 * 2-for-1 transition (one m aligns with "rn" at near-confusable cost) so
 * "Titaniurn" reads as "Titanium". PURE, never throws.
 */
export function weightedLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  let prev2 = new Array<number>(b.length + 1); // i-2 row, for the rn<->m rule
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const ca = a[i - 1];
      const cb = b[j - 1];
      let best = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + subCost(ca, cb), // substitution
      );
      // OPTIONAL {rn <-> m} merge: align a single "m" on one side with "rn" on
      // the other for a cheap combined cost (one glyph misread as two). Costs
      // CONFUSABLE_SUB_COST for the pair (cheaper than the 2 edits it replaces).
      if (
        i >= 2 &&
        ca === "n" &&
        a[i - 2] === "r" &&
        cb === "m" &&
        prev2[j - 1] !== undefined
      ) {
        best = Math.min(best, prev2[j - 1] + CONFUSABLE_SUB_COST);
      }
      if (
        j >= 2 &&
        cb === "n" &&
        b[j - 2] === "r" &&
        ca === "m" &&
        prev[j - 2] !== undefined
      ) {
        best = Math.min(best, prev[j - 2] + CONFUSABLE_SUB_COST);
      }
      curr[j] = best;
    }
    const tmp = prev2;
    prev2 = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

/**
 * Similarity in [0,1] from the {@link weightedLevenshtein} distance over the
 * longer length. Identical to {@link similarity} but confusable-aware, so an
 * OCR-glyph-only difference scores HIGHER than a plain-Levenshtein score would.
 * Empty-vs-empty is 1. Clamped to [0,1] (cheap fractional costs can never make
 * the distance exceed maxLen, but we clamp defensively).
 */
export function confusableSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  const s = 1 - weightedLevenshtein(a, b) / max;
  return s < 0 ? 0 : s > 1 ? 1 : s;
}

// ---------------------------------------------------------------------------
// Match result + the matcher
// ---------------------------------------------------------------------------

/** One fuzzy-match outcome. `value` is the chosen candidate (or null on no match). */
export interface FuzzyMatch {
  /** The best candidate string, or null when nothing cleared the threshold. */
  value: string | null;
  /** Confidence in [0,1]: 1 = exact (normalized), lower = looser edit match. */
  score: number;
}

/** Tuning for the matcher. Defaults chosen to be tolerant but not reckless. */
export interface FuzzyMatchOptions {
  /**
   * Minimum similarity required to return a candidate (else value=null). 0.6
   * tolerates a few wrong characters on a typical name while rejecting noise.
   */
  threshold?: number;
}

const DEFAULT_THRESHOLD = 0.6;

/**
 * Find the best candidate for a noisy OCR input among `candidates`.
 *
 * Algorithm:
 *  1. Normalize input + every candidate (case/space/punct-insensitive).
 *  2. Exact normalized equality -> score 1 (short-circuit, first wins).
 *  3. Otherwise pick the highest edit-distance similarity. A normalized
 *     SUBSTRING containment (input within a candidate or vice-versa, when the
 *     shorter side is >= 3 chars) is boosted, since OCR often truncates a name.
 *  4. Return the best candidate IFF its score >= threshold, else { null, score }
 *     (the score is still reported so the UI can show "no confident match").
 *
 * PURE: never mutates inputs, never throws. An empty/blank input or empty
 * candidate list yields { value: null, score: 0 }.
 */
export function fuzzyMatch(
  input: string,
  candidates: readonly string[],
  options: FuzzyMatchOptions = {},
): FuzzyMatch {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const normInput = normalizeForMatch(input);
  if (normInput.length === 0 || candidates.length === 0) {
    return { value: null, score: 0 };
  }

  let best: string | null = null;
  let bestScore = 0;

  for (const cand of candidates) {
    const normCand = normalizeForMatch(cand);
    if (normCand.length === 0) continue;

    if (normCand === normInput) {
      return { value: cand, score: 1 };
    }

    // Confusable-aware similarity: an OCR glyph misread (i/l/1, o/0, s/5, b/8,
    // g/9/q, rn<->m) costs less than a real substitution, so a noisy read snaps
    // to the right entry. The accept threshold is UNCHANGED (see below), so a
    // genuinely different name — which has many full-cost edits, not just a
    // couple of cheap swaps — still stays below it (over-correction guard).
    let score = confusableSimilarity(normInput, normCand);

    // Containment boost: OCR frequently reads a fragment of a longer name.
    const [shorter, longer] =
      normInput.length <= normCand.length
        ? [normInput, normCand]
        : [normCand, normInput];
    if (shorter.length >= 3 && longer.includes(shorter)) {
      const containmentScore = 0.5 + (0.5 * shorter.length) / longer.length;
      score = Math.max(score, containmentScore);
    }

    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }

  if (best !== null && bestScore >= threshold) {
    return { value: best, score: bestScore };
  }
  return { value: null, score: bestScore };
}

// ---------------------------------------------------------------------------
// Title → mission matcher (Part A — drives the review-dialog preselect)
// ---------------------------------------------------------------------------
//
// The OCR'd contract TITLE is used to pre-select the correct mission in the
// review dialog — but ONLY when we're CONFIDENT. Two near-duplicate missions
// (e.g. "… from MIC-L2 Long Forest Station" vs "… from ARC-L1 Wide Forest
// Station") share most of their text, so a naive "best score" pick would happily
// (and wrongly) preselect one over the other. We therefore require the best
// candidate to BOTH clear an absolute threshold AND beat the runner-up by a
// clear MARGIN. If two candidates are too close (or nothing clears the
// threshold), we report `confident: false` and the dialog leaves the dropdown
// empty (preserving the "default empty, Apply greyed until chosen" rule).

/** Tuning for {@link matchTitleToMissions}. */
export interface TitleMatchOptions {
  /**
   * Minimum similarity the BEST candidate must reach to be eligible at all.
   * Titles are long and OCR garbles a few chars, so a real match scores high;
   * 0.6 admits a genuine read while rejecting an unrelated title.
   */
  threshold?: number;
  /**
   * Minimum gap (best − second-best) required to call the pick CONFIDENT. Two
   * near-duplicate titles score within a hair of each other, so a small margin
   * means "ambiguous" → not confident → no preselect. 0.08 separates a clear
   * winner from a coin-flip between near-duplicates.
   */
  margin?: number;
}

const DEFAULT_TITLE_THRESHOLD = 0.6;
const DEFAULT_TITLE_MARGIN = 0.08;

/** Outcome of matching an OCR title against the candidate mission titles. */
export interface TitleMatch {
  /** Index of the best candidate in the input array, or -1 when none. */
  index: number;
  /** The best candidate's similarity score in [0,1]. */
  score: number;
  /**
   * True only when the best candidate cleared the threshold AND beat the
   * runner-up by the required margin — i.e. safe to PRE-SELECT. When false the
   * caller must NOT preselect (ambiguous or no real match).
   */
  confident: boolean;
}

/**
 * Match an OCR'd contract title against a list of candidate mission titles.
 * Returns the best candidate's index + score, and whether the match is CONFIDENT
 * enough to pre-select (cleared `threshold` AND beat the runner-up by `margin`).
 *
 * PURE + total: an empty/blank OCR title, an empty candidate list, or all-blank
 * candidates yield `{ index: -1, score: 0, confident: false }` (never throws).
 * Comparison is case/space/punctuation-insensitive via {@link normalizeForMatch}.
 *
 * @param ocrTitle    the title read off the contract screen (may be null).
 * @param candidates  the candidate mission titles, in the caller's own order
 *                    (the returned `index` refers to THIS array).
 */
export function matchTitleToMissions(
  ocrTitle: string | null | undefined,
  candidates: readonly string[],
  options: TitleMatchOptions = {},
): TitleMatch {
  const threshold = options.threshold ?? DEFAULT_TITLE_THRESHOLD;
  const margin = options.margin ?? DEFAULT_TITLE_MARGIN;
  const none: TitleMatch = { index: -1, score: 0, confident: false };

  const normInput = normalizeForMatch(ocrTitle ?? "");
  if (normInput.length === 0 || candidates.length === 0) return none;

  let bestIdx = -1;
  let bestScore = -1;
  let secondScore = -1;
  for (let i = 0; i < candidates.length; i++) {
    const normCand = normalizeForMatch(candidates[i]);
    if (normCand.length === 0) continue;
    const score = similarity(normInput, normCand);
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestIdx = i;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  if (bestIdx === -1) return none;

  // CONFIDENT only when the best clears the threshold AND beats the runner-up by
  // the margin. With a single candidate there's no runner-up, so the threshold
  // alone decides (secondScore stays -1 -> gap is large).
  const gap =
    secondScore < 0 ? Number.POSITIVE_INFINITY : bestScore - secondScore;
  const confident = bestScore >= threshold && gap >= margin;
  return { index: bestIdx, score: bestScore, confident };
}
