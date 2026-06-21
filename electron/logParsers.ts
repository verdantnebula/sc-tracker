// ============================================================================
// logParsers.ts — PURE line -> domain event parsing  (SPEC §4 table, §6)
// ----------------------------------------------------------------------------
// CONTRACT: `parseLine(line)` is a pure function: given one raw Game.log line,
// return a DomainEvent or null. No I/O, no state, no side effects — so it can be
// unit-tested against /fixtures slices (SPEC §9).
//
// The DomainEvent union is the FROZEN shared contract in `@shared/events`. This
// file imports it and RE-EXPORTS it so the watcher (this phase) and the store
// (phase 3, which imports `DomainEvent` from this module per BUILD-NOTES §"seams")
// both see the identical type.
//
// Defensive by design (SPEC §2 ⚠, addendum "per-patch fragility"): log formats
// change per patch and the New-Objective line is intermittently absent. Every
// regex is anchored on a stable signature, every numeric/structural extraction
// is guarded, and a malformed or unrecognized line returns `null` — never throws.
//
// OWNER: Phase 2 (parser). logWatcher.ts feeds lines in; missionStore.ts
// consumes the events out. Neither should reimplement parsing.
// ============================================================================

import type {
  LegKind,
  MissionVariant,
  MissionGrade,
  Position,
} from "@shared/types";
import type { DomainEvent } from "@shared/events";

// Re-export the frozen union so phase-3 can `import { DomainEvent } from
// "./logParsers"` (BUILD-NOTES seam) and get the exact shared type.
export type { DomainEvent } from "@shared/events";

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------

// Leading `<2026-06-19T21:03:51.975Z>` ISO-8601 timestamp on every log line.
const TS_RE = /^<(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)>/;

/**
 * Parse the leading `<ISO8601>` timestamp into epoch ms.
 * Returns NaN when no/invalid timestamp — callers treat NaN as "not parseable"
 * and bail (a domain event without a usable ts is useless for §4a correlation).
 */
function parseTimestamp(line: string): number {
  const m = TS_RE.exec(line);
  if (!m) return NaN;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? NaN : t;
}

// ---------------------------------------------------------------------------
// Field extraction helpers (defensive — return null/undefined on miss)
// ---------------------------------------------------------------------------

/** `MissionId: [uuid]` or `MissionId[uuid]` (EndMission uses no space/colon). */
function extractMissionId(line: string): string | null {
  const m = /MissionId\s*:?\s*\[([^\]]*)\]/.exec(line);
  if (!m) return null;
  const id = m[1].trim();
  return id.length > 0 ? id : null;
}

/** `ObjectiveId: [dropoff_<phase>_0]` — may be empty `[]`. */
function extractObjectiveId(line: string): string | null {
  const m = /ObjectiveId\s*:?\s*\[([^\]]*)\]/.exec(line);
  if (!m) return null;
  const id = m[1].trim();
  return id.length > 0 ? id : null;
}

/** Derive leg kind from a `pickup_*` / `dropoff_*` objectiveId prefix. */
function legKindFromObjectiveId(objectiveId: string): LegKind | null {
  if (objectiveId.startsWith("pickup_")) return "pickup";
  if (objectiveId.startsWith("dropoff_")) return "dropoff";
  return null;
}

/** `position [x: 1.0, y: 2.0, z: 3.0]` → {x,y,z}; undefined if absent/partial. */
function extractPosition(line: string): Position | undefined {
  const m =
    /position\s*\[x:\s*(-?\d+(?:\.\d+)?),\s*y:\s*(-?\d+(?:\.\d+)?),\s*z:\s*(-?\d+(?:\.\d+)?)\]/.exec(
      line,
    );
  if (!m) return undefined;
  const x = Number(m[1]);
  const y = Number(m[2]);
  const z = Number(m[3]);
  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return undefined;
  return { x, y, z };
}

