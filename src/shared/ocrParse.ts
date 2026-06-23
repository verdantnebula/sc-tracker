// ============================================================================
// ocrParse.ts — PURE parser for mobiGlas contract OCR text  (Phase F)
// ----------------------------------------------------------------------------
// EXPERIMENTAL. The companion feature is an opt-in OCR fallback: when the game
// suppresses the authoritative "New Objective" log line (the intermittent
// ObjectiveTokenDef bug), the user can OCR the mobiGlas contract screen to
// recover what the game wrote on-screen but not to Game.log.
//
// This module is the deterministic heart of that pipeline: it takes the RAW text
// tesseract.js produced from the captured frame and extracts contract fields by
// keyword/regex. It is PURE (string in, structured value out) so it is fully
// unit-testable on sanitized fixture strings — NO real screenshots, NO real
// Game.log, NO network. Everything downstream (fuzzy-matching against the
// reference, the review-before-apply dialog) consumes this output.
//
// DESIGN NOTE — defensive by construction. OCR on the stylized mobiGlas font is
// unproven and noisy. This parser therefore:
//   - never throws (garbage in -> empty result out),
//   - is tolerant of common OCR confusions (O/0, l/1/I, stray punctuation,
//     collapsed/expanded whitespace, lowercase "scu"/"auec"),
//   - extracts only what it is confident about and leaves the rest null, so the
//     review step shows blanks (which the user fills) rather than wrong guesses.
// It deliberately does NOT decide a final commodity/location — that is the fuzzy
// matcher's job ([[ocrMatch]]) — it returns the raw spans it read.
// ============================================================================

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** One delivery/collection objective read off the contract screen. */
export interface OcrObjective {
  /** 'dropoff' for "Deliver … to …", 'pickup' for "Collect … from …". */
  kind: "pickup" | "dropoff";
  /** SCU amount, or null when the number was unreadable. */
  scu: number | null;
  /** Raw commodity span as read (un-normalized — feed to the fuzzy matcher). */
  commodity: string;
  /** Raw location span as read (un-normalized — feed to the fuzzy matcher). */
  location: string;
}

/** Structured fields recovered from one contract's OCR text. */
export interface OcrContract {
  objectives: OcrObjective[];
  /** Full contract reward in aUEC, or null when not found / unreadable. */
  reward: number | null;
  /** Max container/box size in SCU if the screen showed it, else null. */
  boxSize: number | null;
}

// ---------------------------------------------------------------------------
// Low-level cleanup helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Parse a numeric token that OCR may have mangled. Handles thousands separators
 * (",", ".", or a stray space), and the classic letter/digit confusions inside
 * an otherwise-numeric run (O->0, o->0, l/I->1, S->5, B->8). Returns null when
 * nothing digit-like survives. We only de-confuse a token we already believe is
 * numeric (called on the captured number span), so we don't corrupt words.
 */
export function parseOcrNumber(token: string): number | null {
  if (typeof token !== "string") return null;
  const deconfused = token
    .replace(/[OoQ]/g, "0")
    .replace(/[lI|]/g, "1")
    .replace(/[Ss]/g, "5")
    .replace(/B/g, "8");
  // Keep only digits (drop thousands separators / spaces / currency cruft).
  const digits = deconfused.replace(/[^0-9]/g, "");
  if (digits.length === 0) return null;
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a free-text span (commodity or location) read by OCR: collapse
 * runs of whitespace, trim, and strip trailing punctuation/line noise that the
 * OCR commonly appends. Preserves inner spacing so multi-word names survive.
 */
export function cleanOcrSpan(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:|<>·•*\-—]+/, "")
    .replace(/[\s.,;:|<>·•*\-—]+$/, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Objective extraction
// ---------------------------------------------------------------------------

// "Deliver <N> SCU of <commodity> to <location>"  (dropoff)
// "Collect <N> SCU of <commodity> from <location>" (pickup)
// Tolerances baked in:
//   - leading verb may be OCR'd with case noise; we match case-insensitively.
//   - "SCU" may read as "scu"/"5CU"/"SCU." — we accept a fuzzy unit token.
//   - the number span is captured loosely then run through parseOcrNumber.
//   - "of" / "to" / "from" connective words may have stray casing.
// The commodity span is non-greedy up to the connective; the location span runs
// to end-of-line. Each is post-cleaned with cleanOcrSpan.
// The amount span (group 1) MUST start with a digit or a strong digit-confusion
// char ([0-9OoQlI|]) — never with S/B — so the leading "S"/"5" of the "SCU" unit
// can't be mis-read as the amount. The whole amount span is OPTIONAL, so a line
// whose number was unreadable (e.g. "Deliver -- SCU of …") still matches with a
// null amount instead of dropping the objective entirely. The unit token is
// "[5S]?cu" so it absorbs an OCR'd "5CU"/"SCU".
// Continuation chars after the first are LAZY (`*?`) and the unit is separated
// by mandatory whitespace, so the amount can't greedily swallow the leading
// "S" of "SCU". Thousands separators inside the number ("12,5OO") still match
// because they precede the whitespace+unit.
const AMOUNT = "([0-9OoQlI|][0-9OoQlI|SsB.,]*?)?";
const DELIVER_RE = new RegExp(
  `\\bdeliver\\b[^0-9a-z]*${AMOUNT}\\s*[5S]?cu\\b\\s*of\\s+(.+?)\\s+to\\s+(.+?)\\s*$`,
  "gim",
);
const COLLECT_RE = new RegExp(
  `\\b(?:collect|pick\\s*up|acquire)\\b[^0-9a-z]*${AMOUNT}\\s*[5S]?cu\\b\\s*of\\s+(.+?)\\s+from\\s+(.+?)\\s*$`,
  "gim",
);

/**
 * Pull every objective line out of the OCR text. Runs both the deliver and
 * collect patterns line-by-line (the `m` flag anchors `$` per line). Objectives
 * with an empty commodity AND empty location after cleaning are dropped (pure
 * noise). Order of appearance is preserved.
 */
function extractObjectives(text: string): OcrObjective[] {
  const out: OcrObjective[] = [];
  const push = (kind: OcrObjective["kind"], re: RegExp): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const scu = parseOcrNumber(m[1] ?? "");
      const commodity = cleanOcrSpan(m[2] ?? "");
      const location = cleanOcrSpan(m[3] ?? "");
      if (commodity.length === 0 && location.length === 0) continue;
      out.push({ kind, scu, commodity, location });
    }
  };
  push("dropoff", DELIVER_RE);
  push("pickup", COLLECT_RE);
  return out;
}

