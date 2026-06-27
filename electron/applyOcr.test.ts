// ============================================================================
// applyOcr.test.ts — semantic MERGE of OCR'd objectives into existing legs
// ----------------------------------------------------------------------------
// Bug 1a: applying OCR built MissionPatch.addLegs, which INSERTed brand-new legs
// and left the original SUPPRESSED PLACEHOLDER legs (game objectiveId, empty
// commodity, scuTotal 0, location null) untouched — producing duplicates. The
// fix is `applyOcrObjectives`, which FILLS the placeholders in place instead.
//
// All fixtures are synthetic, in-memory sqlite (':memory:') except the explicit
// on-disk restart test, which uses an isolated temp path (NEVER the live DB).
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { DomainEvent } from "@shared/events";
import { openMissionStore, type MissionStore } from "./missionStore";

let store: MissionStore;

beforeEach(() => {
  store = openMissionStore({ dbPath: ":memory:", payoutWindowMs: 2000 });
});
afterEach(() => {
  store.close();
});

// --- synthetic builders ------------------------------------------------------

const accepted = (missionId: string, title = "Haul"): DomainEvent => ({
  type: "missionAccepted",
  missionId,
  title,
  ts: 1000,
});

/** A suppressed placeholder leg: marker only (no objectiveDeclared), so it has
 *  the GAME objectiveId, empty commodity, scuTotal 0, location null. */
const marker = (
  missionId: string,
  objectiveId: string,
  kind: "pickup" | "dropoff",
  contractTemplate = "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
): DomainEvent => ({
  type: "missionMarker",
  missionId,
  giver: "Covalex_Hauling",
  contractTemplate,
  objectiveId,
  kind,
  ts: 1000,
});

/** Seed a mission with N suppressed placeholder legs of the given kind, keyed
 *  on stable game objectiveIds (`<kind>_<i>`). Returns the store for chaining. */
function seedPlaceholders(
  missionId: string,
  legs: { kind: "pickup" | "dropoff"; objectiveId: string }[],
): void {
  store.applyEvent(accepted(missionId), "live");
  for (const l of legs) {
    store.applyEvent(marker(missionId, l.objectiveId, l.kind), "live");
  }
}

// =============================================================================
// Fill placeholders (the core fix)
// =============================================================================