/** Pull the quoted notification body out of a SHUDEvent_OnNotification line. */
function extractNotificationText(line: string): string | null {
  // `Added notification "<text>" [N] to queue.`  The text itself never contains
  // an unescaped `"` in observed logs, so a non-greedy quote match is safe.
  const m = /Added notification\s+"([\s\S]*?)"\s+\[\d+\]\s+to queue/.exec(line);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Contract template parsing (giver-agnostic; SPEC §2 🔑, addendum)
// ---------------------------------------------------------------------------

/**
 * Variant as derived from a raw template. This is a SUPERSET of the shared
 * `MissionVariant` (which has no UNKNOWN member): the parser cannot always
 * classify an unrecognized giver's template, so it reports `"UNKNOWN"`. The
 * store maps UNKNOWN onto the domain model when it builds a Mission (e.g. to
 * `MANUAL`). We never widen the frozen `MissionVariant` itself.
 */
export type ParsedVariant = Exclude<MissionVariant, "MANUAL"> | "UNKNOWN";

export interface ParsedContractTemplate {
  variant: ParsedVariant;
  grade: MissionGrade;
  /** Best-effort raw commodity token from the template; "" when not derivable. */
  commodityToken: string;
  /**
   * Clean, human display name derived from `commodityToken` (FIX 2). Known
   * abbreviations are expanded (PressIce -> Pressurized Ice); otherwise the
   * CamelCase token is split + title-cased (RefinedOre -> Refined Ore). "" when
   * no commodity token is derivable. Used to auto-fill a leg's commodity when the
   * game suppressed the authoritative New Objective line.
   */
  commodityDisplay: string;
}

/**
 * Known commodity-token abbreviations that don't cleanly title-case. Keep this
 * SMALL and conservative — anything not listed falls back to CamelCase splitting,
 * which is correct for the vast majority of tokens (Titanium, Hydrogen, Waste…).
 * Keys are matched case-insensitively. Game data only; no personal data.
 */
const COMMODITY_TOKEN_ALIASES: Record<string, string> = {
  pressice: "Pressurized Ice",
  procfood: "Processed Food",
  rmc: "Recycled Material Composite",
  cmat: "Construction Materials",
};

/**
 * Map a raw template commodity token to a clean display name (FIX 2). Expands a
 * few known abbreviations; otherwise splits CamelCase and title-cases. Pure;
 * never throws; returns "" for empty/non-string input.
 */
export function commodityDisplayFromToken(token: string): string {
  if (typeof token !== "string") return "";
  const raw = token.trim();
  if (raw.length === 0) return "";

  const alias = COMMODITY_TOKEN_ALIASES[raw.toLowerCase()];
  if (alias) return alias;

  // Split CamelCase / digit boundaries, collapse separators, then title-case.
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // RefinedOre -> Refined Ore
    .replace(/([A-Za-z])([0-9])/g, "$1 $2") // Stanton1 -> Stanton 1
    .replace(/[_\-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return words
    .map((w) =>
      w.length <= 1 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1),
    )
    .join(" ");
}

// ---------------------------------------------------------------------------
// Title-derived route parsing (FIX 3 — location autofill fallback)
// ---------------------------------------------------------------------------

/**
 * Route extracted from a Contract Accepted title. Used ONLY as a fallback when
 * the authoritative New Objective line (objectiveDeclared) is suppressed by the
 * game's intermittent ObjectiveTokenDef bug. `pickup`/`dropoff` are free-text
 * human location names (or null when the title doesn't carry them).
 */
export interface TitleRoute {
  pickup: string | null;
  dropoff: string | null;
}

/**
 * Strip the `<EM3>…</EM3>` style markup (including orphan / self-closing tags
 * like the trailing `<EM4>`) from a raw title and collapse whitespace. Pure.
 */
function stripTitleMarkup(raw: string): string {
  return raw
    .replace(/<\/?EM\d+\s*\/?>/gi, " ") // <EM3>, </EM3>, <EM4/>, trailing <EM4>
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Clean a single endpoint name extracted from a title route. Real captured
 * titles carry contract-modifier tokens and a trailing colon on the endpoints,
 * e.g. `"Everus Harbor [BP]* :"` or `"Port Tressler [BP]* [VAR] :"`. These must
 * NOT leak into the location string: a dirty name shows a garbled UI label AND
 * fails to key-match a clean `objectiveDeclared` location, splitting one stop
 * into two By-Dropoff groups.
 *
 * Conservative by design — removes ONLY bracket-token groups (`[...]` with an
 * optional trailing `*`) and a trailing `:`/whitespace. Legitimate location
 * characters (letters, digits, spaces, `-`) pass through untouched, so real
 * names like "Everus Harbor", "Area18", and "HDPC-Cassillo" are preserved. Pure.
 */
function cleanRouteName(raw: string): string {
  return raw
    .replace(/\s*\[[^\]]*\]\*?/g, "") // ` [BP]*`, `[VAR]`, etc. (token + opt '*')
    .replace(/\s*:\s*$/, "") // trailing colon + surrounding whitespace
    .replace(/\s{2,}/g, " ") // collapse any double spaces left behind
    .trim();
}

/**
 * Parse the route out of a Contract Accepted title (FIX 3). The route lives in
 * the LAST `|`-delimited segment of the (markup-stripped) title:
 *   - "… | Seraphim Station > Everus Harbor"  -> { pickup, dropoff }
 *   - "… | from Baijini Point"                -> { pickup, dropoff: null }
 *   - anything else                            -> { pickup: null, dropoff: null }
 *
 * Defensive: trims, collapses whitespace, returns nulls on anything unparseable
 * or non-string input; never throws. Pure + exported so it's unit-testable.
 *
 * This is a FALLBACK only — the declared location (objectiveDeclared) is always
 * authoritative; see missionStore's title-route location fill.
 */
export function parseTitleRoute(title: string): TitleRoute {
  const empty: TitleRoute = { pickup: null, dropoff: null };
  if (typeof title !== "string") return empty;

  const cleaned = stripTitleMarkup(title);
  if (cleaned.length === 0) return empty;

  const segments = cleaned.split("|");
  const last = segments[segments.length - 1]?.trim() ?? "";
  if (last.length === 0) return empty;

  // "<pickup> > <dropoff>" — directional A->B route.
  const gtIdx = last.indexOf(">");
  if (gtIdx !== -1) {
    // Clean BOTH endpoints (defensive): tokens/colons can appear on either side.
    const pickup = cleanRouteName(last.slice(0, gtIdx));
    const dropoff = cleanRouteName(last.slice(gtIdx + 1));
    return {
      pickup: pickup.length > 0 ? pickup : null,
      dropoff: dropoff.length > 0 ? dropoff : null,
    };
  }

  // "from <pickup>" — pickup only (single-to-multi: no single dropoff in title).
  const fromM = /^from\s+(.+)$/i.exec(last);
  if (fromM) {
    const pickup = cleanRouteName(fromM[1]);
    return { pickup: pickup.length > 0 ? pickup : null, dropoff: null };
  }

  return empty;
}

/**
 * Map a contract-template string to { variant, grade, commodityToken }, handling
 * BOTH known giver formats and degrading to UNKNOWN for anything else. Never throws.
 *
 *  - Covalex: `HaulCargo_<Variant>_<Category>_<Commodity>_<System>_<Grade>`
 *      e.g. HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade
 *           HaulCargo_SingleToMulti3_Processed_Mixed_PressIceProcFood_Stanton1_SupplyGrade
 *           HaulCargo_Multi2ToSingle_Waste_Waste_Stanton1_SupplyGrade
 *  - RedWind: `Redwind_<System>_<Grade>_<Style>_<Commodity>`
 *      e.g. Redwind_Stanton_SmallGrade_Planetary_Hydrogen
 *
 * Variant: AToB->A_TO_B, SingleToMulti*->SINGLE_TO_MULTI, Multi*ToSingle->
 *          MULTI_TO_SINGLE, else UNKNOWN.
 * Grade:   SupplyGrade->SUPPLY, SmallGrade->SMALL, BulkGrade->BULK, else UNKNOWN.
 */
export function parseContractTemplate(
  template: string,
): ParsedContractTemplate {
  const t = typeof template === "string" ? template : "";

  const commodityToken = parseCommodityToken(t);
  return {
    variant: parseVariant(t),
    grade: parseGrade(t),
    commodityToken,
    commodityDisplay: commodityDisplayFromToken(commodityToken),
  };
}

function parseVariant(template: string): ParsedVariant {
  // Match the variant token as a substring. `_` is a regex word char so `\b`
  // does NOT fire at `_AToB` boundaries — match the distinctive token directly
  // instead. Order matters: the two directional tokens both contain "Single"/
  // "Multi", so check them before any bare alternative.
  if (/SingleToMulti\d*/i.test(template)) return "SINGLE_TO_MULTI";
  if (/Multi\d*ToSingle/i.test(template)) return "MULTI_TO_SINGLE";
  if (/AToB/i.test(template)) return "A_TO_B";
  return "UNKNOWN";
}

function parseGrade(template: string): MissionGrade {
  if (/SupplyGrade/i.test(template)) return "SUPPLY";
  if (/SmallGrade/i.test(template)) return "SMALL";
  if (/BulkGrade/i.test(template)) return "BULK";
  return "UNKNOWN";
}

function parseCommodityToken(template: string): string {
  const parts = template.split("_").filter((p) => p.length > 0);
  if (parts.length === 0) return "";

  // Covalex: HaulCargo_<Variant>_<Category…>_<Commodity>_<System>_<Grade>.
  // The category section is variable-width (e.g. `Processed_Mixed`), so anchor on
  // the stable <System>_<Grade> tail: the commodity is the 3rd-from-last token.
  //   HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade            -> Waste
  //   HaulCargo_SingleToMulti3_Processed_Mixed_PressIceProcFood_Stanton1_SupplyGrade
  //                                                              -> PressIceProcFood
  if (/^HaulCargo$/i.test(parts[0]) && parts.length >= 6) {
    return parts[parts.length - 3] ?? "";
  }

  // RedWind: Redwind_<System>_<Grade>_<Style>_<Commodity> -> last token.
  if (/^Redwind$/i.test(parts[0]) && parts.length >= 5) {
    return parts[parts.length - 1] ?? "";
  }

  // Unknown format: no reliable commodity position.
  return "";
}

// ---------------------------------------------------------------------------
// Per-event-type line parsers. Each returns its DomainEvent or null.
// ---------------------------------------------------------------------------

/** "Contract Accepted: <title> <EM4>...</EM4>: " — Tier-1, every mission. */
function parseMissionAccepted(
  line: string,
  ts: number,
  text: string,
): DomainEvent | null {
  const m = /^Contract Accepted:\s*([\s\S]*)$/.exec(text);
  if (!m) return null;
  const missionId = extractMissionId(line);
  if (!missionId) return null;

  const title = cleanTitle(m[1]);
  if (title.length === 0) return null;

  // Parse the route from the RAW title segment (markup intact) so the route
  // helper can use its own markup stripping. Fallback only; declared wins.
  const { pickup, dropoff } = parseTitleRoute(m[1]);

  return {
    type: "missionAccepted",
    missionId,
    title,
    titlePickup: pickup,
    titleDropoff: dropoff,
    ts,
  };
}

/** Strip the `<EM4>...</EM4>` formatting markup and trailing `: ` from a title. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/<(\w+)>[\s\S]*?<\/\1>/g, "") // drop whole markup blocks, e.g. <EM4>[BP]*</EM4>
    .replace(/<[^>]*>/g, "") // drop any orphan/self-closing tags
    .replace(/[:\s]+$/g, "") // trailing colon/space the game appends
    .trim();
}

/** "New Objective: Deliver <done>/<total> SCU of <commodity> to <location>". */
function parseObjectiveDeclared(
  line: string,
  ts: number,
  text: string,
): DomainEvent | null {
  // <done>/<total> — we want the total. Commodity and location are free text.
  const m =
    /^New Objective:\s*Deliver\s+\d+\s*\/\s*(\d+)\s+SCU of\s+(.+?)\s+to\s+(.+?)\s*:?\s*$/.exec(
      text,
    );
  if (!m) return null;

  const missionId = extractMissionId(line);
  const objectiveId = extractObjectiveId(line);
  if (!missionId || !objectiveId) return null;

  const kind = legKindFromObjectiveId(objectiveId);
  if (!kind) return null;

  const scuTotal = Number(m[1]);
  if (!Number.isFinite(scuTotal)) return null;

  const commodity = m[2].trim();
  const location = m[3].trim();
  if (commodity.length === 0 || location.length === 0) return null;

  return {
    type: "objectiveDeclared",
    missionId,
    objectiveId,
    kind,
    commodity,
    scuTotal,
    location,
    ts,
  };
}

/** "Awarded <N> aUEC" / "Fined <N> UEC". */
function parsePayoutOrFine(
  _line: string,
  ts: number,
  text: string,
): DomainEvent | null {
  const awarded = /^Awarded\s+(\d+)\s+aUEC\b/.exec(text);
  if (awarded) {
    const amount = Number(awarded[1]);
    if (!Number.isFinite(amount)) return null;
    return { type: "payoutAwarded", amount, ts };
  }
  const fined = /^Fined\s+(\d+)\s+UEC\b/.exec(text);
  if (fined) {
    const amount = Number(fined[1]);
    if (!Number.isFinite(amount)) return null;
    return { type: "fined", amount, ts };
  }
  return null;
}

/** Dispatch the various `<SHUDEvent_OnNotification>` notification subtypes. */
function parseNotification(line: string, ts: number): DomainEvent | null {
  const text = extractNotificationText(line);
  if (text === null) return null;

  return (
    parseMissionAccepted(line, ts, text) ??
    parseObjectiveDeclared(line, ts, text) ??
    parsePayoutOrFine(line, ts, text)
    // "Contract Complete: <title>" is intentionally NOT emitted as a domain event:
    // EndMission is the canonical terminal signal (SPEC §4 row, addendum). Noise here.
  );
}

/** `<CLocalMissionPhaseMarker::CreateMarker> ...` — Tier-1 marker event. */
function parseMissionMarker(line: string, ts: number): DomainEvent | null {
  const missionIdM = /missionId\s*\[([^\]]+)\]/.exec(line);
  const generatorM = /generator name\s*\[([^\]]+)\]/.exec(line);
  const templateM = /contract\s*\[([^\]]+)\]/.exec(line);
  const objectiveM = /objectiveId\s*\[([^\]]+)\]/.exec(line);
  if (!missionIdM || !generatorM || !templateM || !objectiveM) return null;

  const objectiveId = objectiveM[1].trim();
  const kind = legKindFromObjectiveId(objectiveId);
  if (!kind) return null;

  const defM = /contractDefinitionId\s*\[([^\]]+)\]/.exec(line);

  const event: Extract<DomainEvent, { type: "missionMarker" }> = {
    type: "missionMarker",
    missionId: missionIdM[1].trim(),
    giver: generatorM[1].trim(),
    contractTemplate: templateM[1].trim(),
    objectiveId,
    kind,
    ts,
  };

  const defId = defM?.[1]?.trim();
  if (defId) event.contractDefinitionId = defId;

  const position = extractPosition(line);
  if (position) event.position = position;

  return event;
}