// ---------------------------------------------------------------------------
// Reward extraction
// ---------------------------------------------------------------------------

// Reward line on the contract screen, e.g. "Reward 45,000 aUEC" / "Payout: 45000 aUEC".
// We anchor on the currency unit "aUEC" (tolerant of case + the leading 'a'
// being dropped/garbled) and read the number immediately before it. We also
// accept a "Reward"/"Payout" label preceding a number when the unit is missing.
const REWARD_UNIT_RE = /([0-9OoQlI|SsB.,\s]{2,})\s*a?[\s.]*uec\b/gim;
const REWARD_LABEL_RE =
  /\b(?:reward|payout|pay)\b\s*[:.\-]?\s*([0-9OoQlI|SsB.,]{2,})/gim;

/**
 * Find the contract reward. Prefers the strongest signal: a number directly
 * adjacent to an "aUEC" unit. Falls back to a number following a Reward/Payout
 * label. When several "aUEC" figures appear, the LARGEST is taken as the
 * contract reward (sub-rewards/fees are smaller) — a defensive heuristic, and
 * the user confirms it in the review step regardless.
 */
function extractReward(text: string): number | null {
  const candidates: number[] = [];
  REWARD_UNIT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REWARD_UNIT_RE.exec(text)) !== null) {
    const n = parseOcrNumber(m[1] ?? "");
    if (n !== null && n > 0) candidates.push(n);
  }
  if (candidates.length > 0) return Math.max(...candidates);

  REWARD_LABEL_RE.lastIndex = 0;
  while ((m = REWARD_LABEL_RE.exec(text)) !== null) {
    const n = parseOcrNumber(m[1] ?? "");
    if (n !== null && n > 0) candidates.push(n);
  }
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

// ---------------------------------------------------------------------------
// Box / container size extraction
// ---------------------------------------------------------------------------

// Optional "Max Box Size 1 SCU" / "Container size: 4 SCU" line. Captures the
// number adjacent to a box/container keyword. Distinct from objective SCU.
const BOX_SIZE_RE =
  /\b(?:max\s*)?(?:box|container|crate)\s*(?:size)?\s*[:.\-]?\s*([0-9OoQlI|SsB]{1,3})\s*[5S]?cu\b/gim;

/** Find the max box/container size in SCU if the screen showed it. */
function extractBoxSize(text: string): number | null {
  BOX_SIZE_RE.lastIndex = 0;
  const m = BOX_SIZE_RE.exec(text);
  if (!m) return null;
  return parseOcrNumber(m[1] ?? "");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse raw OCR text from a mobiGlas contract screen into structured fields.
 * PURE + total: any input (including "" or non-string) yields a well-formed
 * empty result rather than throwing. The caller (review dialog) fuzzy-matches
 * the commodity/location spans against the bundled reference and lets the user
 * confirm/correct every field before anything is written to a mission.
 */
export function parseContractOcr(text: unknown): OcrContract {
  if (typeof text !== "string" || text.length === 0) {
    return { objectives: [], reward: null, boxSize: null };
  }
  return {
    objectives: extractObjectives(text),
    reward: extractReward(text),
    boxSize: extractBoxSize(text),
  };
}