describe("applyOcrObjectives — fills suppressed placeholders in place", () => {
  it("fills a placeholder leg and PRESERVES its game objectiveId (no dup)", () => {
    seedPlaceholders("m1", [{ kind: "dropoff", objectiveId: "dropoff_a_0" }]);
    expect(store.getMission("m1")!.legs.length).toBe(1);

    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Titanium", scu: 32, location: "Area18" },
    ]);

    const m = store.getMission("m1")!;
    // Still ONE leg — filled, not duplicated.
    expect(m.legs.length).toBe(1);
    const leg = m.legs[0];
    expect(leg.id).toBe("dropoff_a_0"); // game objectiveId preserved
    expect(leg.commodity).toBe("Titanium");
    expect(leg.scuTotal).toBe(32);
    expect(leg.location).toBe("Area18");
    expect(leg.completed).toBe(false);
  });

  it("matches the SAME kind only (a pickup OCR obj does not fill a dropoff leg)", () => {
    seedPlaceholders("m1", [
      { kind: "dropoff", objectiveId: "dropoff_a_0" },
      { kind: "pickup", objectiveId: "pickup_a_0" },
    ]);

    store.applyOcrObjectives("m1", [
      { kind: "pickup", commodity: "Iron", scu: 10, location: "Lorville" },
    ]);

    const m = store.getMission("m1")!;
    // dropoff placeholder UNMATCHED -> pruned; pickup placeholder filled.
    expect(m.legs.length).toBe(1);
    const leg = m.legs[0];
    expect(leg.kind).toBe("pickup");
    expect(leg.id).toBe("pickup_a_0");
    expect(leg.commodity).toBe("Iron");
  });

  it("multiplicity: 4 same-commodity dropoff placeholders + 4 OCR objs fill all 4", () => {
    seedPlaceholders("m1", [
      { kind: "dropoff", objectiveId: "dropoff_a_0" },
      { kind: "dropoff", objectiveId: "dropoff_b_0" },
      { kind: "dropoff", objectiveId: "dropoff_c_0" },
      { kind: "dropoff", objectiveId: "dropoff_d_0" },
    ]);

    store.applyOcrObjectives("m1", [
      {
        kind: "dropoff",
        commodity: "Quantum Fuel",
        scu: 46,
        location: "Green Glade Station",
      },
      {
        kind: "dropoff",
        commodity: "Hydrogen Fuel",
        scu: 94,
        location: "Melodic Fields Station",
      },
      {
        kind: "dropoff",
        commodity: "Ship Ammunition",
        scu: 116,
        location: "Thundering Express Station",
      },
      {
        kind: "dropoff",
        commodity: "Hydrogen Fuel",
        scu: 53,
        location: "Green Glade Station",
      },
    ]);

    const m = store.getMission("m1")!;
    expect(m.legs.length).toBe(4); // no growth, no shrink
    // Every original objectiveId is preserved (no synthetic ids introduced).
    const ids = m.legs.map((l) => l.id).sort();
    expect(ids).toEqual([
      "dropoff_a_0",
      "dropoff_b_0",
      "dropoff_c_0",
      "dropoff_d_0",
    ]);
    const totalScu = m.legs.reduce((s, l) => s + l.scuTotal, 0);
    expect(totalScu).toBe(46 + 94 + 116 + 53);
  });

  it("prefers a case-insensitive exact commodity match over an arbitrary candidate", () => {
    // Three dropoff placeholders. We seed a commodity onto dropoff_b_0 via a
    // FIRST applyOcr pass (which does NOT stamp manual_override, so it stays a
    // fillable candidate), then a SECOND pass whose objectives include an exact
    // (case-insensitive) match for that commodity — which must land on
    // dropoff_b_0, not an arbitrary same-kind candidate.
    seedPlaceholders("m1", [
      { kind: "dropoff", objectiveId: "dropoff_a_0" },
      { kind: "dropoff", objectiveId: "dropoff_b_0" },
      { kind: "dropoff", objectiveId: "dropoff_c_0" },
    ]);
    // Pass 1: fill all three so they each carry a distinct commodity but remain
    // candidates (no manual_override). Order maps a->Iron, b->Titanium, c->Gold.
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Iron", scu: 1, location: "Area18" },
      { kind: "dropoff", commodity: "Titanium", scu: 2, location: "Area18" },
      { kind: "dropoff", commodity: "Gold", scu: 3, location: "Area18" },
    ]);

    // Pass 2: a single OCR obj for "titanium" (lowercase) must match dropoff_b_0
    // exactly, even though dropoff_a_0 is the first same-kind candidate.
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "titanium", scu: 5, location: "Lorville" },
    ]);

    const m = store.getMission("m1")!;
    // a + c were leftover candidates -> pruned; only the matched b survives.
    expect(m.legs.length).toBe(1);
    const filled = m.legs[0];
    expect(filled.id).toBe("dropoff_b_0"); // exact (CI) commodity match wins
    expect(filled.commodity).toBe("titanium"); // OCR commodity overwrites
    expect(filled.scuTotal).toBe(5);
  });
});

// =============================================================================
// Preservation rules
// =============================================================================

