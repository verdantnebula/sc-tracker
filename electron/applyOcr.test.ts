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
    // Bug B fix: the pickup placeholder is filled; the UNMATCHED dropoff
    // placeholder is a REAL game id, so it is KEPT (never pruned) — the game's
    // ObjectiveComplete for dropoff_a_0 must still find its leg.
    expect(m.legs.length).toBe(2);
    const pk = m.legs.find((l) => l.kind === "pickup")!;
    expect(pk.id).toBe("pickup_a_0");
    expect(pk.commodity).toBe("Iron");
    const dp = m.legs.find((l) => l.kind === "dropoff")!;
    expect(dp.id).toBe("dropoff_a_0"); // real-id placeholder preserved
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

  it("Bug B: fills real-id placeholders (no synthetic insert, ids preserved, none pruned)", () => {
    // The core Bug B scenario: N real-id dropoff placeholders + N OCR objectives.
    // Each OCR obj must FILL a real-id placeholder (preserving its game id) rather
    // than insert a synthetic manual_* leg, and no real-id placeholder is pruned.
    seedPlaceholders("m1", [
      { kind: "dropoff", objectiveId: "dropoff_a_0" },
      { kind: "dropoff", objectiveId: "dropoff_b_0" },
    ]);

    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Titanium", scu: 32, location: "Area18" },
      { kind: "dropoff", commodity: "Gold", scu: 16, location: "Lorville" },
    ]);

    const m = store.getMission("m1")!;
    // Two legs, both REAL game ids — no synthetic (`manual_*`) leg was inserted.
    expect(m.legs.length).toBe(2);
    expect(m.legs.every((l) => !l.id.startsWith("manual_"))).toBe(true);
    expect(m.legs.map((l) => l.id).sort()).toEqual([
      "dropoff_a_0",
      "dropoff_b_0",
    ]);
    const commodities = m.legs.map((l) => l.commodity).sort();
    expect(commodities).toEqual(["Gold", "Titanium"]);
  });

  it("Bug B: commodity disambiguates which real-id placeholder an OCR obj fills", () => {
    // Two real-id placeholders pre-seeded with distinct commodities (via a first
    // fill pass that leaves them fillable). A later single OCR obj for "gold" must
    // land on the gold-commodity placeholder, preserving its id.
    seedPlaceholders("m1", [
      { kind: "dropoff", objectiveId: "dropoff_a_0" },
      { kind: "dropoff", objectiveId: "dropoff_b_0" },
    ]);
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Iron", scu: 5, location: "Area18" },
      { kind: "dropoff", commodity: "Gold", scu: 7, location: "Area18" },
    ]);
    // a -> Iron, b -> Gold. Now a single "gold" obj must re-fill dropoff_b_0.
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "gold", scu: 9, location: "Lorville" },
    ]);
    const m = store.getMission("m1")!;
    expect(m.legs.length).toBe(2); // both real-id legs kept
    const b = m.legs.find((l) => l.id === "dropoff_b_0")!;
    expect(b.commodity).toBe("gold");
    expect(b.scuTotal).toBe(9);
    const a = m.legs.find((l) => l.id === "dropoff_a_0")!;
    expect(a.commodity).toBe("Iron"); // untouched
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
    // Bug B fix: a + c are REAL game-id placeholders -> KEPT (not pruned), so all
    // three legs survive. Only dropoff_b_0 was matched + re-filled by pass 2.
    expect(m.legs.length).toBe(3);
    const filled = m.legs.find((l) => l.id === "dropoff_b_0")!;
    expect(filled.commodity).toBe("titanium"); // exact (CI) commodity match wins
    expect(filled.scuTotal).toBe(5);
    expect(filled.location).toBe("Lorville");
    // The unmatched real-id placeholders keep their pass-1 values, untouched.
    const a = m.legs.find((l) => l.id === "dropoff_a_0")!;
    expect(a.commodity).toBe("Iron");
    const c = m.legs.find((l) => l.id === "dropoff_c_0")!;
    expect(c.commodity).toBe("Gold");
  });
});

