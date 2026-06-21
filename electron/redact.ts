// ============================================================================
// redact.ts — identity redaction for diagnostics reports
// ----------------------------------------------------------------------------
// PURE + unit-tested. The diagnostics "Collect Logs" feature ships a sanitized
// extract of the game's Game.log plus the app's own files back to the maintainer
// so they can compare "what the game logged" vs "what the app captured". The
// Game.log contains the player's HANDLE and GEID (and Windows username appears in
// paths), none of which the maintainer needs to triage a parsing bug. This module
// strips that identity while KEEPING the data the maintainer DOES need: mission
// ids, commodity, SCU, location, timestamps.
//
// Two layers, applied in order:
//   1) targeted — the SPECIFIC handle + GEID detected from the log are replaced
//      everywhere by their exact value (catches them in any context, even bare).
//   2) blanket  — structural patterns (Player[…], PlayerId[…], Users\<name>) are
//      redacted regardless of whether detection found a value, so a handle we
//      failed to auto-detect still can't leak through a wrapper we recognize.
//
// Defensive: every function tolerates null/undefined/non-string and never throws.
// ============================================================================

/** The identity tokens detected from a Game.log, used to build a redactor. */
export interface PlayerIdentity {
  /** The player's character handle (e.g. "SomePilot"), or null if not found. */
  handle: string | null;
  /** The player's GEID (the long numeric/alphanumeric id), or null. */
  geid: string | null;
}

/** Replacement tokens (kept stable so tests + the report header can reference them). */
export const REDACTED_PLAYER = "<PLAYER>";
export const REDACTED_PLAYER_ID = "<PLAYERID>";
export const REDACTED_USER = "<USER>";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Scan raw Game.log text for the player's handle + GEID. Star Citizen logs the
 * local player in a few stable shapes:
 *   - `Player[<handle>]`
 *   - `PlayerId[<geid>]`
 *   - `<handle>[<geid>]`  (e.g. on spawn / entity lines: `SomePilot[123456789]`)
 *
 * We take the FIRST confident occurrence of each. Returns nulls when nothing is
 * found (a log with no player lines — the blanket pass still applies downstream).
 * Never throws.
 */
export function detectPlayerIdentity(logText: string): PlayerIdentity {
  let handle: string | null = null;
  let geid: string | null = null;

  if (typeof logText !== "string" || logText.length === 0) {
    return { handle, geid };
  }

  try {
    // PlayerId[<geid>] — the GEID is digits (occasionally with a leading id char).
    const geidM = /PlayerId\[([^\]]+)\]/.exec(logText);
    if (geidM) {
      const g = geidM[1].trim();
      if (g.length > 0) geid = g;
    }

    // Player[<handle>] — the handle is the account/character name.
    const handleM = /Player\[([^\]]+)\]/.exec(logText);
    if (handleM) {
      const h = handleM[1].trim();
      // Guard against the literal "Player[]" or a numeric-only value that is
      // really an id, not a handle.
      if (h.length > 0 && !/^\d+$/.test(h)) handle = h;
    }

    // <handle>[<geid>] — recover a handle from the combined spawn form when the
    // explicit Player[…] wrapper was absent but we DID find a GEID. The handle
    // token immediately precedes [<geid>] and is a name-like token.
    if (handle === null && geid !== null) {
      const combined = new RegExp(
        `([A-Za-z][A-Za-z0-9_-]{2,})\\[${escapeRegExp(geid)}\\]`,
      ).exec(logText);
      if (combined) handle = combined[1];
    }
  } catch {
    // Detection is best-effort; the blanket pass below is the safety net.
  }

  return { handle, geid };
}

// ---------------------------------------------------------------------------
// Redactor
// ---------------------------------------------------------------------------

/** Escape a string for safe embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a redactor function from a detected identity (+ optionally the Windows
 * username, which appears in file paths). The returned function is applied to
 * EVERY line that lands in the report.
 *
 * Order matters: replace the longest / most specific tokens first so a handle
 * that is a substring of another value isn't partially mangled. We do:
 *   1) the exact GEID and handle values (targeted),
 *   2) the Windows username (in any path or text),
 *   3) blanket structural wrappers (Player[…], PlayerId[…], Users\<name>).
 *
 * Never throws — a bad input returns "".
 */
export function createRedactor(
  identity: PlayerIdentity,
  windowsUsername?: string | null,
): (text: unknown) => string {
  const handle =
    identity.handle && identity.handle.length > 0 ? identity.handle : null;
  const geid = identity.geid && identity.geid.length > 0 ? identity.geid : null;
  const user =
    typeof windowsUsername === "string" && windowsUsername.trim().length > 0
      ? windowsUsername.trim()
      : null;

  // Pre-build the targeted regexes once.
  const geidRe = geid ? new RegExp(escapeRegExp(geid), "g") : null;
  const handleRe = handle ? new RegExp(escapeRegExp(handle), "g") : null;
  const userRe = user ? new RegExp(escapeRegExp(user), "gi") : null;

  return (text: unknown): string => {
    if (text === null || text === undefined) return "";
    let s: string;
    try {
      s = typeof text === "string" ? text : String(text);
    } catch {
      return "";
    }

    try {
      // 1) Targeted: the exact GEID first (longer, more specific), then handle.
      //    Doing GEID before handle avoids a short handle clobbering part of a
      //    GEID that happens to contain the handle's characters.
      if (geidRe) s = s.replace(geidRe, REDACTED_PLAYER_ID);
      if (handleRe) s = s.replace(handleRe, REDACTED_PLAYER);

      // 2) Windows username anywhere (JSON values, env echoes, bare).
      if (userRe) s = s.replace(userRe, REDACTED_USER);

      // 3) Blanket structural wrappers — catch identity even where targeted
      //    detection missed (or where the value differs from what we found).
      //    a) C:\Users\<name>\…  /  C:/Users/<name>/…  -> Users\<USER>
      s = s.replace(
        /([A-Za-z]:[\\/]+Users[\\/]+)[^\\/"]+/g,
        `$1${REDACTED_USER}`,
      );
      //    b) PlayerId[…] -> PlayerId[<PLAYERID>]
      s = s.replace(/PlayerId\[[^\]]*\]/g, `PlayerId[${REDACTED_PLAYER_ID}]`);
      //    c) Player[…] -> Player[<PLAYER>]
      s = s.replace(/Player\[[^\]]*\]/g, `Player[${REDACTED_PLAYER}]`);
    } catch {
      // If a replace somehow throws, prefer dropping the line's content over
      // leaking it un-redacted.
      return REDACTED_PLAYER;
    }

    return s;
  };
}