describe("applyOcrObjectives — preserves protected legs", () => {
  it("never clobbers a COMPLETED leg", () => {
    seedPlaceholders("m1", [
      { kind: "dropoff", objectiveId: "dropoff_a_0" },
      { kind: "dropoff", objectiveId: "dropoff_b_0" },
    ]);
    // Complete + fill dropoff_a_0 (so it has real values).
    store.updateMission("m1", {
      legs: [
        {
          legId: "dropoff_a_0",
          commodity: "Iron",
          scuTotal: 20,
          completed: true,
        },
      ],
    });

    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Gold", scu: 99, location: "Lorville" },
    ]);

    const m = store.getMission("m1")!;
    const done = m.legs.find((l) => l.id === "dropoff_a_0")!;
    expect(done.completed).toBe(true);
    expect(done.commodity).toBe("Iron"); // untouched
    expect(done.scuTotal).toBe(20);
    // The OCR obj filled the OTHER (open) placeholder instead.
    const filled = m.legs.find((l) => l.id === "dropoff_b_0")!;
    expect(filled.commodity).toBe("Gold");
    expect(filled.scuTotal).toBe(99);
  });

  it("never clobbers a leg with a user manual_override set", () => {
    seedPlaceholders("m1", [
      { kind: "dropoff", objectiveId: "dropoff_a_0" },
      { kind: "dropoff", objectiveId: "dropoff_b_0" },
    ]);
    // A field edit stamps manual_override on dropoff_a_0.
    store.updateMission("m1", {
      legs: [
        { legId: "dropoff_a_0", commodity: "Stims", location: "Grim HEX" },
      ],
    });

    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Gold", scu: 99, location: "Lorville" },
    ]);

    const m = store.getMission("m1")!;
    const edited = m.legs.find((l) => l.id === "dropoff_a_0")!;
    expect(edited.commodity).toBe("Stims"); // user edit preserved
    expect(edited.location).toBe("Grim HEX");
    const filled = m.legs.find((l) => l.id === "dropoff_b_0")!;
    expect(filled.commodity).toBe("Gold");
  });
});

// =============================================================================
// Insert / prune / idempotency
// =============================================================================

describe("applyOcrObjectives — insert unmatched, prune leftovers", () => {
  it("INSERTS a new leg when no candidate of that kind is available", () => {
    seedPlaceholders("m1", [{ kind: "dropoff", objectiveId: "dropoff_a_0" }]);

    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Titanium", scu: 32, location: "Area18" },
      // No pickup placeholder exists -> this must be INSERTed.
      { kind: "pickup", commodity: "Titanium", scu: 32, location: "Lorville" },
    ]);

    const m = store.getMission("m1")!;
    expect(m.legs.length).toBe(2);
    const pk = m.legs.find((l) => l.kind === "pickup")!;
    expect(pk.commodity).toBe("Titanium");
    expect(pk.location).toBe("Lorville");
    // The dropoff placeholder was filled in place (id preserved).
    expect(m.legs.find((l) => l.kind === "dropoff")!.id).toBe("dropoff_a_0");
  });

  it("PRUNES leftover fillable placeholders not matched by any OCR obj", () => {
    seedPlaceholders("m1", [
      { kind: "dropoff", objectiveId: "dropoff_a_0" },
      { kind: "dropoff", objectiveId: "dropoff_b_0" },
      { kind: "dropoff", objectiveId: "dropoff_c_0" },
    ]);

    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Titanium", scu: 32, location: "Area18" },
    ]);

    const m = store.getMission("m1")!;
    expect(m.legs.length).toBe(1); // two leftover placeholders pruned
    expect(m.legs[0].commodity).toBe("Titanium");
  });

  it("is IDEMPOTENT: applying the same OCR set twice yields the same legs", () => {
    seedPlaceholders("m1", [
      { kind: "dropoff", objectiveId: "dropoff_a_0" },
      { kind: "pickup", objectiveId: "pickup_a_0" },
    ]);

    const objs = [
      {
        kind: "dropoff" as const,
        commodity: "Titanium",
        scu: 32,
        location: "Area18",
      },
      {
        kind: "pickup" as const,
        commodity: "Titanium",
        scu: 32,
        location: "Lorville",
      },
    ];

    store.applyOcrObjectives("m1", objs);
    const first = store.getMission("m1")!.legs;
    expect(first.length).toBe(2);
    const firstIds = first.map((l) => l.id).sort();

    store.applyOcrObjectives("m1", objs);
    const second = store.getMission("m1")!.legs;
    // No growth; on re-apply the filled (non-overridden) legs re-match.
    expect(second.length).toBe(2);
    expect(second.map((l) => l.id).sort()).toEqual(firstIds);
    expect(second.reduce((s, l) => s + l.scuTotal, 0)).toBe(64);
  });

  it("OCR-filled legs do NOT get manual_override (so re-apply re-matches them)", () => {
    // Indirect proof: idempotency above relies on filled legs staying fillable.
    // Here we additionally apply a DIFFERENT OCR set and confirm the previously
    // filled leg is re-matched + updated rather than preserved+pruned.
    seedPlaceholders("m1", [{ kind: "dropoff", objectiveId: "dropoff_a_0" }]);
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Titanium", scu: 32, location: "Area18" },
    ]);
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Iron", scu: 10, location: "Lorville" },
    ]);
    const m = store.getMission("m1")!;
    expect(m.legs.length).toBe(1);
    expect(m.legs[0].id).toBe("dropoff_a_0"); // still the same leg
    expect(m.legs[0].commodity).toBe("Iron"); // re-filled, not preserved
    expect(m.legs[0].scuTotal).toBe(10);
  });

  it("does not touch null scu / empty location / empty commodity fields", () => {
    seedPlaceholders("m1", [{ kind: "dropoff", objectiveId: "dropoff_a_0" }]);
    // Pre-fill so we can prove a null/empty OCR field LEAVES the existing value.
    store.updateMission("m1", {
      legs: [
        {
          legId: "dropoff_a_0",
          commodity: "Iron",
          scuTotal: 20,
          location: "Lorville",
        },
      ],
    });
    // Note: that updateMission stamped manual_override -> protected. Use a fresh
    // mission with a marker-only placeholder + a fill via applyOcr instead.
    seedPlaceholders("m2", [{ kind: "dropoff", objectiveId: "dropoff_a_0" }]);
    store.applyOcrObjectives("m2", [
      { kind: "dropoff", commodity: "Iron", scu: 20, location: "Lorville" },
    ]);
    // Now a partial OCR with nulls/empties must keep the prior values.
    store.applyOcrObjectives("m2", [
      { kind: "dropoff", commodity: "", scu: null, location: "" },
    ]);
    const leg = store.getMission("m2")!.legs[0];
    expect(leg.commodity).toBe("Iron");
    expect(leg.scuTotal).toBe(20);
    expect(leg.location).toBe("Lorville");
  });
});

