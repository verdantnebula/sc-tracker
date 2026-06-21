// ============================================================================
// missionStore.ts — state machine + better-sqlite3 persistence  (SPEC §5, §6)
// ----------------------------------------------------------------------------
// CONTRACT: the single source of truth for mission state. Applies DomainEvents
// (the FROZEN union from @shared/events) through the
//   accepted -> in_progress -> complete/abandoned
// state machine, persists to sqlite (legs keyed (missionId, objectiveId) per
// SPEC §2 🔑), handles payout correlation (SPEC §4a), answers the IPC reads, and
// computes the derived views (DropoffGroup, MissionTotals, Totals). Manual
// add/edit goes through here too.
//
// OWNER: Phase 2b (store). Consumes DomainEvent from @shared/events; produces
// Mission[] for the renderer via IPC.
//
// NOTE on the seam: we import DomainEvent from @shared/events (the frozen shared
// contract — what this phase is briefed to consume), NOT from logParsers.ts
// (another agent's file, which may change). A tiny local template parser handles
// variant/grade/commodity derivation from the contract template so we don't
// depend on logParsers exports.
// ============================================================================

import type { DomainEvent } from "@shared/events";
import { isConfidentLocationMatch } from "@shared/location";
import type {
  Mission,
  Leg,
  MissionPatch,
  ManualMissionInput,
  ManualLegInput,
  MissionVariant,
  MissionGrade,
  MissionStatus,
  PayoutConfidence,
  DropoffGroup,
  DropoffCommodity,
  LegRef,
  Totals,
} from "@shared/types";
import type { Database as DB } from "better-sqlite3";
import { createDb } from "./db/schema";
import {
  openDbResilient,
  isCorruptionError,
  quarantineDbFiles,
} from "./db/recovery";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Where the event being applied came from:
 *  - 'historical' : reconstructed from a PAST session (logbackups backfill).
 *  - 'live'       : the current session — the live Game.log read on startup plus
 *                   the ongoing tail. Only live, non-terminal missions are
 *                   "active" in the Mission List.
 * Defaults to 'live' so callers that don't care (manual entry, tests of live
 * behavior) get current-session semantics without ceremony.
 */
export type EventSource = "historical" | "live";

export interface MissionStore {
  /**
   * Apply one parsed domain event, mutating + persisting state. Idempotent.
   * `source` records whether the event is from historical backfill or the live
   * session; it sets a NEW mission's session and can PROMOTE a historical
   * mission to live (a backfilled-then-still-active mission seen live again),
   * but never downgrades live -> historical.
   */
  applyEvent(event: DomainEvent, source?: EventSource): void;
  /** All missions, newest first. */
  listMissions(): Mission[];
  /**
   * Active Mission-List missions: current session ('live') AND not yet terminal.
   * Historical non-terminal missions are stale and excluded (they belong in
   * History only if terminal). Newest first.
   */
  activeMissions(): Mission[];
  /**
   * Clear the active Mission List: remove every live, non-terminal mission.
   * History (terminal missions, any session) is untouched. Returns the count
   * removed.
   */
  clearActiveMissions(): number;
  /**
   * Wipe ALL persisted mission data (missions, legs, earnings, fines) so the
   * caller can re-run backfill under the corrected rules. UEX reference cache is
   * preserved. Returns the number of missions removed.
   */
  resetAllData(): number;
  /** A single mission by id, or undefined. */
  getMission(id: string): Mission | undefined;
  /** Add a manually-entered mission. Returns the persisted record. */
  addManualMission(input: ManualMissionInput): Mission;
  /** Patch payout/notes/status/leg completion. Returns the updated record. */
  updateMission(missionId: string, patch: MissionPatch): Mission;
  /** Toggle a single leg's completion (sets scuDelivered accordingly). */
  toggleLeg(missionId: string, legId: string, completed: boolean): Mission;
  /** Mark a mission abandoned (terminal). Returns the updated record. */
  abandon(missionId: string): Mission;
  /** Remove a mission entirely (hard delete). */
  abandonMission(missionId: string): void;
  /** Set/override a mission's payout (manual edit -> confidence 'confirmed'). */
  setPayout(missionId: string, amount: number | null): Mission;
  /** Derived By-Dropoff aggregation across active missions. */
  dropoffGroups(currentLocation: string | null): DropoffGroup[];
  /** Completed/abandoned missions for the History view, newest first. */
  history(): Mission[];
  /** Lifetime/session totals for the History header. */
  totals(): Totals;
  /**
   * True if the database was found corrupt on open and a fresh one was created
   * (the bad file was quarantined aside). main.ts can use this to trigger a
   * backfill that repopulates the fresh DB from the logs.
   */
  wasRecovered(): boolean;
  /**
   * Force a recover-and-rebuild: close the current handle, quarantine the bad
   * db files aside, and reopen a fresh database. Used by the runtime corruption
   * catch in main.ts so a SQLITE_CORRUPT thrown DURING operation rebuilds rather
   * than crashing. Returns where the bad files were quarantined (or null for an
   * in-memory store / nothing to move). After this the caller should re-run the
   * logbackups backfill to repopulate.
   */
  recoverFromCorruption(): string | null;
  /**
   * Run `fn`; if it throws a sqlite corruption error, recover-and-rebuild and
   * rethrow a tagged marker error so the caller knows a rebuild happened (and
   * can re-run backfill). Non-corruption errors propagate untouched. Returns the
   * function's result on success.
   */
  guard<T>(fn: () => T): T;
  /** Close the underlying database handle. */
  close(): void;
}

