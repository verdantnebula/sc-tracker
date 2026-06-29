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
  /**
   * The contract TITLE read from the header band (above DETAILS / PRIMARY
   * OBJECTIVES), cleaned of trailing tags like "[BP]*" and OCR noise, or null
   * when no cargo-haul-style title line was found. Used to pre-select the target
   * mission in the review dialog (see [[ocrMatch]] matchTitleToMissions).
   */
  title: string | null;
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
 * Soft ceiling for a SINGLE delivery/collection leg's SCU. An amount above this
 * is treated as OCR corruption — two figures merged or a misread "X/Y" fraction
 * slash (the observed field bugs were 2318, 2992, 7106).
 *
 * EXCEEDING THIS IS NOT DATA LOSS. An over-ceiling amount is NULLED (clampScu),
 * which routes the objective to REVIEW: with the C1 store guard, a null SCU is
 * never written as a real 0-SCU cargo leg — it becomes a fillable "amount
 * unknown" placeholder (and is reported via the diagnostics capture sink) so the
 * user can correct it. So the cost of the ceiling being a touch LOW is only an
 * extra review prompt, never a silently corrupted/dropped value. That makes 696
 * a safe conservative default rather than a hard data boundary.
 *
 * 696 sits comfortably above any legitimate single-leg amount seen so far while
 * still rejecting every observed corruption. It has no sourced basis yet.
 * TODO: derive the real per-leg max from actual contract data (UEX / log corpus)
 * and raise this to that empirical ceiling; do NOT raise it arbitrarily, since a
 * too-HIGH ceiling lets a genuine merged-figure corruption slip through as a
 * plausible large value (the failure the ceiling exists to catch).
 */
export const MAX_OBJECTIVE_SCU = 696;

/**
 * The DIGIT-lookalike glyphs OCR may produce for the "/" fraction divider in an
 * "X/Y" SCU amount. On the stylized font the slash frequently reads as 7, 1, |,
 * l, or I — which silently merges "0/106" into "07106" (then 7106). These are
 * AMBIGUOUS dividers: unlike a literal "/", a "7" between two digit runs could
 * genuinely be part of the number, so recovery using one of these is only
 * trusted when the split is otherwise unambiguous (see recoverMergedFraction).
 * The literal "/" is intentionally NOT in this class — it gets the unconditional
 * path because a "/" can never be a real digit.
 */
const SLASH_DIGIT_LOOKALIKE = "[71|lI]";

/**
 * Resolve the SCU amount for an objective from the matched amount groups.
 *
 * Order of preference:
 *   1. An EXPLICIT fraction "<num>/<total>" — keep the TOTAL (denominator); the
 *      done-count numerator is irrelevant to the contract size.
 *   2. A lone number — but first try to recover a fraction whose "/" OCR'd as a
 *      digit-lookalike glyph and merged the two figures (e.g. "07106" -> 0-of-106
 *      -> 106). The recovery only fires on a leading "0" (a fresh contract's
 *      done-count) so it can't mangle a genuine 3-digit amount.
 *
 * Any resolved amount that is non-positive (`<= 0`) OR above
 * {@link MAX_OBJECTIVE_SCU} is rejected (returns null) — see {@link clampScu}.
 * A resolved 0 means the amount was unreadable/corrupt, not real 0 cargo; both
 * collapse to null and route the objective to a fillable placeholder for review,
 * never written as real cargo. This is why the contract is "positive number or
 * null, never a literal 0".
 */
function pickScu(total: string | undefined, lone?: string): number | null {
  // 1. Explicit fraction captured by the regex: the total IS the denominator.
  const fromTotal = parseOcrNumber(total ?? "");
  if (fromTotal !== null) return clampScu(fromTotal);

  // 2. A lone number. First attempt to un-merge a lookalike-slash fraction.
  const raw = lone ?? "";
  const recovered = recoverMergedFraction(raw);
  const n = recovered ?? parseOcrNumber(raw);
  return clampScu(n);
}

