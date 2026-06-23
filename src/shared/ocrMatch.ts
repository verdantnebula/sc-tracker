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

    let score = similarity(normInput, normCand);

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