/** Thrown by guard() after a successful recover-and-rebuild from corruption. */
export class DatabaseRecoveredError extends Error {
  readonly quarantinedTo: string | null;
  constructor(quarantinedTo: string | null) {
    super("database was corrupt; recovered and rebuilt");
    this.name = "DatabaseRecoveredError";
    this.quarantinedTo = quarantinedTo;
  }
}

export interface MissionStoreOptions {
  /** Absolute path to the sqlite database file. ':memory:' for tests. */
  dbPath: string;
  /**
   * Window (ms) before a payout in which a missionEnded counts as a candidate
   * for attribution (SPEC §4a ~2s). Configurable for tests.
   */
  payoutWindowMs?: number;
  /**
   * Invoked whenever the store recovers from corruption (on open OR at runtime
   * via guard()/recoverFromCorruption). For logging by the host process. The
   * argument is where the bad files were quarantined (null = nothing to move).
   */
  onRecover?: (quarantinedTo: string | null) => void;
}

const DEFAULT_PAYOUT_WINDOW_MS = 2000;

// ---------------------------------------------------------------------------
// Hauling-giver gate (SPEC §7.2 / §10 — history filters to hauling givers).
// Giver strings are discovered from logs; match defensively/case-insensitively.
// ---------------------------------------------------------------------------

function isHaulingGiver(giver: string): boolean {
  const g = giver.toLowerCase();
  return (
    g.includes("hauling") || g.includes("covalex") || g.includes("redwind")
  );
}

// ---------------------------------------------------------------------------
// Local contract-template parser (giver-agnostic; SPEC §2 🔑, addendum).
// Derives variant + grade from the template string. Commodity from the template
// is best-effort only — objectiveDeclared is the authoritative commodity source.
// We deliberately keep this minimal + local rather than importing logParsers.
// ---------------------------------------------------------------------------

function parseVariant(template: string): MissionVariant {
  const t = template.toLowerCase();
  if (t.includes("singletomulti") || t.includes("single_to_multi"))
    return "SINGLE_TO_MULTI";
  if (
    t.includes("multitosingle") ||
    t.includes("multi2tosingle") ||
    t.includes("multi_to_single")
  )
    return "MULTI_TO_SINGLE";
  if (t.includes("atob") || t.includes("a_to_b")) return "A_TO_B";
  return "MANUAL";
}