/** A denominator the lookalike path will trust: 3+ digits with NO leading zero.
 *  The leading char excludes the zero-equivalent OCR confusions (O/o/Q -> 0) so
 *  a leading-zero denominator (implausible for a real total) is rejected; l/I/| ->1,
 *  S/s ->5, B ->8 are non-zero and allowed. Length 3+ matches the real favorable
 *  case "07106" -> "106" while rejecting the ambiguous 2-digit merges (16/96/06).
 *  (See recoverMergedFraction for the full rationale.) */
const PLAUSIBLE_DENOM_RE = /^[1-9lI|SsB][0-9OoQlI|SsB.,]{2,}$/;

/**
 * If a lone amount token is actually a "0<divider><total>" fraction (a fresh
 * contract's "0 of N" done-count) whose slash OCR'd into the token, return the
 * denominator; otherwise null. Anchored on a leading "0" done-count so a genuine
 * amount (e.g. "106") is never reinterpreted.
 *
 * Two divider cases, deliberately split because they differ in ambiguity:
 *
 *   A. LITERAL "/" — unambiguous (a "/" can't be a real digit). Recover the
 *      denominator whatever its length: "0/46" -> 46, "0/696" -> 696.
 *
 *   B. DIGIT-LOOKALIKE divider (7/1/|/l/I) — AMBIGUOUS, because the glyph could
 *      genuinely be a digit of the number. We only recover when the split is
 *      unambiguous: a single leading "0", then the lookalike divider, then a
 *      PLAUSIBLE denominator (3+ digits, no leading zero). This keeps the real
 *      favorable case ("07106" -> 0/106 -> 106) while REFUSING to emit a
 *      confident-but-wrong SMALL value for realistic merges:
 *          "0106" (-> would be 06/6), "0716" (-> 16), "0796" (-> 96)
 *      all fail the plausible-denominator gate and return null, so they are
 *      routed to review by the SCU ceiling/placeholder path instead of being
 *      silently mis-recovered into a tiny wrong number.
 */
function recoverMergedFraction(token: string): number | null {
  // A. Literal slash: unambiguous split, any denominator length.
  const slash = /^0\s*\/\s*([0-9OoQlI|SsB.,]+)$/.exec(token);
  if (slash) return parseOcrNumber(slash[1] ?? "");

  // B. Digit-lookalike divider: only when the denominator is plausible (3+
  //    digits, no leading zero), otherwise the split is a guess -> null.
  const look = new RegExp(
    `^0\\s*${SLASH_DIGIT_LOOKALIKE}\\s*([0-9OoQlI|SsB.,]+)$`,
  ).exec(token);
  if (!look) return null;
  const denom = look[1] ?? "";
  if (!PLAUSIBLE_DENOM_RE.test(denom)) return null;
  return parseOcrNumber(denom);
}

/**
 * Resolve a candidate SCU to either a POSITIVE in-range amount or null. This is
 * the single site that enforces the parser's contract: it emits a positive
 * number or null, NEVER a literal 0 (or any non-positive value).
 *
 *   - A resolved `<= 0` collapses to null. A delivery/collection objective is
 *     never legitimately 0 SCU — realistic OCR corruptions resolve to 0 ("0"
 *     amounts, the letter "O" misread as 0, "0/0", or a 0/zero-lookalike-denom
 *     fraction). Treating 0 as a known value would let a corrupt amount be
 *     written + LOCKED as user-confirmed real cargo, so 0 means unknown -> null.
 *   - A resolved `> MAX_OBJECTIVE_SCU` collapses to null (the merged-figure guard).
 *
 * BOTH null outcomes route the objective to a fillable "amount unknown"
 * placeholder for review (and the diagnostics sink) — never written as real
 * cargo. (See the C1 guard in electron/missionStore.ts.)
 */
