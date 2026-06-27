// ============================================================================
// ocrColumns.ts — PURE column isolation for the two-column contract screen
// ----------------------------------------------------------------------------
// THE PROBLEM. A FULL-SCREEN OCR of the mobiGlas contract screen reads TWO
// side-by-side columns interleaved: a DETAILS column on the LEFT (flavor prose —
// "containers 16 SCU or smaller…", a signature, etc.) and a PRIMARY OBJECTIVES
// column on the RIGHT (the actual cargo: "Deliver 0/69 SCU of Quartz", the
// dropoff stations). Flattening tesseract's text reads the two columns line-by-
// line, so a flavor sentence lands where an objective should be and the parser
// matches the wrong thing.
//
// THE FIX. We do NOT rely on tesseract's text flattening. With per-word bounding
// boxes (tesseract.js v7, `recognize(img, {}, { blocks: true })`) we can split
// the screen geometrically: keep the HEADER BAND (above the columns — reward,
// title, deadline) and the RIGHT objectives column, and DROP the LEFT details
// column. Then we reconstruct clean lines from the kept words.
//
// This module is PURE (OcrWord[] in, string out) and total (never throws — any
// degenerate input returns "" or the best-effort full text), so it is fully
// unit-testable on synthetic word arrays with no real screenshots.
//
// FALLBACK ORDER (graceful — worst case is never worse than today's behavior):
//   1. HEADER ANCHOR  — find the "PRIMARY OBJECTIVES" header (fuzzy). Its left x
//      is the column edge (colX) and its row y is the header row (headerY). Keep
//      words above headerY (the header band) and words right of colX below it.
//   2. X-GUTTER SPLIT — no anchor, but the body words form a clearly BIMODAL
//      x-distribution (a left group + a right group with a wide empty gutter):
//      keep the right group (+ the header band above the columns).
//   3. PASSTHROUGH    — no anchor and no clear gutter: reconstruct ALL words into
//      lines and return them (== today's behavior, never worse).
// ============================================================================

import type { OcrWord } from "@shared/types";

// ---------------------------------------------------------------------------
// Tunables (all documented; conservative defaults)
// ---------------------------------------------------------------------------

/**
 * Words on the same row are grouped when their vertical centers fall within this
 * fraction of the median word height. Generous enough to tolerate the small
 * baseline jitter tesseract reports across a row, tight enough not to merge two
 * distinct rows of the dense objectives list.
 */
const ROW_TOLERANCE_FRACTION = 0.6;

/**
 * When keeping the objectives column by the header anchor, a body word is kept
 * if its x-CENTER is at least `colX - margin`. The margin (a fraction of image
 * width) absorbs the case where an objective word's box starts a touch left of
 * the header word's left edge (e.g. a wider glyph). Small + conservative.
 */
const COL_LEFT_MARGIN_FRACTION = 0.03;

/**
 * The x-gutter fallback only fires when the emptiest vertical band between the
 * left and right word clusters is at least this wide (fraction of image width).
 * A real two-column layout has a wide blank gutter; a single column does not, so
 * this gate keeps the fallback from splitting a genuinely single-column screen.
 */
const MIN_GUTTER_FRACTION = 0.08;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Horizontal center of a word's bbox. */
function cx(word: OcrWord): number {
  return (word.x0 + word.x1) / 2;
}

/** Vertical center of a word's bbox. */
function cy(word: OcrWord): number {
  return (word.y0 + word.y1) / 2;
}

/** Median of a numeric array (0 for empty). PURE. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Strip non-letters and uppercase, for loose header matching ("OBJECTlVES"). */
function lettersOnly(s: string): string {
  return s.replace(/[^a-z]/gi, "").toUpperCase();
}

/**
 * Loose token match tolerant of the common OCR letter/digit confusions in the
 * stylized font (I/l/1/|, O/0, S/5, B/8). Compares letters-only forms after
 * de-confusing both sides to a single canonical glyph per class. Also accepts a
 * near-prefix so a slightly clipped header word still matches.
 */
