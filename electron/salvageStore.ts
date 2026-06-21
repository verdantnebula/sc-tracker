// ============================================================================
// salvageStore.ts — salvage run state + better-sqlite3 persistence.
// ----------------------------------------------------------------------------
// The source of truth for SALVAGE runs (separate domain from missionStore — its
// own tables, its own IPC channels). Mirrors missionStore's resilient-open and
// row<->domain mapping patterns, but the salvage model is simpler:
//
//   - One run = a stripping session (materials + stripped components + wrecks).
//   - At most ONE 'active' run at a time (creating a new run does not auto-close
//     an existing active one; the caller decides — see createRun docs).
//   - Payout is the pure computeSalvageTotals() over the run + material prices.
//
// The salvage tables (salvage_runs / salvage_stripped / salvage_wrecks) are
// ADDITIVE (schema v4) — cargo tables are never touched.
// ============================================================================

import type {
  SalvageRun,
  SalvageRunInput,
  SalvageRunPatch,
  SalvageRunStatus,
  StrippedComponent,
  StrippedComponentInput,
  StrippedComponentPatch,
  SalvageComponentType,
  Wreck,
} from "@shared/types";
import type { Database as DB } from "better-sqlite3";
import { createDb } from "./db/schema";
import { openDbResilient } from "./db/recovery";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface SalvageStore {
  /** All runs, newest first. */
  listRuns(): SalvageRun[];
  /** The single active run (status='active'), newest if somehow >1, or null. */
  getActiveRun(): SalvageRun | null;
  /** A run by id, or undefined. */
  getRun(id: string): SalvageRun | undefined;
  /** Create + persist a new active run. Returns the created run. */
  createRun(input: SalvageRunInput): SalvageRun;
  /** Patch materials / crewSize / notes / status. Returns the updated run. */
  updateRun(runId: string, patch: SalvageRunPatch): SalvageRun;
  /** Add a stripped component to a run. Returns the updated run. */
  addStripped(runId: string, input: StrippedComponentInput): SalvageRun;
  /** Patch a stripped component. Returns the updated run. */
  updateStripped(
    runId: string,
    componentId: string,
    patch: StrippedComponentPatch,
  ): SalvageRun;
  /** Remove a stripped component. Returns the updated run. */
  removeStripped(runId: string, componentId: string): SalvageRun;
  /** Mark a run sold (terminal). Returns the updated run. */
  completeRun(runId: string): SalvageRun;
  /** Hard-delete a run (components/wrecks cascade). */
  deleteRun(runId: string): void;
  /** Close the underlying database handle. */
  close(): void;
}

export interface SalvageStoreOptions {
  /** Absolute path to the sqlite db file. ':memory:' for tests. */
  dbPath: string;
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  started_at: number;
  completed_at: number | null;
  status: string;
  crew_size: number;
  notes: string;
  rmc_scu: number;
  cmat_scu: number;
  construction_scu: number;
  created_seq: number | null;
}

interface StrippedRow {
  id: string;
  run_id: string;
  type: string;
  model: string;
  qty: number;
  sell_price_each: number;
  sold: number;
}

interface WreckRow {
  id: string;
  run_id: string;
  ship_name: string;
  claim_cost_tier: number | null;
  claim_cost: number | null;
  notes: string;
}

function rowToStripped(r: StrippedRow): StrippedComponent {
  return {
    id: r.id,
    runId: r.run_id,
    type: r.type as SalvageComponentType,
    model: r.model,
    qty: r.qty,
    sellPriceEach: r.sell_price_each,
    sold: r.sold === 1,
  };
}

function rowToWreck(r: WreckRow): Wreck {
  return {
    id: r.id,
    runId: r.run_id,
    shipName: r.ship_name,
    claimCostTier: r.claim_cost_tier,
    claimCost: r.claim_cost,
    notes: r.notes,
  };
}

const VALID_STATUS = new Set<SalvageRunStatus>(["active", "sold", "abandoned"]);