/**
 * `<ObjectiveUpserted>` / `<ObjectiveComplete>` push messages.
 * Both carry `mission_id <id> ... objective_id <id> ... state ...COMPLETED`.
 * Only COMPLETED transitions become domain events (other states are noise).
 */
function parseObjectiveCompleted(line: string, ts: number): DomainEvent | null {
  if (!/MISSION_OBJECTIVE_STATE_COMPLETED/.test(line)) return null;

  const missionM = /mission_id\s+(\S+)/.exec(line);
  const objectiveM = /objective_id\s+(\S+)/.exec(line);
  if (!missionM || !objectiveM) return null;

  return {
    type: "objectiveCompleted",
    missionId: missionM[1].trim(),
    objectiveId: objectiveM[1].trim(),
    ts,
  };
}

/** `<EndMission> ... MissionId[uuid] ... CompletionType[Complete|Abandon] Reason[...]`. */
function parseMissionEnded(line: string, ts: number): DomainEvent | null {
  const missionId = extractMissionId(line);
  if (!missionId) return null;

  const completionM = /CompletionType\s*\[([^\]]+)\]/.exec(line);
  if (!completionM) return null;

  const raw = completionM[1].trim().toLowerCase();
  let completionType: "complete" | "abandon";
  if (raw === "complete") completionType = "complete";
  else if (raw === "abandon") completionType = "abandon";
  else return null; // unknown terminal type — don't guess

  const reasonM = /Reason\s*\[([^\]]*)\]/.exec(line);
  const reason = reasonM ? reasonM[1].trim() : "";

  return { type: "missionEnded", missionId, completionType, reason, ts };
}

