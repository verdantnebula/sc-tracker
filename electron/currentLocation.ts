// ============================================================================
// currentLocation.ts — derive the player's "last known location" from log events
// ----------------------------------------------------------------------------
// The ONLY reliable player-position signal in Game.log is
//   <RequestLocationInventory> ... Location[<internalId>]
// which fires when the player opens a terminal/inventory ("the player is HERE").
// There is NO continuous movement/quantum/zone event in the current logs, and
// GenerateLocationProperty is mission *generation* (NOT player position).
//
// Critical correctness rule (the bug this fixes): a location derived during the
// HISTORICAL logbackups backfill reflects a PAST session, not where the player
// is now. So we derive currentLocation ONLY from LIVE locationInventory events
// (the current Game.log read-from-0 on startup + the ongoing tail). Until a live
// terminal visit is seen this session, currentLocation is null — the UI shows
// "—" rather than a stale/guessed value. A wrong location is worse than none.
//
// This module is pure (no Electron/IO) so it is unit-testable in isolation.
// ============================================================================

export type LocationSource = "historical" | "live";

// ---------------------------------------------------------------------------
// Humanize an internal terminal/zone id into a sensible display name.
//   Stanton1_DistributionCentre_Hurston_Farnesway -> "HDPC-Farnesway"
//   Stanton1_Lorville                              -> "Lorville"
//   RR_HUR_LEO                                     -> "RR-HUR-LEO"
// Best-effort + defensive: never throw; pass through anything we don't recognize.
// ---------------------------------------------------------------------------

/** Title-case a single token, leaving all-caps acronyms (LEO, HUR, RR) intact. */
function titleCaseToken(tok: string): string {
  if (tok.length === 0) return tok;
  // Already an acronym / all-caps short code -> keep as-is.
  if (tok.length <= 4 && tok === tok.toUpperCase()) return tok;
  return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
}

export function humanizeLocationId(raw: string): string {
  if (!raw) return raw;
  let id = raw.trim();
  if (id.length === 0) return raw;

  // 1) Drop a leading system token: Stanton1_, Stanton_, Pyro2_, etc.
  id = id.replace(/^(?:Stanton|Pyro)\d*_/i, "");

  // 2) Distribution-Centre terminals: ..._DistributionCentre_<Planet>_<Name>.
  //    Collapse to the recognizable "<P>DPC-<Name>" form players use, e.g.
  //    DistributionCentre_Hurston_Farnesway -> "HDPC-Farnesway".
  const dc = id.match(/DistributionCentre_([A-Za-z0-9]+)_([A-Za-z0-9]+)/i);
  if (dc) {
    const planetInitial = dc[1].charAt(0).toUpperCase();
    return `${planetInitial}DPC-${titleCaseToken(dc[2])}`;
  }

  // 3) Generic: split remaining tokens, title-case each, join with spaces.
  const tokens = id.split(/[_\s]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return raw;
  // Short hyphen-joined codes (RR_HUR_LEO) read better with hyphens.
  const allShortCodes = tokens.every(
    (t) => t.length <= 4 && t === t.toUpperCase(),
  );
  if (allShortCodes && tokens.length > 1) return tokens.join("-");
  return tokens.map(titleCaseToken).join(" ");
}

// The confident-match rule for the YOU ARE HERE highlight lives in the shared
// module so the renderer and the store apply it identically. Re-exported here
// for callers that already import from this module.
export { isConfidentLocationMatch } from "@shared/location";

// ---------------------------------------------------------------------------
// The tracker. Holds the latest LIVE humanized location; null until the first
// live terminal visit this session. Historical events are ignored entirely.
// ---------------------------------------------------------------------------

export class CurrentLocationTracker {
  private location: string | null = null;

  /**
   * Apply a locationInventory observation. Historical (backfill) observations
   * are IGNORED — they describe a past session. Only the latest LIVE one wins.
   * Returns true if the current location changed (so callers can broadcast).
   */
  apply(locationId: string, source: LocationSource): boolean {
    if (source !== "live") return false;
    if (!locationId || locationId.trim().length === 0) return false;
    const next = humanizeLocationId(locationId);
    if (next === this.location) return false;
    this.location = next;
    return true;
  }

  /** The last known LIVE location, or null when none seen this session. */
  get(): string | null {
    return this.location;
  }

  /** Forget the current location (Reset / Clear). */
  reset(): void {
    this.location = null;
  }
}
