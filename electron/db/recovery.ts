// ============================================================================
// db/recovery.ts — sqlite corruption detection + recover-and-rebuild
// ----------------------------------------------------------------------------
// The mission/leg/earnings data is FULLY re-derivable from the Star Citizen logs
// (live Game.log + logbackups). So a corrupt on-disk database must be a
// RECOVERABLE non-event, never a fatal crash dialog.
//
// This module owns three concerns, kept separate from the pure DDL (schema.ts)
// and the state machine (missionStore.ts):
//
//   1. isCorruptionError(err)  — predicate: is this thrown error a sqlite
//      "database disk image is malformed" / SQLITE_CORRUPT class failure?
//   2. integrityIsBad(db)      — run PRAGMA quick_check on an OPEN handle and
//      report whether it reported corruption.
//   3. quarantineDbFiles(path) — rename the bad .db (+ -wal/-shm) aside to a
//      forensic .corrupt-<n> copy so a fresh DB can be created in its place. The
//      user's data is never deleted; the rename keeps a recoverable copy.
//   4. openDbResilient(path, open) — open via the caller's opener; on a
//      corruption error (at open OR first integrity check) quarantine + retry
//      once on a fresh file. Anything that is NOT corruption is rethrown.
//
// Used by missionStore (open path) and main.ts (runtime corruption catch).
// ============================================================================

import { existsSync, renameSync, statSync } from "node:fs";
import type { Database as DB } from "better-sqlite3";

// ---------------------------------------------------------------------------
// Corruption predicate
// ---------------------------------------------------------------------------

/**
 * Is `err` a sqlite corruption failure? better-sqlite3 throws `SqliteError`
 * with `.code === 'SQLITE_CORRUPT'` (or the NOTADB / IOERR_SHORT_READ variants)
 * and a message containing "malformed" / "not a database". We match on both the
 * code and the message text so we catch the corruption class regardless of which
 * surface (open vs query) raised it. Deliberately conservative — anything we are
 * not sure is corruption is treated as a REAL bug and left to bubble.
 */
export function isCorruptionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (
      code === "SQLITE_CORRUPT" ||
      code.startsWith("SQLITE_CORRUPT") ||
      code === "SQLITE_NOTADB"
    ) {
      return true;
    }
  }
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string") {
    const m = message.toLowerCase();
    if (
      m.includes("database disk image is malformed") ||
      m.includes("file is not a database") ||
      m.includes("database is malformed") ||
      m.includes("malformed database schema") ||
      // A header-readable but corrupt db reports a generic SQLITE_ERROR with
      // this message; treat it as corruption (the file cannot be used).
      m.includes("unsupported file format") ||
      m.includes("file is encrypted or is not a database")
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Integrity check on an open handle
// ---------------------------------------------------------------------------

/**
 * Run `PRAGMA quick_check` on an OPEN database and return true if it reports
 * corruption. quick_check is the cheaper cousin of integrity_check — it skips
 * the (expensive) index-vs-table cross validation but still catches a malformed
 * page image, which is exactly the failure mode we are guarding against. A clean
 * db returns the single row 'ok'. If the pragma itself THROWS a corruption
 * error, that also counts as bad. Any non-corruption throw is rethrown.
 */
export function integrityIsBad(db: DB): boolean {
  let rows: Array<{ quick_check?: string } | Record<string, unknown>>;
  try {
    rows = db.pragma("quick_check") as Array<Record<string, unknown>>;
  } catch (err) {
    if (isCorruptionError(err)) return true;
    throw err;
  }
  if (!Array.isArray(rows) || rows.length === 0) return false;
  // quick_check returns [{ quick_check: 'ok' }] when healthy.
  if (rows.length === 1) {
    const val = Object.values(rows[0])[0];
    if (typeof val === "string" && val.toLowerCase() === "ok") return false;
  }
  // Any other shape (one or more error description rows) means corruption.
  return true;
}

// ---------------------------------------------------------------------------
// Quarantine bad files aside
// ---------------------------------------------------------------------------

/** The sqlite sidecar suffixes that travel with a WAL-mode database file. */
const SIDECARS = ["", "-wal", "-shm"] as const;

/**
 * Rename the corrupt database (and its -wal/-shm sidecars) aside to a forensic
 * copy so a fresh DB can be created at `dbPath`. Returns the base path the files
 * were moved to (e.g. `<dbPath>.corrupt-1`), or null if there was nothing to
 * move (e.g. an in-memory db, or the file already gone). NEVER deletes — the
 * rename keeps a recoverable copy of the user's data.
 *
 * The numeric suffix is chosen so repeated recoveries don't clobber an earlier
 * forensic copy (`.corrupt-1`, `.corrupt-2`, …).
 */
export function quarantineDbFiles(dbPath: string): string | null {
  if (dbPath === ":memory:" || dbPath === "") return null;
  if (!existsSync(dbPath)) {
    // The main file is gone but a stray -wal/-shm may remain; move those too.
    const target = nextCorruptBase(dbPath);
    let movedAny = false;
    for (const suffix of SIDECARS) {
      if (suffix === "") continue;
      const from = dbPath + suffix;
      if (existsSync(from)) {
        trySafeRename(from, target + suffix);
        movedAny = true;
      }
    }
    return movedAny ? target : null;
  }

  const target = nextCorruptBase(dbPath);
  for (const suffix of SIDECARS) {
    const from = dbPath + suffix;
    if (existsSync(from)) {
      trySafeRename(from, target + suffix);
    }
  }
  return target;
}

/** Pick the next un-used `<dbPath>.corrupt-<n>` base name. */
function nextCorruptBase(dbPath: string): string {
  let n = 1;
  // Guard against an unbounded loop on a pathological filesystem.
  while (n < 10000) {
    const candidate = `${dbPath}.corrupt-${n}`;
    if (
      !existsSync(candidate) &&
      !existsSync(candidate + "-wal") &&
      !existsSync(candidate + "-shm")
    ) {
      return candidate;
    }
    n++;
  }
  // Fallback: timestamp-suffixed, effectively always unique.
  return `${dbPath}.corrupt-${Date.now()}`;
}

/**
 * Rename `from` -> `to`. On Windows a transient lock can make rename fail
 * (EPERM/EBUSY); we swallow that so recovery still proceeds (the fresh DB is
 * created regardless). A leftover locked file is harmless — the next open does
 * not read it.
 */
function trySafeRename(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    // Best-effort. If the OS holds the handle we can't move it; the fresh DB is
    // created at the original path anyway once handles are released.
  }
}