// =============================================================================
// Part 2a — location factors into the match order (commodity+destination key).
// Among same-kind, same-commodity candidates, the one whose LOCATION also matches
// is preferred, so a multi-stop mission delivering the SAME commodity to several
// destinations fills each placeholder by its destination rather than arbitrarily.
// Real-id legs are still preferred over synthetic and never pruned.
// =============================================================================

describe("applyOcrObjectives — location-aware match order (Part 2a)", () => {
  it("prefers the candidate whose commodity AND location both match", () => {
    // Two real-id dropoff placeholders, same commodity (Quartz) to DIFFERENT
    // destinations. A single OCR obj for Quartz->Baijini must land on the
    // Baijini placeholder, not the (first) Everus one.
    seedPlaceholders("m1", [
      { kind: "dropoff", objectiveId: "dropoff_a_0" },
      { kind: "dropoff", objectiveId: "dropoff_b_0" },
    ]);
    // Pass 1 (no manual_override): a -> Quartz/Everus Harbor, b -> Quartz/Baijini.
    store.applyOcrObjectives("m1", [
      {
        kind: "dropoff",
        commodity: "Quartz",
        scu: 10,
        location: "Everus Harbor",
      },
      {
        kind: "dropoff",
        commodity: "Quartz",
        scu: 12,
        location: "Baijini Point",
      },
    ]);

    // Pass 2: a single Quartz->Baijini obj must re-fill dropoff_b_0 by LOCATION,
    // even though dropoff_a_0 is the first same-commodity candidate.
    store.applyOcrObjectives("m1", [
      {
        kind: "dropoff",
        commodity: "Quartz",
        scu: 20,
        location: "Baijini Point",
      },
    ]);

    const m = store.getMission("m1")!;
    expect(m.legs.length).toBe(2);
    const b = m.legs.find((l) => l.id === "dropoff_b_0")!;
    expect(b.scuTotal).toBe(20); // matched by commodity+location
    const a = m.legs.find((l) => l.id === "dropoff_a_0")!;
    expect(a.scuTotal).toBe(10); // untouched (different location)
    expect(a.location).toBe("Everus Harbor");
  });

  it("location match is case/whitespace-insensitive (legKey-normalized)", () => {
    seedPlaceholders("m1", [
      { kind: "dropoff", objectiveId: "dropoff_a_0" },
      { kind: "dropoff", objectiveId: "dropoff_b_0" },
    ]);
    store.applyOcrObjectives("m1", [
      {
        kind: "dropoff",
        commodity: "Quartz",
        scu: 10,
        location: "Everus Harbor",
      },
      {
        kind: "dropoff",
        commodity: "Quartz",
        scu: 12,
        location: "Baijini Point",
      },
    ]);
    // Re-read with different case + padding — must still land on dropoff_b_0.
    store.applyOcrObjectives("m1", [
      {
        kind: "dropoff",
        commodity: "quartz",
        scu: 33,
        location: "  baijini point  ",
      },
    ]);
    const m = store.getMission("m1")!;
    expect(m.legs.find((l) => l.id === "dropoff_b_0")!.scuTotal).toBe(33);
    expect(m.legs.find((l) => l.id === "dropoff_a_0")!.scuTotal).toBe(10);
  });

  it("falls back to commodity-only when no location matches (location still null)", () => {
    // A real-id placeholder with a commodity but NO location yet (suppressed),
    // and an OCR obj carrying that commodity to a destination -> must fill it
    // (commodity match, then location written), not insert a synthetic dup.
    seedPlaceholders("m1", [{ kind: "dropoff", objectiveId: "dropoff_a_0" }]);
    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Quartz", scu: null, location: null },
    ]);
    // Now the placeholder carries Quartz but no location. Re-apply with a located obj.
    store.applyOcrObjectives("m1", [
      {
        kind: "dropoff",
        commodity: "Quartz",
        scu: 25,
        location: "Baijini Point",
      },
    ]);
    const m = store.getMission("m1")!;
    expect(m.legs.length).toBe(1); // filled in place, no dup
    expect(m.legs[0].id).toBe("dropoff_a_0");
    expect(m.legs[0].scuTotal).toBe(25);
    expect(m.legs[0].location).toBe("Baijini Point");
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

  it("KEEPS leftover REAL-game-id placeholders not matched by any OCR obj (Bug B)", () => {
    // Bug B root cause: pruning real-id placeholders orphaned the game's
    // ObjectiveComplete (which carries the real objectiveId), so OCR-added
    // deliveries never crossed off. The fix: NEVER prune a real-game-id leg.
    seedPlaceholders("m1", [
      { kind: "dropoff", objectiveId: "dropoff_a_0" },
      { kind: "dropoff", objectiveId: "dropoff_b_0" },
      { kind: "dropoff", objectiveId: "dropoff_c_0" },
    ]);

    store.applyOcrObjectives("m1", [
      { kind: "dropoff", commodity: "Titanium", scu: 32, location: "Area18" },
    ]);

    const m = store.getMission("m1")!;
    // All three real-id legs survive: one filled, two kept untouched.
    expect(m.legs.length).toBe(3);
    const ids = m.legs.map((l) => l.id).sort();
    expect(ids).toEqual(["dropoff_a_0", "dropoff_b_0", "dropoff_c_0"]);
    // Exactly one leg carries the OCR'd commodity; the matched real id is intact.
    const filled = m.legs.filter((l) => l.commodity === "Titanium");
    expect(filled.length).toBe(1);
  });

  it("PRUNES leftover SYNTHETIC (manual_*) placeholders not matched (Bug B guard)", () => {
    // Synthetic legs have no real objectiveId the game will complete, so an
    // unmatched leftover synthetic leg IS pruned (it's a stale OCR-minted dup).
    store.applyEvent(accepted("m1"), "live");
    // Seed two synthetic placeholders via the addLegs path (manual_* ids).
    store.updateMission("m1", {
      addLegs: [
        { kind: "dropoff", commodity: "", scuTotal: 0 },
        { kind: "dropoff", commodity: "", scuTotal: 0 },
      ],
    });
    // addLegs stamps manual_override -> protected -> not even a candidate. To get
    // unprotected synthetic candidates, mint them via a prior applyOcr INSERT
    // (no real placeholder of this kind exists), which leaves manual_override
    // NULL for the known-scu... actually a known-scu insert stamps it. Use the
    // null-scu insert path which leaves manual_override NULL (fillable synthetic).
    store.applyOcrObjectives("m1", [
      { kind: "pickup", commodity: "Iron", scu: null, location: "Lorville" },
      { kind: "pickup", commodity: "Gold", scu: null, location: "Area18" },
    ]);
    // Two fillable synthetic pickup legs now exist. Re-apply with a SINGLE pickup
    // obj: one is re-filled, the OTHER (leftover synthetic) must be pruned.
    const before = store
      .getMission("m1")!
      .legs.filter((l) => l.kind === "pickup");
    expect(before.length).toBe(2);
    expect(before.every((l) => l.id.startsWith("manual_"))).toBe(true);

    store.applyOcrObjectives("m1", [
      { kind: "pickup", commodity: "Iron", scu: 12, location: "Lorville" },
    ]);
    const after = store
      .getMission("m1")!
      .legs.filter((l) => l.kind === "pickup");
    expect(after.length).toBe(1); // leftover synthetic pruned
    expect(after[0].id.startsWith("manual_")).toBe(true);
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
    // Bug B fix: one real-id placeholder is filled; the leftover real-id
    // placeholder (dropoff_b_0) is KEPT, not pruned — both legs survive.
    expect(disk.getMission("MV1")!.legs.length).toBe(2);

    disk.close();
    disk = openMissionStore({ dbPath, payoutWindowMs: 2000 });
    const m = disk.getMission("MV1")!;
    expect(m.legs.length).toBe(2);
    const filled = m.legs.find((l) => l.id === "dropoff_a_0")!;
    expect(filled.commodity).toBe("Titanium");
    expect(filled.scuTotal).toBe(32);
    // The unmatched real-id placeholder persisted across the restart.
    expect(m.legs.some((l) => l.id === "dropoff_b_0")).toBe(true);
    disk.close();
  });
});
