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
//
// The REAL mobiGlas contract screen wraps objectives across MULTIPLE lines —
// mid-sentence AND mid-name — e.g. a destination "Melodic Fields Station" is
// split as "Melodic Fields" / "Station" on two lines, and a "… at Hurstons L4
// Lagrange point" qualifier trails on its own line. Anchoring patterns to a
// single line therefore drops or truncates objectives.
//
// STRATEGY: normalize the whole block to ONE continuous line first (newlines ->
// spaces, runs of whitespace collapsed) so wrapped names rejoin, then split the
// stream into objective spans on the verb keywords (Deliver / Collect / Pick up
// / Acquire) — the next keyword (or end of text) bounds the previous span. Each
// span is parsed independently, so OCR noise in one objective can't bleed into
// the next.
//
// The two real shapes we must handle (plus the older synthetic shapes the unit
// tests already exercise):
//   dropoff:  "Deliver <delivered>/<total> SCU of <COMMODITY> to <DEST> [at … Lagrange point]."
//   dropoff:  "Deliver <N> SCU of <COMMODITY> to <DEST>"                   (no fraction)
//   pickup:   "Collect <COMMODITY> from <LOCATION>."                       (no "SCU of")
//   pickup:   "Collect <N> SCU of <COMMODITY> from <LOCATION>"             (synthetic)
//
// For the SCU amount we take the DENOMINATOR of a "<delivered>/<total>" fraction
// (the contract total), falling back to a plain number when there's no slash.

/** The verb that opens an objective, with OCR/case tolerance. */
const VERB_RE = /\b(deliver|collect|pick\s*up|acquire)\b/gi;

// Amount token: an optional "<num>/<num>" fraction OR a plain number, followed by
// the (possibly OCR-garbled) "SCU of" unit+connective. The amount chars allow
// the usual digit-confusion letters; we de-confuse via parseOcrNumber after.
// Group 1 = numerator (when a fraction), group 2 = the number we keep (the
// denominator of a fraction, or the lone number otherwise).
//
// Two layers of optionality:
//   - the NUMBER inside the preamble is optional, so "Deliver -- SCU of …" (an
//     unreadable amount) still anchors on "SCU of" and yields a null scu;
//   - the WHOLE "<amount> SCU of" preamble is optional and falls back to a bare
//     "of", so a "Collect <commodity> from …" (the real pickup wording, no unit)
//     still matches with a null amount.
const NUM = "[0-9OoQlI|][0-9OoQlI|SsB.,]*";
// number?  SCU  of   (number optional; SCU + of required in this branch)
const SCU_WITH_UNIT = `(?:(${NUM})\\s*/\\s*)?(${NUM})?\\s*[5S]?cu\\b\\s*of\\s+`;
const SCU_PREAMBLE = `(?:${SCU_WITH_UNIT}|of\\s+)`;

// dropoff: <preamble?> <commodity> to <dest>
const DELIVER_BODY_RE = new RegExp(
  `^\\s*deliver\\b[^0-9a-z]*${SCU_PREAMBLE}(.+?)\\s+to\\s+(.+?)\\s*$`,
  "i",
);
// pickup WITH the "<n> SCU of" preamble (synthetic tests): Collect <n> SCU of <c> from <l>
const COLLECT_SCU_RE = new RegExp(
  `^\\s*(?:collect|pick\\s*up|acquire)\\b[^0-9a-z]*(?:(${NUM})\\s*/\\s*)?(${NUM})\\s*[5S]?cu\\b\\s*of\\s+(.+?)\\s+from\\s+(.+?)\\s*$`,
  "i",
);
// pickup WITHOUT the unit (the real wording): Collect <commodity> from <location>
const COLLECT_PLAIN_RE = new RegExp(
  `^\\s*(?:collect|pick\\s*up|acquire)\\b[^0-9a-z]*(.+?)\\s+from\\s+(.+?)\\s*$`,
  "i",
);

// Trailing non-objective section labels that may bleed into a destination span
// once the screen is flattened to one line (the objective span runs until the
// next objective VERB, so a final objective's dest can absorb the reward/box-size
// block that follows it). Cutting here bounds the destination to the place name.
const TRAILING_SECTION_RE =
  /\s+(?:max\s*box\s*size|box\s*size|container\s*size|reward|payout|contract\s*deadline|contracted|primary\s*objectives|deadline)\b.*$/i;

/**
 * Trim a destination/location span read after "to"/"from":
 *   - drop an " at … Lagrange point" qualifier (the fuzzy matcher keys off the
 *     station name, not the Lagrange suffix),
 *   - cut a trailing non-objective section label (Reward, Max Box Size, …) that
 *     bled in after line-flattening,
 *   - cut at a trailing period (the screen ends the sentence there),
 *   - strip a lone trailing stray OCR token (e.g. the spurious "j" after
 *     "Green Glade Station").
 * cleanOcrSpan handles the residual edge punctuation/whitespace.
 */