function parseGrade(template: string): MissionGrade {
  const t = template.toLowerCase();
  if (t.includes("bulkgrade") || t.includes("bulk")) return "BULK";
  if (t.includes("supplygrade") || t.includes("supply")) return "SUPPLY";
  if (t.includes("smallgrade") || t.includes("small")) return "SMALL";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

interface MissionRow {
  id: string;
  title: string;
  giver: string;
  variant: string;
  grade: string;
  contract_template: string | null;
  contract_definition_id: string | null;
  status: string;
  payout: number | null;
  payout_confidence: string;
  source: string;
  accepted_at: number | null;
  completed_at: number | null;
  notes: string;
  created_seq: number | null;
  session: string;
}

interface LegRow {
  mission_id: string;
  objective_id: string;
  kind: string;
  commodity: string;
  scu_total: number;
  scu_delivered: number;
  location: string | null;
  pos_x: number | null;
  pos_y: number | null;
  pos_z: number | null;
  completed: number;
  manual_override: number | null;
}

function rowToLeg(r: LegRow): Leg {
  const leg: Leg = {
    id: r.objective_id,
    missionId: r.mission_id,
    kind: r.kind as Leg["kind"],
    commodity: r.commodity,
    scuTotal: r.scu_total,
    scuDelivered: r.scu_delivered,
    location: r.location,
    completed: r.completed === 1,
  };
  if (r.pos_x !== null && r.pos_y !== null && r.pos_z !== null) {
    leg.position = { x: r.pos_x, y: r.pos_y, z: r.pos_z };
  }
  return leg;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SqliteMissionStore implements MissionStore {
  private db: DB;
  private readonly dbPath: string;
  private payoutWindowMs: number;
  private seq = 0;
  private recovered = false;
  private readonly onRecover?: (quarantinedTo: string | null) => void;
  /** Source of the event currently being applied (set per applyEvent call). */
  private currentSource: EventSource = "live";

  constructor(opts: MissionStoreOptions) {
    this.dbPath = opts.dbPath;
    this.onRecover = opts.onRecover;
    // Resilient open: detect a malformed image (PRAGMA quick_check or a thrown
    // SQLITE_CORRUPT) and auto-recover by quarantining the bad files aside and
    // recreating a fresh db — the data is re-derivable from the logs, so a
    // corrupt db must never crash the app.
    const result = openDbResilient(
      opts.dbPath,
      (p) => createDb(p),
      (info) => {
        this.onRecover?.(info.quarantinedTo);
      },
    );
    this.db = result.db;
    this.recovered = result.recovered;
    this.payoutWindowMs = opts.payoutWindowMs ?? DEFAULT_PAYOUT_WINDOW_MS;
    this.initSeq();
  }

  /** (Re)derive the monotonic insert counter from the current db. */
  private initSeq(): void {
    const max = this.db
      .prepare("SELECT MAX(created_seq) AS m FROM missions")
      .get() as { m: number | null };
    this.seq = (max.m ?? 0) + 1;
  }

  wasRecovered(): boolean {
    return this.recovered;
  }

  recoverFromCorruption(): string | null {
    // Close the (corrupt) handle so the files can be moved on Windows.
    try {
      this.db.close();
    } catch {
      /* a corrupt handle may throw on close; ignore */
    }
    const quarantinedTo = quarantineDbFiles(this.dbPath);
    this.db = createDb(this.dbPath);
    this.recovered = true;
    this.initSeq();
    this.onRecover?.(quarantinedTo);
    return quarantinedTo;
  }

  guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (!isCorruptionError(err)) throw err;
      const quarantinedTo = this.recoverFromCorruption();
      throw new DatabaseRecoveredError(quarantinedTo);
    }
  }

  // -- event application ----------------------------------------------------

  applyEvent(event: DomainEvent, source: EventSource = "live"): void {
    this.currentSource = source;
    // A live event for a mission first seen in backfill promotes it to the
    // current session (it's genuinely active again), so it surfaces in the
    // Mission List. Live never downgrades to historical (handled in promote()).
    if ("missionId" in event && source === "live") {
      this.promoteToLive(event.missionId);
    }
    switch (event.type) {
      case "missionAccepted":
        return this.onAccepted(event);
      case "missionMarker":
        return this.onMarker(event);
      case "objectiveDeclared":
        return this.onObjectiveDeclared(event);
      case "objectiveCompleted":
        return this.onObjectiveCompleted(event);
      case "missionEnded":
        return this.onMissionEnded(event);
      case "payoutAwarded":
        return this.onPayout(event);
      case "fined":
        return this.onFined(event);
      case "locationInventory":
        // Current-location context is derived/transient; not persisted here.
        return;
    }
  }

  /** Promote an existing historical mission to the live session. No-op if absent or already live. */
  private promoteToLive(missionId: string): void {
    this.db
      .prepare(
        `UPDATE missions SET session = 'live'
           WHERE id = @id AND session <> 'live'`,
      )
      .run({ id: missionId });
  }

  private nextSeq(): number {
    return this.seq++;
  }

  /** Idempotent upsert of the mission shell. Never clobbers richer existing data. */
  private ensureMission(
    id: string,
    defaults: Partial<MissionRow> & { source?: string },
  ): void {
    const existing = this.rawMission(id);
    if (existing) return;
    this.db
      .prepare(
        `INSERT INTO missions
           (id, title, giver, variant, grade, status, payout, payout_confidence,
            source, accepted_at, completed_at, notes, created_seq, session)
         VALUES
           (@id, @title, @giver, @variant, @grade, @status, NULL, 'unknown',
            @source, @accepted_at, NULL, '', @created_seq, @session)`,
      )
      .run({
        id,
        title: defaults.title ?? "",
        giver: defaults.giver ?? "",
        variant: defaults.variant ?? "MANUAL",
        grade: defaults.grade ?? "UNKNOWN",
        status: defaults.status ?? "accepted",
        source: defaults.source ?? "log",
        accepted_at: defaults.accepted_at ?? null,
        created_seq: this.nextSeq(),
        session: this.currentSource,
      });
  }

  private onAccepted(
    e: Extract<DomainEvent, { type: "missionAccepted" }>,
  ): void {
    const existing = this.rawMission(e.missionId);
    if (existing) {
      // Idempotent: fill in title/acceptedAt if we learned them later, but never
      // downgrade a terminal status back to 'accepted'.
      this.db
        .prepare(
          `UPDATE missions
             SET title = CASE WHEN title = '' THEN @title ELSE title END,
                 accepted_at = COALESCE(accepted_at, @ts)
           WHERE id = @id`,
        )
        .run({ id: e.missionId, title: e.title, ts: e.ts });
      return;
    }
    this.ensureMission(e.missionId, {
      title: e.title,
      status: "accepted",
      source: "log",
      accepted_at: e.ts,
    });
  }

  private onMarker(e: Extract<DomainEvent, { type: "missionMarker" }>): void {
    this.ensureMission(e.missionId, {
      giver: e.giver,
      variant: parseVariant(e.contractTemplate),
      grade: parseGrade(e.contractTemplate),
      status: "accepted",
      source: "log",
      accepted_at: e.ts,
    });
    // Set giver/variant/grade/template (idempotent — last marker wins, same data).
    this.db
      .prepare(
        `UPDATE missions
           SET giver = @giver,
               variant = @variant,
               grade = @grade,
               contract_template = @template,
               contract_definition_id = COALESCE(@defId, contract_definition_id)
         WHERE id = @id`,
      )
      .run({
        id: e.missionId,
        giver: e.giver,
        variant: parseVariant(e.contractTemplate),
        grade: parseGrade(e.contractTemplate),
        template: e.contractTemplate,
        defId: e.contractDefinitionId ?? null,
      });
    // Create/locate the leg by (missionId, objectiveId); set kind + position.
    this.upsertLeg(e.missionId, e.objectiveId, {
      kind: e.kind,
      pos: e.position,
    });
  }

  private onObjectiveDeclared(
    e: Extract<DomainEvent, { type: "objectiveDeclared" }>,
  ): void {
    // Authoritative SCU + destination + commodity (when present).
    this.ensureMission(e.missionId, { status: "accepted", source: "log" });
    this.upsertLeg(e.missionId, e.objectiveId, {
      kind: e.kind,
      commodity: e.commodity,
      scuTotal: e.scuTotal,
      location: e.location,
    });
  }

  private onObjectiveCompleted(
    e: Extract<DomainEvent, { type: "objectiveCompleted" }>,
  ): void {
    this.ensureMission(e.missionId, { status: "accepted", source: "log" });
    // Ensure the leg row exists even if we never saw a marker for it.
    this.upsertLeg(e.missionId, e.objectiveId, {});
    // completed=1, scuDelivered := scuTotal. Idempotent.
    //
    // Manual-override guard: a HISTORICAL replay (Reset/Re-sync re-applies the
    // logbackups) must not silently re-complete a leg the user manually toggled
    // this session. If the leg carries a manual_override timestamp, a historical
    // completion is ignored — the user's state wins. Live tailing is append-only
    // so it won't re-fire; a genuinely-new live completion is always honored.
    this.db
      .prepare(
        `UPDATE legs
           SET completed = 1, scu_delivered = scu_total
         WHERE mission_id = @m AND objective_id = @o
           AND NOT (@historical = 1 AND manual_override IS NOT NULL)`,
      )
      .run({
        m: e.missionId,
        o: e.objectiveId,
        historical: this.currentSource === "historical" ? 1 : 0,
      });
    this.recomputeStatus(e.missionId);
  }

  private onMissionEnded(
    e: Extract<DomainEvent, { type: "missionEnded" }>,
  ): void {
    this.ensureMission(e.missionId, { status: "accepted", source: "log" });
    const status: MissionStatus =
      e.completionType === "complete" ? "complete" : "abandoned";
    this.db
      .prepare(
        `UPDATE missions
           SET status = @status,
               completed_at = COALESCE(completed_at, @ts)
         WHERE id = @id`,
      )
      .run({ id: e.missionId, status, ts: e.ts });
  }

  // -- payout attribution (SPEC §4a) ---------------------------------------

  private onPayout(e: Extract<DomainEvent, { type: "payoutAwarded" }>): void {
    // Idempotency: dedupe on (amount, ts). INSERT OR IGNORE — re-applying the
    // same logical award is a no-op, so totals never double-count on replay.
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO earnings (amount, ts, mission_id, confidence)
         VALUES (@amount, @ts, NULL, 'unknown')`,
      )
      .run({ amount: e.amount, ts: e.ts });
    if (inserted.changes === 0) return; // already recorded

    // Candidate hauling missions ended within the window BEFORE this award.
    const candidates = this.db
      .prepare(
        `SELECT id FROM missions
          WHERE status = 'complete'
            AND completed_at IS NOT NULL
            AND completed_at <= @ts
            AND completed_at >= @lo
            AND payout IS NULL
          ORDER BY completed_at ASC`,
      )
      .all({ ts: e.ts, lo: e.ts - this.payoutWindowMs }) as Array<{
      id: string;
    }>;
    const hauling = candidates.filter((c) => {
      const m = this.rawMission(c.id);
      return m ? isHaulingGiver(m.giver) : false;
    });

    if (hauling.length === 0) {
      // 0 -> "other income" bucket. Stays mission_id NULL, still in total.
      return;
    }
    if (hauling.length === 1) {
      // 1 -> confirmed attribution.
      const id = hauling[0].id;
      this.db
        .prepare(
          `UPDATE earnings SET mission_id = @id, confidence = 'confirmed'
             WHERE amount = @amount AND ts = @ts`,
        )
        .run({ id, amount: e.amount, ts: e.ts });
      this.db
        .prepare(
          `UPDATE missions SET payout = @amount, payout_confidence = 'confirmed'
             WHERE id = @id`,
        )
        .run({ id, amount: e.amount });
      return;
    }
    // N>1 -> batch turn-in. Mark each candidate approximate. We cannot pin 1:1
    // (and award count may be < completion count), so attribute this award to
    // the OLDEST still-unpaid candidate as an order-map, confidence 'approximate'.
    // Remaining unmatched candidates stay payout=null until another award lands;
    // if none does, they retain confidence 'approximate' (we set it below) with
    // payout still null -> the UI shows "~ —". Per spec, total always accrues.
    const target = hauling[0].id;
    this.db
      .prepare(
        `UPDATE earnings SET mission_id = @id, confidence = 'approximate'
           WHERE amount = @amount AND ts = @ts`,
      )
      .run({ id: target, amount: e.amount, ts: e.ts });
    this.db
      .prepare(
        `UPDATE missions SET payout = @amount, payout_confidence = 'approximate'
           WHERE id = @id`,
      )
      .run({ id: target, amount: e.amount });
    // Mark the other candidates approximate (payout stays null = "~ unknown amount").
    for (let i = 1; i < hauling.length; i++) {
      this.db
        .prepare(
          `UPDATE missions SET payout_confidence = 'approximate'
             WHERE id = @id AND payout IS NULL`,
        )
        .run({ id: hauling[i].id });
    }
  }

  private onFined(e: Extract<DomainEvent, { type: "fined" }>): void {
    // Tracked separately; never reduces a mission payout. Deduped on (amount, ts).
    this.db
      .prepare(`INSERT OR IGNORE INTO fines (amount, ts) VALUES (@amount, @ts)`)
      .run({ amount: e.amount, ts: e.ts });
  }

  // -- leg upsert + status -------------------------------------------------

  private upsertLeg(
    missionId: string,
    objectiveId: string,
    patch: {
      kind?: Leg["kind"];
      commodity?: string;
      scuTotal?: number;
      location?: string | null;
      pos?: { x: number; y: number; z: number };
    },
  ): void {
    const exists = this.db
      .prepare(`SELECT 1 FROM legs WHERE mission_id = @m AND objective_id = @o`)
      .get({ m: missionId, o: objectiveId });
    if (!exists) {
      this.db
        .prepare(
          `INSERT INTO legs
             (mission_id, objective_id, kind, commodity, scu_total,
              scu_delivered, location, pos_x, pos_y, pos_z, completed)
           VALUES
             (@m, @o, @kind, @commodity, @scuTotal, 0, @location,
              @px, @py, @pz, 0)`,
        )
        .run({
          m: missionId,
          o: objectiveId,
          kind: patch.kind ?? "dropoff",
          commodity: patch.commodity ?? "",
          scuTotal: patch.scuTotal ?? 0,
          location: patch.location ?? null,
          px: patch.pos?.x ?? null,
          py: patch.pos?.y ?? null,
          pz: patch.pos?.z ?? null,
        });
      return;
    }
    // Update only provided fields; COALESCE keeps existing where patch omits.
    // For commodity/location, only overwrite when a non-empty value is given
    // (objectiveDeclared is authoritative; markers must not blank it out).
    //
    // Manual-override guard: a HISTORICAL replay (Reset/Re-sync) must not clobber
    // commodity/scu/location the user filled in this session for a token-suppressed
    // leg. When the leg carries manual_override, the field overwrites are skipped
    // for historical events; the user's values win. (kind/position are structural,
    // not user-edited via the detail panel, so they still reconcile.) Live tailing
    // is append-only and a genuinely-new live declaration is always honored.
    const guard = this.currentSource === "historical" ? 1 : 0;
    this.db
      .prepare(
        `UPDATE legs SET
           kind = COALESCE(@kind, kind),
           commodity = CASE
                         WHEN @guard = 1 AND manual_override IS NOT NULL THEN commodity
                         WHEN @commodity IS NOT NULL AND @commodity <> '' THEN @commodity
                         ELSE commodity END,
           scu_total = CASE
                         WHEN @guard = 1 AND manual_override IS NOT NULL THEN scu_total
                         WHEN @scuTotal IS NOT NULL THEN @scuTotal
                         ELSE scu_total END,
           location = CASE
                        WHEN @guard = 1 AND manual_override IS NOT NULL THEN location
                        WHEN @location IS NOT NULL THEN @location
                        ELSE location END,
           pos_x = COALESCE(@px, pos_x),
           pos_y = COALESCE(@py, pos_y),
           pos_z = COALESCE(@pz, pos_z)
         WHERE mission_id = @m AND objective_id = @o`,
      )
      .run({
        m: missionId,
        o: objectiveId,
        guard,
        kind: patch.kind ?? null,
        commodity: patch.commodity ?? null,
        scuTotal: patch.scuTotal ?? null,
        location: patch.location ?? null,
        px: patch.pos?.x ?? null,
        py: patch.pos?.y ?? null,
        pz: patch.pos?.z ?? null,
      });
  }

  /** accepted -> in_progress once any leg is done; terminal set only by ended. */
  private recomputeStatus(missionId: string): void {
    const m = this.rawMission(missionId);
    if (!m) return;
    if (m.status === "complete" || m.status === "abandoned") return; // terminal
    const done = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM legs WHERE mission_id = @m AND completed = 1`,
      )
      .get({ m: missionId }) as { c: number };
    const next: MissionStatus = done.c > 0 ? "in_progress" : "accepted";
    if (next !== m.status) {
      this.db
        .prepare(`UPDATE missions SET status = @s WHERE id = @id`)
        .run({ s: next, id: missionId });
    }
  }

  // -- manual CRUD ----------------------------------------------------------

  addManualMission(input: ManualMissionInput): Mission {
    const id = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        `INSERT INTO missions
           (id, title, giver, variant, grade, status, payout, payout_confidence,
            source, accepted_at, completed_at, notes, created_seq, session)
         VALUES
           (@id, @title, @giver, 'MANUAL', 'UNKNOWN', @status, NULL, 'unknown',
            'manual', @ts, NULL, '', @seq, 'live')`,
      )
      .run({
        id,
        title: input.title,
        giver: input.giver,
        status: input.status,
        ts: Date.now(),
        seq: this.nextSeq(),
      });
    input.legs.forEach((leg: ManualLegInput, i: number) => {
      this.db
        .prepare(
          `INSERT INTO legs
             (mission_id, objective_id, kind, commodity, scu_total,
              scu_delivered, location, completed)
           VALUES (@m, @o, @kind, @commodity, @scu, 0, @loc, 0)`,
        )
        .run({
          m: id,
          o: `manual_leg_${i}`,
          kind: leg.kind,
          commodity: leg.commodity,
          scu: leg.scuTotal,
          loc: leg.location ?? null,
        });
    });
    return this.getMission(id)!;
  }

  updateMission(missionId: string, patch: MissionPatch): Mission {
    const m = this.rawMission(missionId);
    if (!m) throw new Error(`mission not found: ${missionId}`);

    if (patch.payout !== undefined) {
      // Manual payout edit -> confidence confirmed (SPEC §4a).
      this.db
        .prepare(
          `UPDATE missions SET payout = @p, payout_confidence = 'confirmed'
             WHERE id = @id`,
        )
        .run({ p: patch.payout, id: missionId });
    }
    if (patch.payoutConfidence !== undefined) {
      this.db
        .prepare(`UPDATE missions SET payout_confidence = @c WHERE id = @id`)
        .run({ c: patch.payoutConfidence, id: missionId });
    }
    if (patch.notes !== undefined) {
      this.db
        .prepare(`UPDATE missions SET notes = @n WHERE id = @id`)
        .run({ n: patch.notes, id: missionId });
    }
    if (patch.status !== undefined) {
      const completedAt =
        patch.status === "complete" || patch.status === "abandoned"
          ? Date.now()
          : null;
      this.db
        .prepare(
          `UPDATE missions SET status = @s,
             completed_at = CASE WHEN @s IN ('complete','abandoned')
                                 THEN COALESCE(completed_at, @ca) ELSE NULL END
           WHERE id = @id`,
        )
        .run({ s: patch.status, ca: completedAt, id: missionId });
    }
    if (patch.legs) {
      for (const lp of patch.legs) {
        const sets: string[] = [];
        const params: Record<string, unknown> = {
          m: missionId,
          o: lp.legId,
        };
        if (lp.completed !== undefined) {
          // Bidirectional toggle: completing sets scuDelivered := scuTotal;
          // UN-completing resets scuDelivered := 0 so the leg reads as truly
          // un-delivered everywhere (mission card, detail panel, by-dropoff).
          sets.push("completed = @completed");
          params.completed = lp.completed ? 1 : 0;
          if (lp.scuDelivered === undefined && lp.scuTotal === undefined) {
            sets.push(
              lp.completed ? "scu_delivered = scu_total" : "scu_delivered = 0",
            );
          }
        }
        if (lp.scuDelivered !== undefined) {
          sets.push("scu_delivered = @scuDelivered");
          params.scuDelivered = lp.scuDelivered;
        }
        // Field edits: the user is filling in details the log suppressed (the
        // intermittent objectiveDeclared bug). Unlike upsertLeg's event path,
        // these ALWAYS overwrite — the user is the authority. commodity may be
        // set to "", scuTotal to 0, location to null (clearing a value).
        if (lp.commodity !== undefined) {
          sets.push("commodity = @commodity");
          params.commodity = lp.commodity;
        }
        if (lp.scuTotal !== undefined) {
          sets.push("scu_total = @scuTotal");
          params.scuTotal = lp.scuTotal;
          // Keep a completed leg's delivered figure consistent with its new
          // total unless the caller set scuDelivered explicitly this patch.
          if (lp.scuDelivered === undefined && lp.completed === undefined) {
            sets.push(
              "scu_delivered = CASE WHEN completed = 1 THEN @scuTotal ELSE scu_delivered END",
            );
          } else if (lp.scuDelivered === undefined && lp.completed === true) {
            sets.push("scu_delivered = @scuTotal");
          }
        }
        if (lp.location !== undefined) {
          sets.push("location = @location");
          params.location = lp.location;
        }
        // ANY leg patch here is a USER action (LegRow / CommodityLine / detail
        // panel toggle OR a field edit). Stamp manual_override so a later
        // HISTORICAL replay (Reset/Re-sync) cannot clobber this manual state.
        // (See onObjectiveCompleted.)
        if (sets.length > 0) {
          sets.push("manual_override = @overrideTs");
          params.overrideTs = Date.now();
          this.db
            .prepare(
              `UPDATE legs SET ${sets.join(", ")}
                 WHERE mission_id = @m AND objective_id = @o`,
            )
            .run(params);
        }
      }
    }
    // Remove legs (Mission Detail panel ✕). Keyed by (missionId, objectiveId)
    // so we never touch a same-objectiveId leg on another mission (SPEC §2 🔑).
    if (patch.removeLegIds && patch.removeLegIds.length > 0) {
      const del = this.db.prepare(
        `DELETE FROM legs WHERE mission_id = @m AND objective_id = @o`,
      );
      for (const legId of patch.removeLegIds) {
        del.run({ m: missionId, o: legId });
      }
    }
    // Add new legs. Generate a STABLE, unique objective_id per (missionId,
    // objectiveId) PK. A user-added leg is a manual action -> stamp
    // manual_override so a later historical replay can't clobber it.
    if (patch.addLegs && patch.addLegs.length > 0) {
      const existing = new Set(
        (
          this.db
            .prepare(`SELECT objective_id FROM legs WHERE mission_id = @m`)
            .all({ m: missionId }) as { objective_id: string }[]
        ).map((r) => r.objective_id),
      );
      const insert = this.db.prepare(
        `INSERT INTO legs
           (mission_id, objective_id, kind, commodity, scu_total,
            scu_delivered, location, completed, manual_override)
         VALUES (@m, @o, @kind, @commodity, @scu, 0, @loc, 0, @ov)`,
      );
      const ts = Date.now();
      patch.addLegs.forEach((leg, i) => {
        // Unique within (missionId, objectiveId): timestamp + index, retried
        // against the existing set on the (vanishingly unlikely) collision.
        let oid = `manual_${leg.kind}_${ts}_${i}`;
        let n = i;
        while (existing.has(oid)) {
          n += 1;
          oid = `manual_${leg.kind}_${ts}_${n}`;
        }
        existing.add(oid);
        insert.run({
          m: missionId,
          o: oid,
          kind: leg.kind,
          commodity: leg.commodity ?? "",
          scu: leg.scuTotal ?? 0,
          loc: leg.location ?? null,
          ov: ts,
        });
      });
    }
    if (
      patch.legs ||
      (patch.removeLegIds && patch.removeLegIds.length > 0) ||
      (patch.addLegs && patch.addLegs.length > 0)
    ) {
      this.recomputeStatus(missionId);
    }
    return this.getMission(missionId)!;
  }

  toggleLeg(missionId: string, legId: string, completed: boolean): Mission {
    return this.updateMission(missionId, {
      legs: [{ legId, completed }],
    });
  }

  abandon(missionId: string): Mission {
    const m = this.rawMission(missionId);
    if (!m) throw new Error(`mission not found: ${missionId}`);
    this.db
      .prepare(
        `UPDATE missions SET status = 'abandoned',
           completed_at = COALESCE(completed_at, @ts) WHERE id = @id`,
      )
      .run({ ts: Date.now(), id: missionId });
    return this.getMission(missionId)!;
  }

  abandonMission(missionId: string): void {
    this.db
      .prepare(`DELETE FROM missions WHERE id = @id`)
      .run({ id: missionId });
  }

  setPayout(missionId: string, amount: number | null): Mission {
    return this.updateMission(missionId, { payout: amount });
  }

  // -- reads ----------------------------------------------------------------

  private rawMission(id: string): MissionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM missions WHERE id = @id`)
      .get({ id }) as MissionRow | undefined;
  }

  private legsFor(missionId: string): Leg[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM legs WHERE mission_id = @m
           ORDER BY kind DESC, objective_id ASC`,
      )
      .all({ m: missionId }) as LegRow[];
    return rows.map(rowToLeg);
  }

  private rowToMission(r: MissionRow): Mission {
    return {
      id: r.id,
      title: r.title,
      giver: r.giver,
      variant: r.variant as MissionVariant,
      grade: r.grade as MissionGrade,
      contractTemplate: r.contract_template ?? undefined,
      contractDefinitionId: r.contract_definition_id ?? undefined,
      status: r.status as MissionStatus,
      payout: r.payout,
      payoutConfidence: r.payout_confidence as PayoutConfidence,
      source: r.source as Mission["source"],
      acceptedAt: r.accepted_at,
      completedAt: r.completed_at,
      notes: r.notes,
      legs: this.legsFor(r.id),
    };
  }

  getMission(id: string): Mission | undefined {
    const r = this.rawMission(id);
    return r ? this.rowToMission(r) : undefined;
  }

  listMissions(): Mission[] {
    const rows = this.db
      .prepare(`SELECT * FROM missions ORDER BY created_seq DESC`)
      .all() as MissionRow[];
    return rows.map((r) => this.rowToMission(r));
  }

  activeMissions(): Mission[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM missions
           WHERE session = 'live'
             AND status NOT IN ('complete', 'abandoned')
           ORDER BY created_seq DESC`,
      )
      .all() as MissionRow[];
    return rows.map((r) => this.rowToMission(r));
  }

  clearActiveMissions(): number {
    // Hard-delete live, non-terminal missions (legs cascade). History stays.
    const info = this.db
      .prepare(
        `DELETE FROM missions
           WHERE session = 'live'
             AND status NOT IN ('complete', 'abandoned')`,
      )
      .run();
    return info.changes;
  }

  resetAllData(): number {
    // Wipe mission data so backfill can repopulate under corrected rules. The
    // UEX reference cache (uex_cache) is intentionally preserved. FK cascade
    // clears legs when missions go, but earnings/fines have no FK -> clear them
    // explicitly. Wrapped in a transaction for atomicity.
    const removed = this.db.transaction(() => {
      const info = this.db.prepare(`DELETE FROM missions`).run();
      this.db.prepare(`DELETE FROM legs`).run();
      this.db.prepare(`DELETE FROM earnings`).run();
      this.db.prepare(`DELETE FROM fines`).run();
      return info.changes;
    })();
    return removed;
  }

  history(): Mission[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM missions
           WHERE status IN ('complete', 'abandoned')
           ORDER BY COALESCE(completed_at, 0) DESC, created_seq DESC`,
      )
      .all() as MissionRow[];
    return rows.map((r) => this.rowToMission(r));
  }

  // -- derived: by-dropoff aggregation -------------------------------------

  dropoffGroups(currentLocation: string | null): DropoffGroup[] {
    // Active missions = current session ('live') AND not terminal. Historical
    // non-terminal missions are stale and excluded (same rule as the Mission
    // List). Only dropoff legs with a known location feed the aggregation.
    const rows = this.db
      .prepare(
        `SELECT l.* FROM legs l
           JOIN missions m ON m.id = l.mission_id
          WHERE l.kind = 'dropoff'
            AND l.location IS NOT NULL
            AND m.session = 'live'
            AND m.status NOT IN ('complete', 'abandoned')`,
      )
      .all() as LegRow[];

    // Group by location -> commodity.
    const byLoc = new Map<
      string,
      Map<string, { remaining: number; delivered: number; refs: LegRef[] }>
    >();
    for (const r of rows) {
      const loc = r.location as string;
      const commodity = r.commodity || "(unknown)";
      if (!byLoc.has(loc)) byLoc.set(loc, new Map());
      const byComm = byLoc.get(loc)!;
      if (!byComm.has(commodity))
        byComm.set(commodity, { remaining: 0, delivered: 0, refs: [] });
      const cell = byComm.get(commodity)!;
      const delivered = r.completed === 1 ? r.scu_total : r.scu_delivered;
      const remaining = Math.max(0, r.scu_total - delivered);
      cell.remaining += remaining;
      cell.delivered += delivered;
      cell.refs.push({ missionId: r.mission_id, legId: r.objective_id });
    }

    const groups: DropoffGroup[] = [];
    for (const [location, byComm] of byLoc) {
      const todo: DropoffCommodity[] = [];
      const delivered: DropoffCommodity[] = [];
      let scuRemaining = 0;
      let scuTotal = 0;
      for (const [commodity, cell] of byComm) {
        const line: DropoffCommodity = {
          commodity,
          scuRemaining: cell.remaining,
          scuDelivered: cell.delivered,
          legRefs: cell.refs,
        };
        scuRemaining += cell.remaining;
        scuTotal += cell.remaining + cell.delivered;
        if (cell.remaining > 0) todo.push(line);
        else delivered.push(line);
      }
      const pctDelivered =
        scuTotal > 0
          ? Math.round(((scuTotal - scuRemaining) / scuTotal) * 100)
          : 0;
      groups.push({
        location,
        todo: todo.sort((a, b) => a.commodity.localeCompare(b.commodity)),
        delivered: delivered.sort((a, b) =>
          a.commodity.localeCompare(b.commodity),
        ),
        scuRemaining,
        scuTotal,
        pctDelivered,
        allDone: scuRemaining === 0,
        isCurrentLocation: isConfidentLocationMatch(currentLocation, location),
      });
    }
    // Stable order: stops with work first, then alphabetical.
    return groups.sort((a, b) => {
      if (a.allDone !== b.allDone) return a.allDone ? 1 : -1;
      return a.location.localeCompare(b.location);
    });
  }

  // -- derived: lifetime totals --------------------------------------------

  totals(): Totals {
    const completed = this.db
      .prepare(`SELECT COUNT(*) AS c FROM missions WHERE status = 'complete'`)
      .get() as { c: number };

    // SCU hauled = delivered SCU across completed missions' legs.
    const scu = this.db
      .prepare(
        `SELECT COALESCE(SUM(
            CASE WHEN l.completed = 1 THEN l.scu_total ELSE l.scu_delivered END
          ), 0) AS s
         FROM legs l
         JOIN missions m ON m.id = l.mission_id
        WHERE m.status = 'complete'`,
      )
      .get() as { s: number };

    // Total credits earned = every recorded award (attributed or not).
    const credits = this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM earnings`)
      .get() as { s: number };

    const fines = this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM fines`)
      .get() as { s: number };

    return {
      missionsCompleted: completed.c,
      scuHauled: scu.s,
      creditsEarned: credits.s,
      finesTotal: fines.s,
    };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (or create) the mission store backed by better-sqlite3.
 */
export function openMissionStore(options: MissionStoreOptions): MissionStore {
  return new SqliteMissionStore(options);
}