// =============================================================================
// C1 — null/rejected OCR SCU must never become silent 0-SCU corruption.
// A rejected garbage amount (clampScu/recoverMergedFraction null it upstream) or
// an unreadable amount arrives as scu: null. The store must NOT persist it as a
// real, user-confirmed 0-SCU cargo leg: on INSERT it becomes a fillable "amount
// unknown" placeholder (scuTotal 0 = the app's unknown sentinel — slider hidden,
// counted as 0 remaining but still open), and on FILL it never overwrites an
// existing valid SCU. The skip is surfaced via the diagnostics capture sink.
// =============================================================================

describe("applyOcrObjectives — C1: null/rejected SCU is never silent-0 corruption", () => {
  it("INSERT with null scu writes a fillable placeholder (0 = unknown), not real 0 cargo", () => {
    // No placeholder of this kind exists, so the objective is INSERTed. Its scu
    // was rejected upstream (null). It must land as scuTotal 0 = "unknown", with
    // the real commodity/location preserved — not dropped, not real 0 cargo.
    seedPlaceholders("m1", [{ kind: "dropoff", objectiveId: "dropoff_a_0" }]);
    store.applyOcrObjectives("m1", [
      // fills the existing placeholder with a known amount
      { kind: "dropoff", commodity: "Titanium", scu: 32, location: "Area18" },
      // no pickup candidate -> INSERTED; scu rejected -> null
      { kind: "pickup", commodity: "Iron", scu: null, location: "Lorville" },
    ]);

    const m = store.getMission("m1")!;
    const pk = m.legs.find((l) => l.kind === "pickup")!;
    // The leg exists with its real commodity/location (not lost)...
    expect(pk.commodity).toBe("Iron");
    expect(pk.location).toBe("Lorville");
    // ...but its amount is the "unknown" placeholder sentinel, not real cargo.
    expect(pk.scuTotal).toBe(0);
    expect(pk.scuDelivered).toBe(0);
    expect(pk.completed).toBe(false);
  });

  it("an inserted null-scu placeholder stays FILLABLE on re-apply (not locked as confirmed)", () => {
    // The C1 guard leaves manual_override NULL for a null-scu insert, so a later
    // OCR re-read can still fill the amount — proving it wasn't recorded as a
    // user-confirmed real value. (manual_override isn't on the public Leg type,
    // so we prove it behaviorally: a second apply with a real amount re-matches
    // the SAME leg and fills it, rather than being blocked + the leg pruned.)
    store.applyEvent(accepted("m1"), "live");
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Iron", scu: null, location: "Lorville" },
    ]);
    const firstId = store.getMission("m1")!.legs[0].id;
    expect(store.getMission("m1")!.legs[0].scuTotal).toBe(0);

    // Re-apply with the now-readable amount: same leg, filled (not a new dup, not
    // pruned-as-leftover). A confirmed/locked leg could not be re-filled this way.
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Iron", scu: 50, location: "Lorville" },
    ]);
    const after = store.getMission("m1")!.legs;
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(firstId);
    expect(after[0].scuTotal).toBe(50);
  });

  it("a null-scu placeholder is NOT counted as real cargo by dropoffGroups", () => {
    // dropoffGroups feeds the capacity/route math. A 0-SCU placeholder must add
    // 0 to scuTotal/scuRemaining yet still surface as an OPEN stop (todo), never
    // miscounted as delivered cargo.
    store.applyEvent(accepted("m1"), "live");
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Iron", scu: null, location: "Lorville" },
    ]);
    const groups = store.dropoffGroups(null);
    const g = groups.find((x) => x.location === "Lorville")!;
    expect(g.scuTotal).toBe(0); // contributes no real cargo to capacity math
    expect(g.scuRemaining).toBe(0);
    expect(g.allDone).toBe(false); // still an outstanding stop (open leg)
    expect(g.todo.length).toBe(1); // surfaced as to-do, not "delivered"
  });

  it("reports the unreadable amount via the diagnostics capture sink", () => {
    const entries: { kind: string; what: string; reason?: string }[] = [];
    const s = openMissionStore({
      dbPath: ":memory:",
      onCapture: (e) => entries.push(e),
    });
    try {
      s.applyEvent(accepted("m1"), "live");
      s.applyOcrObjectives("m1", [
        { kind: "dropoff", commodity: "Iron", scu: null, location: "Lorville" },
      ]);
      const skip = entries.find(
        (e) =>
          e.kind === "skipped" && /unreadable\/rejected/i.test(e.reason ?? ""),
      );
      expect(skip).toBeDefined();
    } finally {
      s.close();
    }
  });

  it("INSERT with scu 0 writes a fillable placeholder (not real 0 cargo, not locked)", () => {
    // Defense-in-depth: even if a literal 0 somehow reaches the store (the parser
    // collapses non-positive to null, but the store must not trust that), a 0-scu
    // INSERT must land as a fillable "amount unknown" placeholder — scuTotal 0,
    // manual_override NOT stamped (proven behaviorally: a later real amount
    // re-matches + fills the SAME leg, which a locked leg could not do).
    store.applyEvent(accepted("m1"), "live");
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Iron", scu: 0, location: "Lorville" },
    ]);
    const m1 = store.getMission("m1")!;
    expect(m1.legs.length).toBe(1);
    const firstId = m1.legs[0].id;
    expect(m1.legs[0].commodity).toBe("Iron");
    expect(m1.legs[0].location).toBe("Lorville");
    expect(m1.legs[0].scuTotal).toBe(0); // unknown sentinel, not real 0 cargo
    expect(m1.legs[0].completed).toBe(false);

    // Not locked: a later readable amount re-fills the SAME leg.
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Iron", scu: 50, location: "Lorville" },
    ]);
    const after = store.getMission("m1")!.legs;
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(firstId);
    expect(after[0].scuTotal).toBe(50);
  });

  it("INSERT with scu 0 is reported via the diagnostics capture sink (parity with null)", () => {
    const entries: { kind: string; what: string; reason?: string }[] = [];
    const s = openMissionStore({
      dbPath: ":memory:",
      onCapture: (e) => entries.push(e),
    });
    try {
      s.applyEvent(accepted("m1"), "live");
      s.applyOcrObjectives("m1", [
        { kind: "dropoff", commodity: "Iron", scu: 0, location: "Lorville" },
      ]);
      const skip = entries.find(
        (e) =>
          e.kind === "skipped" && /unreadable\/rejected/i.test(e.reason ?? ""),
      );
      expect(skip).toBeDefined(); // counted in unappliedScu like the null case
    } finally {
      s.close();
    }
  });

  it("FILL with scu 0 PRESERVES an existing valid SCU (never overwrites with 0)", () => {
    // Seed a placeholder, fill it with a real amount (stays fillable), then
    // re-apply with scu: 0. The prior 40 must survive untouched (0 is unknown).
    seedPlaceholders("m1", [{ kind: "dropoff", objectiveId: "dropoff_a_0" }]);
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Iron", scu: 40, location: "Lorville" },
    ]);
    expect(store.getMission("m1")!.legs[0].scuTotal).toBe(40);

    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Iron", scu: 0, location: "Lorville" },
    ]);
    const leg = store.getMission("m1")!.legs[0];
    expect(leg.scuTotal).toBe(40); // preserved, NOT zeroed
  });

  it("FILL with null scu PRESERVES an existing valid SCU (never overwrites with 0)", () => {
    // Seed a placeholder, fill it with a real amount via OCR (stays fillable),
    // then re-apply with scu: null. The prior 40 must survive untouched.
    seedPlaceholders("m1", [{ kind: "dropoff", objectiveId: "dropoff_a_0" }]);
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Iron", scu: 40, location: "Lorville" },
    ]);
    expect(store.getMission("m1")!.legs[0].scuTotal).toBe(40);

    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Iron", scu: null, location: "Lorville" },
    ]);
    const leg = store.getMission("m1")!.legs[0];
    expect(leg.scuTotal).toBe(40); // preserved, NOT zeroed
  });
});