function normalizeStatus(s: unknown): SalvageRunStatus {
  return VALID_STATUS.has(s as SalvageRunStatus)
    ? (s as SalvageRunStatus)
    : "active";
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SqliteSalvageStore implements SalvageStore {
  private db: DB;
  private seq = 0;

  constructor(opts: SalvageStoreOptions) {
    // Resilient open mirrors missionStore: a malformed image quarantines aside
    // and recreates fresh (salvage data is user-entered, but a corrupt DB must
    // never crash the app — an empty fresh DB is the safe fallback).
    const result = openDbResilient(opts.dbPath, (p) => createDb(p));
    this.db = result.db;
    this.initSeq();
  }

  private initSeq(): void {
    const max = this.db
      .prepare(
        `SELECT MAX(s) AS m FROM (
           SELECT MAX(created_seq) AS s FROM salvage_runs
           UNION ALL SELECT MAX(created_seq) FROM salvage_stripped
           UNION ALL SELECT MAX(created_seq) FROM salvage_wrecks
         )`,
      )
      .get() as { m: number | null };
    this.seq = (max.m ?? 0) + 1;
  }

  private nextSeq(): number {
    return this.seq++;
  }

  private uid(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // -- reads ----------------------------------------------------------------

  private rawRun(id: string): RunRow | undefined {
    return this.db
      .prepare(`SELECT * FROM salvage_runs WHERE id = @id`)
      .get({ id }) as RunRow | undefined;
  }

  private strippedFor(runId: string): StrippedComponent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM salvage_stripped WHERE run_id = @r
           ORDER BY created_seq ASC`,
      )
      .all({ r: runId }) as StrippedRow[];
    return rows.map(rowToStripped);
  }

  private wrecksFor(runId: string): Wreck[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM salvage_wrecks WHERE run_id = @r ORDER BY created_seq ASC`,
      )
      .all({ r: runId }) as WreckRow[];
    return rows.map(rowToWreck);
  }

  private rowToRun(r: RunRow): SalvageRun {
    return {
      id: r.id,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      status: normalizeStatus(r.status),
      crewSize: r.crew_size,
      notes: r.notes,
      rmcScu: r.rmc_scu,
      cmatScu: r.cmat_scu,
      constructionScu: r.construction_scu,
      stripped: this.strippedFor(r.id),
      wrecks: this.wrecksFor(r.id),
    };
  }

  getRun(id: string): SalvageRun | undefined {
    const r = this.rawRun(id);
    return r ? this.rowToRun(r) : undefined;
  }

  listRuns(): SalvageRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM salvage_runs ORDER BY created_seq DESC`)
      .all() as RunRow[];
    return rows.map((r) => this.rowToRun(r));
  }

  getActiveRun(): SalvageRun | null {
    const r = this.db
      .prepare(
        `SELECT * FROM salvage_runs WHERE status = 'active'
           ORDER BY created_seq DESC LIMIT 1`,
      )
      .get() as RunRow | undefined;
    return r ? this.rowToRun(r) : null;
  }

  // -- mutations ------------------------------------------------------------

  createRun(input: SalvageRunInput): SalvageRun {
    const id = this.uid("run");
    this.db
      .prepare(
        `INSERT INTO salvage_runs
           (id, started_at, completed_at, status, crew_size, notes,
            rmc_scu, cmat_scu, construction_scu, created_seq)
         VALUES
           (@id, @started, NULL, 'active', @crew, @notes,
            @rmc, @cmat, @construction, @seq)`,
      )
      .run({
        id,
        started: Date.now(),
        crew: Math.max(1, Math.trunc(input.crewSize ?? 1)),
        notes: input.notes ?? "",
        rmc: input.rmcScu ?? 0,
        cmat: input.cmatScu ?? 0,
        construction: input.constructionScu ?? 0,
        seq: this.nextSeq(),
      });
    return this.getRun(id)!;
  }

  updateRun(runId: string, patch: SalvageRunPatch): SalvageRun {
    const r = this.rawRun(runId);
    if (!r) throw new Error(`salvage run not found: ${runId}`);

    const sets: string[] = [];
    const params: Record<string, unknown> = { id: runId };

    if (patch.crewSize !== undefined) {
      sets.push("crew_size = @crew");
      params.crew = Math.max(1, Math.trunc(patch.crewSize));
    }
    if (patch.notes !== undefined) {
      sets.push("notes = @notes");
      params.notes = patch.notes;
    }
    if (patch.rmcScu !== undefined) {
      sets.push("rmc_scu = @rmc");
      params.rmc = patch.rmcScu;
    }
    if (patch.cmatScu !== undefined) {
      sets.push("cmat_scu = @cmat");
      params.cmat = patch.cmatScu;
    }
    if (patch.constructionScu !== undefined) {
      sets.push("construction_scu = @construction");
      params.construction = patch.constructionScu;
    }
    if (patch.status !== undefined) {
      const status = normalizeStatus(patch.status);
      sets.push("status = @status");
      params.status = status;
      // Stamp/clear completed_at on the terminal/active transition.
      const terminal = status === "sold" || status === "abandoned";
      sets.push(
        terminal
          ? "completed_at = COALESCE(completed_at, @ca)"
          : "completed_at = NULL",
      );
      params.ca = terminal ? Date.now() : null;
    }

    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE salvage_runs SET ${sets.join(", ")} WHERE id = @id`)
        .run(params);
    }
    return this.getRun(runId)!;
  }

  addStripped(runId: string, input: StrippedComponentInput): SalvageRun {
    if (!this.rawRun(runId)) throw new Error(`salvage run not found: ${runId}`);
    const id = this.uid("strip");
    this.db
      .prepare(
        `INSERT INTO salvage_stripped
           (id, run_id, type, model, qty, sell_price_each, sold, created_seq)
         VALUES (@id, @run, @type, @model, @qty, @price, @sold, @seq)`,
      )
      .run({
        id,
        run: runId,
        type: input.type,
        model: input.model,
        qty: Math.max(0, Math.trunc(input.qty)),
        price: Math.max(0, Math.trunc(input.sellPriceEach)),
        sold: input.sold ? 1 : 0,
        seq: this.nextSeq(),
      });
    return this.getRun(runId)!;
  }

  updateStripped(
    runId: string,
    componentId: string,
    patch: StrippedComponentPatch,
  ): SalvageRun {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: componentId, run: runId };
    if (patch.type !== undefined) {
      sets.push("type = @type");
      params.type = patch.type;
    }
    if (patch.model !== undefined) {
      sets.push("model = @model");
      params.model = patch.model;
    }
    if (patch.qty !== undefined) {
      sets.push("qty = @qty");
      params.qty = Math.max(0, Math.trunc(patch.qty));
    }
    if (patch.sellPriceEach !== undefined) {
      sets.push("sell_price_each = @price");
      params.price = Math.max(0, Math.trunc(patch.sellPriceEach));
    }
    if (patch.sold !== undefined) {
      sets.push("sold = @sold");
      params.sold = patch.sold ? 1 : 0;
    }
    if (sets.length > 0) {
      this.db
        .prepare(
          `UPDATE salvage_stripped SET ${sets.join(", ")}
             WHERE id = @id AND run_id = @run`,
        )
        .run(params);
    }
    const run = this.getRun(runId);
    if (!run) throw new Error(`salvage run not found: ${runId}`);
    return run;
  }

  removeStripped(runId: string, componentId: string): SalvageRun {
    this.db
      .prepare(`DELETE FROM salvage_stripped WHERE id = @id AND run_id = @run`)
      .run({ id: componentId, run: runId });
    const run = this.getRun(runId);
    if (!run) throw new Error(`salvage run not found: ${runId}`);
    return run;
  }

  completeRun(runId: string): SalvageRun {
    return this.updateRun(runId, { status: "sold" });
  }

  deleteRun(runId: string): void {
    // FK cascade clears stripped + wrecks.
    this.db
      .prepare(`DELETE FROM salvage_runs WHERE id = @id`)
      .run({ id: runId });
  }

  close(): void {
    this.db.close();
  }
}

/** Open (or create) the salvage store backed by better-sqlite3. */
export function openSalvageStore(options: SalvageStoreOptions): SalvageStore {
  return new SqliteSalvageStore(options);
}