// ---------------------------------------------------------------------------
// Resilient open
// ---------------------------------------------------------------------------

export interface ResilientOpenResult {
  db: DB;
  /** True if the original db was found corrupt and a fresh one was created. */
  recovered: boolean;
  /** Where the bad files were quarantined, when recovered. */
  quarantinedTo: string | null;
}

/**
 * Open the database resiliently:
 *   - call `open(path)` (the caller's opener — applies schema + pragmas),
 *   - run an integrity check,
 *   - if EITHER the open throws a corruption error OR the integrity check is
 *     bad, quarantine the bad files and retry the open ONCE on a fresh file.
 *
 * Non-corruption errors are rethrown untouched (do not silently swallow real
 * bugs). A second corruption on the fresh file is rethrown too (something is
 * deeply wrong — let it surface rather than loop).
 *
 * `onRecover` is invoked (if provided) when a recovery happens, for logging.
 */
export function openDbResilient(
  dbPath: string,
  open: (path: string) => DB,
  onRecover?: (info: { quarantinedTo: string | null }) => void,
): ResilientOpenResult {
  // First attempt.
  try {
    const db = open(dbPath);
    if (!integrityIsBad(db)) {
      return { db, recovered: false, quarantinedTo: null };
    }
    // Opened, but the image is malformed. Close before we move the files.
    try {
      db.close();
    } catch {
      /* ignore close error on a corrupt handle */
    }
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    // fall through to recovery
  }

  // Recovery: quarantine + recreate.
  const quarantinedTo = quarantineDbFiles(dbPath);
  onRecover?.({ quarantinedTo });

  // Second (final) attempt on a now-fresh path. If THIS is corrupt, let it throw.
  const db = open(dbPath);
  if (integrityIsBad(db)) {
    throw new Error(
      "sc-cargo-tracker: freshly-created database still fails integrity check",
    );
  }
  return { db, recovered: true, quarantinedTo };
}

/**
 * Best-effort size of a db file for logging (bytes), 0 if absent/unreadable.
 */
export function dbFileSize(dbPath: string): number {
  try {
    return statSync(dbPath).size;
  } catch {
    return 0;
  }
}