function clampScu(n: number | null): number | null {
  if (n === null) return null;
  if (n <= 0) return null;
  if (n > MAX_OBJECTIVE_SCU) return null;
  return n;
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
// The fraction divider here is the LITERAL "/" only. A fraction whose slash
// OCR'd as a digit-lookalike (and so merged into a single token, e.g. "07106")
// is NOT split here — that is recovered downstream by recoverMergedFraction,
// which anchors on a leading "0" so it can't mis-split a genuine merged number
// like "2318" (which must instead be REJECTED by the SCU ceiling). Group 1 =
// numerator (when a fraction), group 2 = the kept number (the denominator of a
// fraction, or a lone number otherwise).
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

// Prose lead-ins that the DETAILS column bleeds into a location span on a
// full-screen capture (Bug 1b). These tokens cannot legitimately be part of a
// station name, so cutting at the FIRST occurrence bounds the destination to the
// place name while leaving real multi-word names ("Thundering Express Station",
// "Green Glade Station") intact. CONSERVATIVE by design — every token here is a
// sentence connective/verb or a flavor noun the contract DETAILS text uses, not
// a station-name word. Anchored on a leading space so it only fires mid-span.
//   " are looking …", " is …", " has been …", " Freight elevator …",
//   " The refinery …", " We …", " They …"
const LOCATION_FLAVOR_RE =
  /\s+(?:are\s+looking|is\s|has\s+been|freight\s+elevator|the\s+refinery|we\s|they\s).*$/i;

// DEST_PROSE — words that NEVER appear inside a Star Citizen station/location
// name but DO appear in the DETAILS-column flavor text that bleeds into the span
// on a full-screen capture (Bug #57). When one of these words is seen, the
// location is truncated at (i.e. before) it. Anchored on a leading space so the
// word must be its OWN token — this can't fire on a substring inside a real name.
// Every entry is a connective/verb/flavor noun from the contract prose, NOT a
// place-name component. "refinery" is intentionally NOT here (a real station can
// be a refinery — e.g. "ARC-L1 ... Refinery"); the leading-"The refinery" prose
// is handled separately by LOCATION_FLAVOR_RE.
const DEST_PROSE_RE =
  /\s+(?:seems|please|contractors?|waiting|looking|processed|process|above|contact|need|needs|require|requires|delivery|shipment|containers?|elevator|crew|ready|busy|today)\b.*$/i;

// OPENING-LETTER / GREETING flavor words. The contract DETAILS letter opens with
// a salutation ("Hey, the folks at Everus Harbor …") that bleeds into a
// destination span when the station-name capture is truncated mid-name on a
// full-screen OCR (the observed "Thundering Express The folks …" garble). These
// greeting/letter-prose tokens NEVER appear inside a station name, so the
// destination is truncated at (before) the first one. Anchored on a leading
// space so each must be its OWN token — can't fire on a substring inside a real
// name. Distinct from DEST_PROSE_RE only for clarity of intent (letter opener vs
// mid-sentence prose); both are applied in trimDestination.
const DEST_GREETING_RE =
  /\s+(?:hey|hi|hello|greetings|dear|folks|the\s+folks|good\s+(?:day|morning|evening)|expect|expecting|thanks|thank\s+you|regards|cheers|sincerely)\b.*$/i;

// Station-type suffix words that legitimately END a location name. We anchor the
// destination to the LAST such suffix (keeping an optional trailing pad/dock code
// like "S4DC05") and cut any prose that follows it. This catches bleed that
// slips past the blocklist while preserving the full real name + its pad code.
// "point" is included (e.g. "Baijini Point") but the " at … Lagrange point"
// qualifier is already removed upstream, so it can't mis-anchor here.
// Only words that genuinely TERMINATE a station name. "Port"/"Harbor" are
// excluded deliberately — in SC they typically START a name ("Port Tressler",
// "Everus Harbor"), so anchoring on them would truncate the name; their bleed is
// handled by the prose/period cuts instead.
const STATION_SUFFIX =
  "station|outpost|depot|hub|gateway|refinery|spaceport|center|centre|point";
// A trailing pad/dock code after the station-type word (e.g. "S4DC05"): an
// alphanumeric token that CONTAINS A DIGIT. Requiring a digit means a following
// lowercase prose word ("and", "the", "seems") is NOT mistaken for a pad code
// and is dropped instead of kept.
const PAD_CODE = "[A-Za-z0-9-]*[0-9][A-Za-z0-9-]*";
// Greedy ".*" so we anchor to the LAST station-suffix word in the span (e.g. in
// "Everus Harbor Station S4DC05 …" we anchor "Station", not the earlier
// "Harbor"), then keep one optional trailing pad/dock code and drop the rest.
const STATION_ANCHOR_RE = new RegExp(
  `^(.*\\b(?:${STATION_SUFFIX})\\b(?:\\s+${PAD_CODE})?)(?:\\s+.+)?$`,
  "i",
);

/**
 * Remove Lagrange-qualifier RESIDUE wherever it appears in a destination span,
 * not just when it trails. The qualifier is "<station> at <body>('s) LN Lagrange
 * point" — but OCR line-wrap + row reconstruction can INTERLEAVE its words into
 * the middle of the station name, e.g. "Thundering Lagrange point Express
 * Station" (the "Lagrange point" tokens landed between "Thundering" and "Express
 * Station"). The trailing " at … Lagrange point" cut alone can't fix that, so we
 * also scrub the order-independent residue tokens:
 *   - a stray "at <body>('s) LN" fragment (the qualifier's lead-in, body + LN
 *     code) appearing anywhere,
 *   - a standalone "Lagrange point" / "Lagrange" token anywhere.
 * We deliberately do NOT strip a bare "point" (no preceding "Lagrange"): "point"
 * legitimately ENDS a station name ("Baijini Point"), so removing it blindly
 * would corrupt real names. After scrubbing, the leftover words rejoin in their
 * captured order ("Thundering Express Station"), which the fuzzy matcher then
 * snaps to the reference "HUR-LN <Station>" — the SAME shape the clean path
 * produces. PURE; order-independent by construction (defense in depth, since OCR
 * word order is unreliable). cleanOcrSpan collapses the residual whitespace.
 */
function stripLagrangeResidue(s: string): string {
  let out = s;
  // 1. A stray "at <body>('s) L<N>" qualifier lead-in anywhere (body is 1-2 word
  //    tokens like "Hurston" / "Hurston's" / "Crusader"; LN is L1..L5, OCR digit
  //    confusions tolerated). Stops BEFORE consuming following station-name words.
  out = out.replace(/\bat\s+[A-Za-z]+(?:'s|s)?\s+L[0-9OoQlI|]\b/gi, " ");
  // 2. A standalone "Lagrange point" pair, or a lone "Lagrange", anywhere.
  out = out.replace(/\blagrange\s+point\b/gi, " ");
  out = out.replace(/\blagrange\b/gi, " ");
  // 3. A lone "at <body>('s)" lead-in left behind once "Lagrange point" is gone
  //    (e.g. interleave dropped the LN code): "at Hurston's" with nothing after.
  out = out.replace(/\bat\s+[A-Za-z]+(?:'s|s)?\s*$/gi, " ");
  return out.replace(/\s+/g, " ").trim();
}

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
  // Cut an " at … Lagrange point" qualifier (case-insensitive). Fast path for the
  // IN-ORDER capture where the qualifier trails the station name as written.
  s = s.replace(/\s+at\s+.*?lagrange\s+point.*$/i, "");
  // Scrub Lagrange-qualifier RESIDUE that the trailing cut can't reach because
  // OCR line-wrap interleaved its words INTO the station name (e.g. "Thundering
  // Lagrange point Express Station"). Order-independent — see
  // stripLagrangeResidue. Done early so the surviving station words rejoin before
  // the station-suffix anchor runs below.
  s = stripLagrangeResidue(s);
  // Cut at an opening-letter / greeting flavor word ("Hey", "the folks", …) that
  // the DETAILS letter bled into a truncated destination span. Done BEFORE the
  // period cut because the bled greeting may carry no period (e.g. "Thundering
  // Express The folks at Everus Harbor"). The remaining "<station-prefix>" then
  // snaps to its full reference name via the containment-aware fuzzy matcher.
  s = s.replace(DEST_GREETING_RE, "");
  // Cut a trailing " above <body>" qualifier — the station name precedes the
  // " above " token (e.g. "Everus Harbor above Hurston" -> "Everus Harbor";
  // "Everus Harbor above j The refinery …" -> "Everus Harbor"). Cut at the FIRST
  // case-insensitive " above " so any bleed after it (orbital body + DETAILS
  // prose) is dropped together. A real station name doesn't contain " above ".
  s = s.replace(/\s+above\s+.*$/i, "");
  // Cut a trailing non-objective section that flattened in after the place name.
  s = s.replace(TRAILING_SECTION_RE, "");
  // Cut a prose lead-in the DETAILS column bled into the location (Bug 1b).
  s = s.replace(LOCATION_FLAVOR_RE, "");
  // Cut at a blocklisted prose word that can't be part of a station name (#57).
  s = s.replace(DEST_PROSE_RE, "");
  // "No second preposition": the location began after the first to/from, so a
  // further " to "/" from " is prose that bled in — drop it and the tail (#57).
  s = s.replace(/\s+(?:to|from)\s+.*$/i, "");
  // Cut at the first sentence-ending period (the screen ends a sentence there).
  const dot = s.indexOf(".");
  if (dot >= 0) s = s.slice(0, dot);
  s = cleanOcrSpan(s);
  // Strip a lone trailing stray single-letter token (OCR speckle), e.g. "… j".
  s = s.replace(/\s+[a-z]$/i, "");
  s = cleanOcrSpan(s);
  // Final tightening: anchor to a station-type suffix (keeping a trailing pad
  // code) and drop any prose that slipped past the cuts above (#57). Only applies
  // when a suffix is present, so suffix-less names (e.g. "CRU-L4 Shallow Fields")
  // pass through untouched.
  const anchored = STATION_ANCHOR_RE.exec(s);
  if (anchored) s = anchored[1];
  return cleanOcrSpan(s);
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
    // Group 1 set => explicit fraction, so group 2 is the denominator (total);
    // otherwise group 2 is a lone number (which pickScu may un-merge).
    const scu = d[1] ? pickScu(d[2]) : pickScu(undefined, d[2]);
    return { kind: "dropoff", scu, commodity, location };
  }
  // Pickup with explicit "<n> SCU of" (synthetic form).
  const cs = COLLECT_SCU_RE.exec(span);
  if (cs) {
    const commodity = cleanOcrSpan(cs[3] ?? "");
    const location = trimDestination(cs[4] ?? "");
    if (commodity.length === 0 && location.length === 0) return null;
    const scu = cs[1] ? pickScu(cs[2]) : pickScu(undefined, cs[2]);
    return { kind: "pickup", scu, commodity, location };
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
 *
 * The real mobiGlas PRIMARY OBJECTIVES column is a set of explicit per-line
 * "Deliver N SCU of <commodity> to <dest>" / "Collect <commodity> from <loc>"
 * objectives — each is its own leg. The standard verb-span parser handles every
 * one of these directly; there is deliberately NO special "any order" pre-pass
 * (an earlier heuristic that collapsed N explicit delivers into one Deliver +
 * an ANY-ORDER station list modeled an OCR MISREAD and could misfire, so it was
 * removed). Each Deliver/Collect line yields exactly one objective.
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
// The captured number also absorbs SPACE-grouped thousands ("191 500") via the
// trailing "(?:\s\d{3})*", so a space-separated reward isn't truncated to its
// first group (the comma/period separators are already inside the char class).
const REWARD_LABEL_RE =
  /\b(?:reward|payout|pay)\b[^0-9\n]{0,6}?([0-9OoQlI|SsB.,]{2,}(?:\s\d{3})*)/gim;

// LAST-RESORT money-shape fallback (Item 3). When BOTH the unit-anchored and the
// label-anchored paths find nothing — e.g. the "Reward" label OCR'd as "Rewarc"
// AND the aUEC glyph read as junk so there's no unit to anchor on — we scan for
// the largest "money-shaped" figure on the screen. A reward figure looks like a
// grouped thousands number (345,500 / 191.500 / 191 500) OR a bare run of 5+
// digits; we take the LARGEST such figure (the contract reward dwarfs any small
// stray number). This is GATED to fire only when the primary paths are empty, and
// it EXCLUDES SCU amounts (n/total fractions and any number adjacent to "SCU"),
// which are the only other big numbers on a contract screen. It feeds the
// review-before-apply UI, so a wrong guess is correctable — but the exclusions +
// the gate keep false positives low.
//
// A grouped-thousands figure: 1-3 digits, then 1+ groups of <sep><exactly 3
// digits>, where <sep> is comma/period/space. This anchors on the 3-digit
// grouping so a lone "2400" (no grouping, <5 digits) is NOT money-shaped.
const MONEY_GROUPED_RE = /\b(\d{1,3}(?:[.,  ]\d{3})+)/g;
// A bare run of 5+ digits (e.g. "290500" with no separators).
const MONEY_BARE_RE = /\b(\d{5,})\b/g;
// An SCU amount we must NOT treat as a reward: an "n/total" fraction, or any
// number immediately followed by (optional space then) an "SCU" unit. Used to
// blank out SCU figures from the text BEFORE the money-shape scan so they can't
// be mis-grabbed. "[5S]cu" mirrors the parser's tolerance for the "5CU" misread.
const SCU_AMOUNT_RE = /\b\d[\d.,/ ]*\s*[5S]?cu\b/gi;
const SCU_FRACTION_RE = /\b\d[\d.,]*\s*\/\s*\d[\d.,]*\b/g;

/**
 * Last-resort: find the largest money-shaped figure after masking out SCU
 * amounts/fractions. Returns null when nothing money-shaped remains. PURE.
 */
function recoverRewardFallback(text: string): number | null {
  // Mask SCU amounts + fractions to spaces so the money scan can't see them.
  const masked = text
    .replace(SCU_FRACTION_RE, (s) => " ".repeat(s.length))
    .replace(SCU_AMOUNT_RE, (s) => " ".repeat(s.length));

  const candidates: number[] = [];
  let m: RegExpExecArray | null;
  MONEY_GROUPED_RE.lastIndex = 0;
  while ((m = MONEY_GROUPED_RE.exec(masked)) !== null) {
    const n = parseOcrNumber(m[1] ?? "");
    if (n !== null && n > 0) candidates.push(n);
  }
  MONEY_BARE_RE.lastIndex = 0;
  while ((m = MONEY_BARE_RE.exec(masked)) !== null) {
    const n = parseOcrNumber(m[1] ?? "");
    if (n !== null && n > 0) candidates.push(n);
  }
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/**
 * Find the contract reward. Prefers the strongest signal: a number directly
 * adjacent to an "aUEC" unit. Falls back to a number following a Reward/Payout
 * label. As a LAST RESORT — only when BOTH of those find nothing — scans for the
 * largest money-shaped figure (excluding SCU amounts) via
 * {@link recoverRewardFallback}. When several "aUEC" figures appear, the LARGEST
 * is taken as the contract reward (sub-rewards/fees are smaller) — a defensive
 * heuristic, and the user confirms it in the review step regardless.
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
  if (candidates.length > 0) return Math.max(...candidates);

  // Both primary paths empty -> last-resort money-shape scan (gated here).
  return recoverRewardFallback(text);
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
// Title extraction (the contract name in the header band)
// ---------------------------------------------------------------------------
//
// The contract TITLE sits in the HEADER band — above the DETAILS / PRIMARY
// OBJECTIVES columns — and is a cargo-hauling-style name, e.g.
//   "Senior | Medium Haul | from MIC-L2 Long Forest Station [BP]*"
// It is identified structurally (NOT by position) by the shape every haul title
// shares: it mentions hauling ("Haul"/"Hauling"/"Cargo") and/or uses the "| … |"
// pipe separators AND a "from <location>" clause. We deliberately do NOT pick the
// first non-empty line (that's "Reward …") nor a flavor/section line.

/**
 * A line is a candidate contract title when it has the haul-title SHAPE. We
 * require BOTH a hauling signal (the "Haul"/"Hauling"/"Cargo" keyword OR the
 * "| … |" pipe-separated layout) AND a "from <…>" origin clause, since the real
 * titles read "… Haul | from <station>". This rejects "Reward 314,000",
 * "Contracted By …", "PRIMARY OBJECTIVES", "Contract Deadline …" and the
 * Deliver/Collect objective lines, none of which carry a "from" origin in the
 * header. Case-insensitive.
 */
function looksLikeContractTitle(line: string): boolean {
  if (!/\bfrom\b/i.test(line)) return false;
  // A Deliver/Collect objective line ("Collect Quartz from …") also has "from",
  // so explicitly reject lines that start with an objective verb.
  if (/^\s*(?:deliver|collect|pick\s*up|acquire)\b/i.test(line)) return false;
  const hasHaulKeyword = /\bhaul(?:ing)?\b|\bcargo\b/i.test(line);
  const hasPipes = (line.match(/\|/g) ?? []).length >= 1;
  return hasHaulKeyword || hasPipes;
}

/**
 * Clean a raw title span: strip trailing tags like "[BP]*" / "[XYZ]", collapse
 * OCR whitespace, and trim edge noise — while PRESERVING the "|" separators and
 * inner spacing that are part of the real title. Pipes are normalized to a single
 * " | " with single spaces around them so OCR spacing jitter doesn't vary the
 * output. Reusable by any future title consumer.
 */
export function cleanContractTitle(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  // Strip trailing bracketed tags + any trailing "*" decoration (e.g. "[BP]*").
  // Applied repeatedly so "… [BP] [X]*" all peel off; anchored to end-of-string.
  s = s.replace(/(?:\s*\[[^\]]*\]\s*\*?\s*)+$/g, "").trim();
  s = s.replace(/\*+$/g, "").trim();
  // Normalize the pipe separators to a consistent " | " (collapse OCR spacing).
  s = s.replace(/\s*\|\s*/g, " | ").trim();
  // Trim residual edge punctuation/noise (keep inner pipes + word chars).
  s = s.replace(/^[\s.,;:<>·•\-—]+/, "").replace(/[\s.,;:<>·•\-—]+$/, "");
  return s.trim();
}

/**
 * Find the contract title in the OCR text: scan line-by-line for the FIRST line
 * with the haul-title shape ({@link looksLikeContractTitle}), cleaned via
 * {@link cleanContractTitle}. Returns null when no such line is present (so the
 * dialog shows no read title rather than a wrong guess). PURE.
 *
 * Operates on the ORIGINAL line-preserving text (titles are one screen line; a
 * flattened stream could merge the title with an adjacent line).
 */
function extractTitle(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (looksLikeContractTitle(line)) {
      const cleaned = cleanContractTitle(line);
      if (cleaned.length > 0) return cleaned;
    }
  }
  return null;
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
    return { objectives: [], reward: null, boxSize: null, title: null };
  }
  return {
    objectives: extractObjectives(text),
    reward: extractReward(text),
    boxSize: extractBoxSize(text),
    title: extractTitle(text),
  };
}
