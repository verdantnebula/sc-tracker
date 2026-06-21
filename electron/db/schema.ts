// ============================================================================
// db/schema.ts — sqlite schema + connection helper  (SPEC §5)
// ----------------------------------------------------------------------------
// Single source of truth for the on-disk shape backing missionStore + uexClient.
// Owned by Phase 2b (store). Pure DDL + a thin opener; no domain logic here.
//
// Identity rules (SPEC §2 🔑):
//   - missions keyed on `id` (game missionId / generated for manual).
//   - legs keyed on the COMPOSITE (mission_id, objective_id) — the game reuses
//     objectiveId across missions, so objective_id alone is NOT unique.
//   - earnings (payouts) + fines deduped by (amount, ts) for idempotent replay.
// ============================================================================

import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";

/** Current schema version. Bump + add a migration block when the shape changes. */
export const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS missions (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL DEFAULT '',
  giver                TEXT NOT NULL DEFAULT '',
  variant              TEXT NOT NULL DEFAULT 'MANUAL',
  grade                TEXT NOT NULL DEFAULT 'UNKNOWN',
  contract_template    TEXT,
  contract_definition_id TEXT,
  status               TEXT NOT NULL DEFAULT 'accepted',
  payout               INTEGER,                       -- nullable aUEC
  payout_confidence    TEXT NOT NULL DEFAULT 'unknown',
  source               TEXT NOT NULL DEFAULT 'log',
  accepted_at          INTEGER,                       -- epoch ms, nullable
  completed_at         INTEGER,                       -- epoch ms, nullable
  notes                TEXT NOT NULL DEFAULT '',
  created_seq          INTEGER,                       -- monotonic insert order (newest-first sort)
  -- Origin of the mission's defining events. 'historical' = reconstructed from a
  -- PAST session (logbackups backfill); 'live' = the current session (the live
  -- Game.log read on startup + the ongoing tail). Only live + non-terminal
  -- missions are "active" in the Mission List; historical ones belong in History.
  session              TEXT NOT NULL DEFAULT 'historical'
);

CREATE TABLE IF NOT EXISTS legs (
  mission_id     TEXT NOT NULL,
  objective_id   TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'dropoff',
  commodity      TEXT NOT NULL DEFAULT '',
  scu_total      INTEGER NOT NULL DEFAULT 0,
  scu_delivered  INTEGER NOT NULL DEFAULT 0,
  location       TEXT,                                -- nullable destination name
  pos_x          REAL,
  pos_y          REAL,
  pos_z          REAL,
  completed      INTEGER NOT NULL DEFAULT 0,          -- 0/1
  -- Epoch ms of the last USER toggle (manual override). NULL = never manually
  -- toggled. When set, a HISTORICAL replay (Reset/Re-sync) must not silently
  -- re-apply a log completion that would clobber the user's manual state.
  manual_override INTEGER,                            -- epoch ms, nullable
  PRIMARY KEY (mission_id, objective_id),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

-- Every parsed "Awarded N aUEC". Always counts toward total credits earned.
-- mission_id is the correlated mission, or NULL = unattributed "other income".
-- Deduped on (amount, ts) so replaying the same award never double-counts.
CREATE TABLE IF NOT EXISTS earnings (
  amount       INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  mission_id   TEXT,                                  -- nullable (other income)
  confidence   TEXT NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (amount, ts)
);

-- Every parsed "Fined N UEC". Tracked separately; never reduces a payout.
CREATE TABLE IF NOT EXISTS fines (
  amount   INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  PRIMARY KEY (amount, ts)
);

-- UEX reference cache. One row per resource ('commodities' | 'terminals'),
-- value = JSON-serialized normalized array, fetched_at = epoch ms.
CREATE TABLE IF NOT EXISTS uex_cache (
  resource    TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);
`;

/**
 * Open (or create) the sqlite database at `path` and ensure the schema exists.
 * Use ':memory:' for tests. Enables WAL + foreign keys.
 *
 * WAL hardening (defense in depth — the single-instance lock in main.ts removes
 * the primary corruption cause of two processes writing the same file):
 *   - busy_timeout: wait (rather than instantly erroring) if a sidecar is briefly
 *     locked, smoothing over transient contention.
 *   - synchronous = NORMAL: the recommended durability/perf balance under WAL;
 *     safe against application crashes (only a power loss can lose the last txn,
 *     and our data is re-derivable from logs anyway).
 *   - wal_autocheckpoint: fold the WAL back into the main db regularly so it does
 *     not grow unbounded (a multi-MB WAL was observed in the field).
 */
export function createDb(path: string): DB {
  const db = new Database(path);
  // If a corrupt file is opened, the handle is created but the FIRST pragma/exec
  // throws (e.g. "file is not a database" / "unsupported file format"). Close the
  // leaked handle before rethrowing so the file isn't left locked — otherwise the
  // recovery rename (quarantine) can't move it on Windows.
  try {
    // busy_timeout must be set before other access so locked-sidecar waits apply.
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("wal_autocheckpoint = 1000");
    db.pragma("foreign_keys = ON");
    db.exec(DDL);
    migrate(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      /* a corrupt handle may itself throw on close; ignore */
    }
    throw err;
  }
}

/**
 * Forward-only migrations for databases created by an earlier SCHEMA_VERSION.
 * CREATE TABLE IF NOT EXISTS leaves pre-existing tables untouched, so columns
 * added in a later version must be ALTERed in here. Each step is guarded so a
 * fresh DB (already at the latest shape) and a re-run are both no-ops.
 */
function migrate(db: DB): void {
  // v2: add missions.session. Existing rows predate the live/historical split;
  // they were all backfilled from logbackups, so 'historical' is the correct
  // default — they will no longer surface as active missions.
  const cols = db.prepare(`PRAGMA table_info(missions)`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "session")) {
    db.exec(
      `ALTER TABLE missions ADD COLUMN session TEXT NOT NULL DEFAULT 'historical'`,
    );
  }

  // v3: add legs.manual_override (epoch ms of the last user toggle, nullable).
  // Pre-existing legs were never manually toggled, so NULL is correct.
  const legCols = db.prepare(`PRAGMA table_info(legs)`).all() as Array<{
    name: string;
  }>;
  if (!legCols.some((c) => c.name === "manual_override")) {
    db.exec(`ALTER TABLE legs ADD COLUMN manual_override INTEGER`);
  }
}