function trimDestination(raw: string): string {
  let s = raw;
  // Cut an " at … Lagrange point" qualifier (case-insensitive).
  s = s.replace(/\s+at\s+.*?lagrange\s+point.*$/i, "");
  // Cut a trailing non-objective section that flattened in after the place name.
  s = s.replace(TRAILING_SECTION_RE, "");
  // Cut at the first sentence-ending period (the screen ends a sentence there).
  const dot = s.indexOf(".");
  if (dot >= 0) s = s.slice(0, dot);
  s = cleanOcrSpan(s);
  // Strip a lone trailing stray single-letter token (OCR speckle), e.g. "… j".
  s = s.replace(/\s+[a-z]$/i, "");
  return cleanOcrSpan(s);
}

/**
 * Pick the kept SCU amount from a fraction's denominator (group `total`) or a
 * lone number. parseOcrNumber de-confuses OCR letter/digit swaps and strips
 * separators; returns null when nothing digit-like survives.
 */
function pickScu(total: string | undefined): number | null {
  return parseOcrNumber(total ?? "");
}

/**
 * Parse a single objective span (already verb-led, single-line) into an
 * OcrObjective, or null if it doesn't match any known shape.
 */
function parseObjectiveSpan(span: string): OcrObjective | null {
  // Dropoff first ("Deliver … to …").
  const d = DELIVER_BODY_RE.exec(span);
  if (d) {
    const commodity = cleanOcrSpan(d[3] ?? "");
    const location = trimDestination(d[4] ?? "");
    if (commodity.length === 0 && location.length === 0) return null;
    return { kind: "dropoff", scu: pickScu(d[2]), commodity, location };
  }
  // Pickup with explicit "<n> SCU of" (synthetic form).
  const cs = COLLECT_SCU_RE.exec(span);
  if (cs) {
    const commodity = cleanOcrSpan(cs[3] ?? "");
    const location = trimDestination(cs[4] ?? "");
    if (commodity.length === 0 && location.length === 0) return null;
    return { kind: "pickup", scu: pickScu(cs[2]), commodity, location };
  }
  // Pickup without the unit (the real "Collect <commodity> from <location>").
  const cp = COLLECT_PLAIN_RE.exec(span);
  if (cp) {
    const commodity = cleanOcrSpan(cp[1] ?? "");
    const location = trimDestination(cp[2] ?? "");
    if (commodity.length === 0 && location.length === 0) return null;
    return { kind: "pickup", scu: null, commodity, location };
  }
  return null;
}

/**
 * Pull every objective out of the OCR text. Normalizes the whole block to one
 * continuous line (rejoining names/sentences wrapped across lines), then splits
 * it into verb-led spans (the next verb keyword bounds the previous span) and
 * parses each span independently. Objectives with empty commodity AND location
 * after cleaning are dropped (pure noise). Order of appearance is preserved.
 */
function extractObjectives(text: string): OcrObjective[] {
  // Normalize first: collapse newlines + multiple spaces into single spaces so a
  // destination/commodity wrapped across lines rejoins ("Melodic Fields" +
  // "Station" -> "Melodic Fields Station").
  const flat = text.replace(/\s+/g, " ").trim();

  // Find every objective-verb start; the span runs to the next verb (or EOT).
  VERB_RE.lastIndex = 0;
  const starts: number[] = [];
  let vm: RegExpExecArray | null;
  while ((vm = VERB_RE.exec(flat)) !== null) {
    starts.push(vm.index);
    // Guard against a zero-width match looping forever.
    if (vm.index === VERB_RE.lastIndex) VERB_RE.lastIndex++;
  }

  const out: OcrObjective[] = [];
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : flat.length;
    const span = flat.slice(begin, end).trim();
    const obj = parseObjectiveSpan(span);
    if (obj) out.push(obj);
  }
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
// Label fallback. On the real screen the aUEC glyph OCRs as junk so there's no
// unit to anchor on — e.g. "Reward a 290,500" reads a stray "a" where the
// currency symbol was. We therefore tolerate a SHORT run of stray non-digit
// gap chars (whitespace, punctuation, 1-2 stray letters) between the label and
// the number, instead of just an optional colon/period. The gap is bounded
// ([^0-9\n]{0,6}) so it can't leap across unrelated text to a distant number.
const REWARD_LABEL_RE =
  /\b(?:reward|payout|pay)\b[^0-9\n]{0,6}?([0-9OoQlI|SsB.,]{2,})/gim;

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