/** `<RequestLocationInventory> ... Location[<internalId>]`. */
function parseLocationInventory(line: string, ts: number): DomainEvent | null {
  const m = /Location\s*\[([^\]]+)\]/.exec(line);
  if (!m) return null;
  const locationId = m[1].trim();
  if (locationId.length === 0) return null;
  return { type: "locationInventory", locationId, ts };
}

// ---------------------------------------------------------------------------
// Parser entry point
// ---------------------------------------------------------------------------

/**
 * Parse a single Game.log line into a DomainEvent, or null if the line is not
 * one we care about (or is malformed). PURE — no I/O, no captured state, never
 * throws. The line's tag (`<...>`) is the primary discriminator; we route to the
 * matching sub-parser and let it return null if the rest of the line doesn't fit.
 */
export function parseLine(line: string): DomainEvent | null {
  if (typeof line !== "string" || line.length === 0) return null;

  const ts = parseTimestamp(line);
  if (Number.isNaN(ts)) return null; // no usable timestamp -> not a real event line

  try {
    if (line.includes("<SHUDEvent_OnNotification>"))
      return parseNotification(line, ts);
    if (line.includes("<CLocalMissionPhaseMarker::CreateMarker>"))
      return parseMissionMarker(line, ts);
    if (
      line.includes("<ObjectiveUpserted>") ||
      line.includes("<ObjectiveComplete>")
    ) {
      return parseObjectiveCompleted(line, ts);
    }
    if (line.includes("<EndMission>")) return parseMissionEnded(line, ts);
    if (line.includes("<RequestLocationInventory>"))
      return parseLocationInventory(line, ts);
    return null;
  } catch {
    // Defensive backstop: a format we didn't anticipate must never crash the tail.
    return null;
  }
}