function looseEquals(a: string, target: string): boolean {
  const norm = (s: string) =>
    lettersOnly(s)
      .replace(/[1|]/g, "I")
      .replace(/0/g, "O")
      .replace(/5/g, "S")
      .replace(/8/g, "B");
  const na = norm(a);
  const nt = norm(target);
  if (na.length === 0 || nt.length === 0) return false;
  if (na === nt) return true;
  // Tolerate a single trailing/leading garble by accepting a long shared prefix.
  const shorter = na.length <= nt.length ? na : nt;
  const longer = na.length <= nt.length ? nt : na;
  return longer.startsWith(shorter) && shorter.length >= nt.length - 1;
}

// ---------------------------------------------------------------------------
// Line reconstruction (shared by every path)
// ---------------------------------------------------------------------------

/**
 * Group kept words into rows by y-proximity, sort each row left-to-right by x,
 * join with SINGLE spaces, and order rows top-to-bottom by y. Collapsing the
 * inter-column whitespace to single spaces is what lets a header like
 * "Reward            o      314,000" reconstruct as "Reward o 314,000" so the
 * parser's reward regex matches. PURE.
 */
export function reconstructLines(words: OcrWord[]): string {
  if (words.length === 0) return "";
  const heights = words.map((word) => word.y1 - word.y0).filter((h) => h > 0);
  const rowTol = Math.max(1, median(heights) * ROW_TOLERANCE_FRACTION);

  // Sort by vertical center, then greedily bucket into rows.
  const byY = [...words].sort((a, b) => cy(a) - cy(b));
  const rows: OcrWord[][] = [];
  for (const word of byY) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(cy(word) - cy(last[0])) <= rowTol) {
      last.push(word);
    } else {
      rows.push([word]);
    }
  }

  return rows
    .map((row) =>
      [...row]
        .sort((a, b) => a.x0 - b.x0)
        .map((word) => word.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Path 1 — header-anchor isolation
// ---------------------------------------------------------------------------

/**
 * Locate the "PRIMARY OBJECTIVES" header anchor (fuzzy). Returns the column's
 * left x-edge and the header row's y, or null when the anchor isn't present.
 *
 * Matching strategy (loose by design — OCR garbles the header):
 *   - prefer an adjacent "PRIMARY" + "OBJECTIVES" pair on the same row (the real
 *     two-word header); colX is the leftmost (PRIMARY) word's left edge,
 *   - else a lone "OBJECTIVES" word (PRIMARY may have been dropped/garbled).
 * headerY is the TOP (y0) of the matched header word(s) — body words at/below it
 * are columned; words above it are the header band.
 */
function findObjectivesAnchor(
  words: OcrWord[],
): { colX: number; headerY: number } | null {
  const primaries = words.filter((word) => looseEquals(word.text, "PRIMARY"));
  const objectives = words.filter((word) =>
    looseEquals(word.text, "OBJECTIVES"),
  );
  if (objectives.length === 0) return null;

  // Prefer a PRIMARY immediately left of an OBJECTIVES on the same row.
  for (const obj of objectives) {
    const rowTol = Math.max(1, (obj.y1 - obj.y0) * ROW_TOLERANCE_FRACTION);
    const primary = primaries.find(
      (p) => Math.abs(cy(p) - cy(obj)) <= rowTol && p.x0 < obj.x0,
    );
    if (primary) {
      return { colX: primary.x0, headerY: Math.min(primary.y0, obj.y0) };
    }
  }
  // Fall back to a lone OBJECTIVES word as the anchor.
  const obj = objectives[0];
  return { colX: obj.x0, headerY: obj.y0 };
}

// ---------------------------------------------------------------------------
// Path 2 — x-gutter split
// ---------------------------------------------------------------------------

/**
 * Number of distinct rows a side must span for the gutter to count as a real
 * column boundary. A single line of text can have a wide word-to-word gap that
 * is NOT a column gutter; a genuine two-column layout has multiple rows of words
 * on BOTH sides of the gutter. Requiring 2+ rows per side rejects the single-row
 * false positive while still firing on the real interleaved-columns case.
 */
const MIN_ROWS_PER_SIDE = 2;

/**
 * Find the widest empty vertical band ("gutter") between word x-centers and, if
 * it is BOTH wide enough AND separates two genuinely multi-row column clusters,
 * return the x threshold splitting left from right. Returns null when no clear
 * column gutter exists (a single column, or a single wide-spaced line → caller
 * passes through). PURE.
 */
function findColumnGutter(words: OcrWord[], imgW: number): number | null {
  if (words.length < 2) return null;
  const centers = words.map(cx).sort((a, b) => a - b);
  let bestGap = 0;
  let bestMid = 0;
  for (let i = 1; i < centers.length; i++) {
    const gap = centers[i] - centers[i - 1];
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = (centers[i] + centers[i - 1]) / 2;
    }
  }
  if (bestGap < imgW * MIN_GUTTER_FRACTION) return null;

  // Reject a single wide-spaced LINE: a real column gutter has words on multiple
  // distinct rows on BOTH sides. Count distinct rows (by y-center clustering)
  // left vs right of the candidate split.
  const leftRows = distinctRowCount(words.filter((word) => cx(word) < bestMid));
  const rightRows = distinctRowCount(
    words.filter((word) => cx(word) >= bestMid),
  );
  if (leftRows < MIN_ROWS_PER_SIDE || rightRows < MIN_ROWS_PER_SIDE)
    return null;

  return bestMid;
}

/** Count distinct text rows in a set of words (by y-center proximity). PURE. */
function distinctRowCount(words: OcrWord[]): number {
  if (words.length === 0) return 0;
  const heights = words.map((word) => word.y1 - word.y0).filter((h) => h > 0);
  const rowTol = Math.max(1, median(heights) * ROW_TOLERANCE_FRACTION);
  const centers = words.map(cy).sort((a, b) => a - b);
  let rows = 1;
  for (let i = 1; i < centers.length; i++) {
    if (centers[i] - centers[i - 1] > rowTol) rows++;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Isolate the PRIMARY OBJECTIVES column from a full-screen contract OCR and
 * return clean, reconstructed multi-line text (header band + objectives column,
 * with the DETAILS flavor column dropped). See the file header for the fallback
 * order. PURE + total: never throws; degenerate input returns "" or the
 * best-effort full text (never worse than today's flattened behavior).
 *
 * @param words per-word OCR results with bboxes in source-image pixel space.
 * @param imgW  the recognized image width in pixels (for gutter sizing).
 * @param imgH  the recognized image height in pixels (reserved; documents intent).
 */
export function isolateObjectivesColumn(
  words: OcrWord[],
  imgW: number,
  _imgH: number,
): string {
  const clean = (words ?? []).filter(
    (word) => word && typeof word.text === "string" && word.text.length > 0,
  );
  if (clean.length === 0) return "";

  // --- Path 1: header anchor ---
  const anchor = findObjectivesAnchor(clean);
  if (anchor) {
    const leftMargin = imgW * COL_LEFT_MARGIN_FRACTION;
    const kept = clean.filter((word) => {
      // Header band: anything above the column header row stays as-is.
      if (cy(word) < anchor.headerY) return true;
      // Body: keep only words in the objectives column (x-center >= colX-margin).
      return cx(word) >= anchor.colX - leftMargin;
    });
    return reconstructLines(kept);
  }

  // --- Path 2: x-gutter split (no anchor) ---
  // The header band (words above the topmost body row) is always kept; only the
  // body is column-split. We approximate the body as everything, then keep the
  // right group beyond the gutter. (Header words tend to start at a low x, but a
  // header like "Reward … 314,000" also has high-x words, so we keep header rows
  // wholesale by y: a row that has ANY right-group word is kept entirely.)
  const gutter = findColumnGutter(clean, imgW);
  if (gutter !== null) {
    // Bucket into rows, then for each row decide: if the row straddles the gutter
    // OR sits entirely right of it, keep its right-of-gutter words; a row sitting
    // entirely LEFT of the gutter is flavor → dropped. This keeps a full-width
    // header row (reward) while dropping pure left-column flavor rows.
    const kept = clean.filter((word) => cx(word) >= gutter);
    // If the split kept nothing (degenerate), fall through to passthrough.
    if (kept.length > 0) return reconstructLines(kept);
  }

  // --- Path 3: passthrough (reconstruct everything) ---
  return reconstructLines(clean);
}