// =============================================================================
// On-disk restart persistence (isolated temp DB — never the live app DB)
// =============================================================================

describe("applyOcrObjectives — on-disk persistence (restart)", () => {
  const dbPath = join(tmpdir(), `sc-applyocr-live-${process.pid}.db`);
  const cleanup = (): void => {
    for (const s of ["", "-wal", "-shm"])
      rmSync(`${dbPath}${s}`, { force: true });
  };
  afterEach(cleanup);

  it("fills placeholders, persists the merge across a close+reopen", () => {
    cleanup();
    let disk = openMissionStore({ dbPath, payoutWindowMs: 2000 });
    disk.applyEvent(
      { type: "missionAccepted", missionId: "MV1", title: "Verify", ts: 1000 },
      "live",
    );
    disk.applyEvent(
      {
        type: "missionMarker",
        missionId: "MV1",
        giver: "Covalex_Hauling",
        contractTemplate: "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
        objectiveId: "dropoff_a_0",
        kind: "dropoff",
        ts: 1000,
      },
      "live",
    );
    disk.applyEvent(
      {
        type: "missionMarker",
        missionId: "MV1",
        giver: "Covalex_Hauling",
        contractTemplate: "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
        objectiveId: "dropoff_b_0",
        kind: "dropoff",
        ts: 1000,
      },
      "live",
    );
    expect(disk.getMission("MV1")!.legs.length).toBe(2);

    disk.applyOcrObjectives("MV1", [
      { kind: "dropoff", commodity: "Titanium", scu: 32, location: "Area18" },
    ]);
    // One filled, one leftover pruned.
    expect(disk.getMission("MV1")!.legs.length).toBe(1);

    disk.close();
    disk = openMissionStore({ dbPath, payoutWindowMs: 2000 });
    const m = disk.getMission("MV1")!;
    expect(m.legs.length).toBe(1);
    expect(m.legs[0].id).toBe("dropoff_a_0");
    expect(m.legs[0].commodity).toBe("Titanium");
    expect(m.legs[0].scuTotal).toBe(32);
    disk.close();
  });
});
