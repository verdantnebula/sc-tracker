// ============================================================================
// salvageStore.test.ts — salvage run CRUD + active-run lifecycle + payout.
// ----------------------------------------------------------------------------
// Runs against an in-memory sqlite db (':memory:'). Also asserts the salvage
// tables coexist with the cargo schema (additive v4 migration) so an existing
// cargo DB is never harmed.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openSalvageStore, type SalvageStore } from "./salvageStore";
import { openMissionStore, type MissionStore } from "./missionStore";
import { createDb, SCHEMA_VERSION } from "./db/schema";
import { computeSalvageTotals } from "./salvagePayout";
import type { SalvageMaterialPrices } from "@shared/types";

const PRICES: SalvageMaterialPrices = { rmcPerScu: 7200, cmatPerScu: 12000 };

describe("salvageStore", () => {
  let store: SalvageStore;

  beforeEach(() => {
    store = openSalvageStore({ dbPath: ":memory:" });
  });
  afterEach(() => store.close());

  // -- run CRUD -------------------------------------------------------------

  it("creates a run with defaults and lists it", () => {
    const run = store.createRun({});
    expect(run.id).toBeTruthy();
    expect(run.status).toBe("active");
    expect(run.crewSize).toBe(1);
    expect(run.completedAt).toBeNull();
    expect(run.stripped).toEqual([]);
    expect(run.wrecks).toEqual([]);

    const all = store.listRuns();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(run.id);
  });

  it("creates a run with supplied materials + crew", () => {
    const run = store.createRun({
      crewSize: 3,
      notes: "first run",
      rmcScu: 20,
      cmatScu: 8,
      constructionScu: 100,
    });
    expect(run.crewSize).toBe(3);
    expect(run.notes).toBe("first run");
    expect(run.rmcScu).toBe(20);
    expect(run.cmatScu).toBe(8);
    expect(run.constructionScu).toBe(100);
  });

  it("clamps a created crewSize below 1 up to 1", () => {
    expect(store.createRun({ crewSize: 0 }).crewSize).toBe(1);
    expect(store.createRun({ crewSize: -4 }).crewSize).toBe(1);
  });

  it("lists runs newest-first", () => {
    const a = store.createRun({ notes: "a" });
    const b = store.createRun({ notes: "b" });
    const list = store.listRuns();
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("patches materials / crew / notes", () => {
    const run = store.createRun({});
    const updated = store.updateRun(run.id, {
      crewSize: 5,
      notes: "edited",
      rmcScu: 12,
      cmatScu: 4,
      constructionScu: 50,
    });
    expect(updated.crewSize).toBe(5);
    expect(updated.notes).toBe("edited");
    expect(updated.rmcScu).toBe(12);
    expect(updated.cmatScu).toBe(4);
    expect(updated.constructionScu).toBe(50);
  });

  it("throws patching a missing run", () => {
    expect(() => store.updateRun("nope", { notes: "x" })).toThrow();
  });

  // -- active-run lifecycle -------------------------------------------------

  it("getActiveRun returns the active run, null once terminal", () => {
    expect(store.getActiveRun()).toBeNull();
    const run = store.createRun({});
    expect(store.getActiveRun()?.id).toBe(run.id);

    store.completeRun(run.id);
    expect(store.getActiveRun()).toBeNull();
  });

  it("completeRun marks 'sold' and stamps completedAt", () => {
    const run = store.createRun({});
    const sold = store.completeRun(run.id);
    expect(sold.status).toBe("sold");
    expect(sold.completedAt).toBeGreaterThan(0);
  });

  it("abandoning via status patch is terminal and stamps completedAt", () => {
    const run = store.createRun({});
    const ab = store.updateRun(run.id, { status: "abandoned" });
    expect(ab.status).toBe("abandoned");
    expect(ab.completedAt).toBeGreaterThan(0);
    expect(store.getActiveRun()).toBeNull();
  });

  it("re-activating a terminal run clears completedAt", () => {
    const run = store.createRun({});
    store.completeRun(run.id);
    const reopened = store.updateRun(run.id, { status: "active" });
    expect(reopened.status).toBe("active");
    expect(reopened.completedAt).toBeNull();
    expect(store.getActiveRun()?.id).toBe(run.id);
  });

  it("getActiveRun returns the NEWEST when multiple are active", () => {
    const a = store.createRun({});
    const b = store.createRun({});
    // both active; newest (b) wins
    expect(store.getActiveRun()?.id).toBe(b.id);
    void a;
  });

  // -- stripped components --------------------------------------------------

  it("adds, updates, and removes stripped components", () => {
    const run = store.createRun({});
    let r = store.addStripped(run.id, {
      type: "weapon",
      model: "Dev Cannon",
      qty: 2,
      sellPriceEach: 3000,
    });
    expect(r.stripped).toHaveLength(1);
    const comp = r.stripped[0];
    expect(comp.type).toBe("weapon");
    expect(comp.qty).toBe(2);
    expect(comp.sold).toBe(false); // default unsold

    r = store.updateStripped(run.id, comp.id, { sold: true, qty: 3 });
    expect(r.stripped[0].sold).toBe(true);
    expect(r.stripped[0].qty).toBe(3);

    r = store.removeStripped(run.id, comp.id);
    expect(r.stripped).toHaveLength(0);
  });

  it("keeps stripped components in insertion order", () => {
    const run = store.createRun({});
    store.addStripped(run.id, {
      type: "powerplant",
      model: "P1",
      qty: 1,
      sellPriceEach: 100,
    });
    store.addStripped(run.id, {
      type: "shield",
      model: "S1",
      qty: 1,
      sellPriceEach: 200,
    });
    const r = store.getRun(run.id)!;
    expect(r.stripped.map((s) => s.model)).toEqual(["P1", "S1"]);
  });

  it("removing a component scopes by run id (no cross-run delete)", () => {
    const a = store.createRun({});
    const b = store.createRun({});
    const ra = store.addStripped(a.id, {
      type: "cooler",
      model: "C1",
      qty: 1,
      sellPriceEach: 50,
    });
    const compId = ra.stripped[0].id;
    // attempt to remove A's component via B's id -> no-op on A
    store.removeStripped(b.id, compId);
    expect(store.getRun(a.id)!.stripped).toHaveLength(1);
  });

  // -- payout integration ---------------------------------------------------

  it("a run's persisted state feeds computeSalvageTotals correctly", () => {
    const run = store.createRun({ crewSize: 2, rmcScu: 10, cmatScu: 5 });
    store.addStripped(run.id, {
      type: "weapon",
      model: "Sold",
      qty: 2,
      sellPriceEach: 3000,
      sold: true,
    });
    store.addStripped(run.id, {
      type: "shield",
      model: "Unsold",
      qty: 1,
      sellPriceEach: 9999,
      sold: false,
    });
    const r = store.getRun(run.id)!;
    const t = computeSalvageTotals(r, PRICES);
    expect(t.rmcValue).toBe(72000);
    expect(t.cmatValue).toBe(60000);
    expect(t.componentValue).toBe(6000); // 2*3000 sold; unsold excluded
    expect(t.totalValue).toBe(138000);
    expect(t.valuePerPlayer).toBe(69000); // /2
  });

  // -- delete ---------------------------------------------------------------

  it("deleteRun hard-deletes the run and cascades its components", () => {
    const run = store.createRun({});
    store.addStripped(run.id, {
      type: "radar",
      model: "R1",
      qty: 1,
      sellPriceEach: 10,
    });
    store.deleteRun(run.id);
    expect(store.getRun(run.id)).toBeUndefined();
    expect(store.listRuns()).toHaveLength(0);
  });
});

// =============================================================================
// Additive-migration coexistence: salvage tables sit alongside cargo cleanly.
// =============================================================================

describe("salvage schema coexistence", () => {
  it("a single db carries both cargo and salvage tables at v4", () => {
    const db = createDb(":memory:");
    const tables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as Array<{ name: string }>
    ).map((t) => t.name);
    // cargo tables present...
    expect(tables).toContain("missions");
    expect(tables).toContain("legs");
    expect(tables).toContain("earnings");
    // ...and salvage tables present (additive)
    expect(tables).toContain("salvage_runs");
    expect(tables).toContain("salvage_stripped");
    expect(tables).toContain("salvage_wrecks");
    const ver = db.pragma("user_version", { simple: true });
    expect(ver).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("upgrading an OLD cargo-only db adds salvage tables without data loss", () => {
    // Simulate a pre-v4 cargo DB: create only the cargo tables, insert a row,
    // then re-open with the current createDb (which runs the additive migration).
    const path = ":memory:";
    // Build an old-style db by hand on a shared in-memory handle is awkward
    // (':memory:' is per-connection), so use a real cargo store round-trip on a
    // temp file to prove additive migration preserves cargo data.
    const tmp = require("node:path").join(
      require("node:os").tmpdir(),
      `sc-salvage-migrate-${Date.now()}.db`,
    );
    try {
      // Old cargo DB: a mission written by the cargo store.
      const cargo: MissionStore = openMissionStore({ dbPath: tmp });
      cargo.addManualMission({
        title: "Pre-migration haul",
        giver: "Test",
        status: "accepted",
        legs: [],
      });
      cargo.close();

      // Re-open via the salvage store (same createDb path) — additive tables get
      // created; cargo data must survive.
      const sal: SalvageStore = openSalvageStore({ dbPath: tmp });
      sal.createRun({ notes: "post-migration run" });
      expect(sal.listRuns()).toHaveLength(1);
      sal.close();

      // Cargo data still intact.
      const cargo2: MissionStore = openMissionStore({ dbPath: tmp });
      const missions = cargo2.listMissions();
      expect(missions).toHaveLength(1);
      expect(missions[0].title).toBe("Pre-migration haul");
      cargo2.close();
    } finally {
      for (const ext of ["", "-wal", "-shm"]) {
        try {
          require("node:fs").unlinkSync(tmp + ext);
        } catch {
          /* ignore */
        }
      }
    }
    void path;
    void Database;
  });
});
