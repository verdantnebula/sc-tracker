// ============================================================================
// missionStore.test.ts — store correctness core (SPEC §9)
// ----------------------------------------------------------------------------
// Covers: by-dropoff aggregation math (multi-mission combine + completed legs),
// state-machine transitions, payout attribution (1 / N / dropped-award), and
// applyEvent idempotency under replay. Uses synthetic DomainEvent objects + an
// in-memory sqlite db (':memory:'); no real log, no network.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DomainEvent } from "@shared/events";
import { openMissionStore, type MissionStore } from "./missionStore";

let store: MissionStore;

beforeEach(() => {
  store = openMissionStore({ dbPath: ":memory:", payoutWindowMs: 2000 });
});
afterEach(() => {
  store.close();
});

// --- synthetic event builders ------------------------------------------------

const accepted = (
  missionId: string,
  title: string,
  ts = 1000,
): DomainEvent => ({ type: "missionAccepted", missionId, title, ts });

const marker = (
  missionId: string,
  objectiveId: string,
  kind: "pickup" | "dropoff",
  contractTemplate: string,
  ts = 1000,
  giver = "Covalex_Hauling",
): DomainEvent => ({
  type: "missionMarker",
  missionId,
  giver,
  contractTemplate,
  objectiveId,
  kind,
  ts,
});

const declared = (
  missionId: string,
  objectiveId: string,
  commodity: string,
  scuTotal: number,
  location: string,
  ts = 1000,
  kind: "pickup" | "dropoff" = "dropoff",
): DomainEvent => ({
  type: "objectiveDeclared",
  missionId,
  objectiveId,
  kind,
  commodity,
  scuTotal,
  location,
  ts,
});

const completedObj = (
  missionId: string,
  objectiveId: string,
  ts = 2000,
): DomainEvent => ({ type: "objectiveCompleted", missionId, objectiveId, ts });

const ended = (
  missionId: string,
  completionType: "complete" | "abandon",
  ts = 3000,
): DomainEvent => ({
  type: "missionEnded",
  missionId,
  completionType,
  reason: completionType === "complete" ? "Mission Ended" : "Player left",
  ts,
});

/** missionAccepted carrying a title-derived route (FIX 3 fallback). */
const acceptedWithRoute = (
  missionId: string,
  title: string,
  titlePickup: string | null,
  titleDropoff: string | null,
  ts = 1000,
): DomainEvent => ({
  type: "missionAccepted",
  missionId,
  title,
  titlePickup,
  titleDropoff,
  ts,
});

const award = (amount: number, ts: number): DomainEvent => ({
  type: "payoutAwarded",
  amount,
  ts,
});

const fine = (amount: number, ts: number): DomainEvent => ({
  type: "fined",
  amount,
  ts,
});

// =============================================================================
// State machine transitions
// =============================================================================

describe("state machine", () => {
  it("missionAccepted -> status 'accepted', source 'log', acceptedAt set", () => {
    store.applyEvent(accepted("m1", "Senior Rank - Medium Cargo Haul", 1500));
    const m = store.getMission("m1")!;
    expect(m.status).toBe("accepted");
    expect(m.source).toBe("log");
    expect(m.acceptedAt).toBe(1500);
    expect(m.title).toBe("Senior Rank - Medium Cargo Haul");
  });

  it("marker derives variant + grade from the contract template", () => {
    store.applyEvent(
      marker(
        "m1",
        "dropoff_p_0",
        "dropoff",
        "HaulCargo_SingleToMulti3_Processed_Mixed_PressIceProcFood_Stanton1_SupplyGrade",
      ),
    );
    const m = store.getMission("m1")!;
    expect(m.variant).toBe("SINGLE_TO_MULTI");
    expect(m.grade).toBe("SUPPLY");
    expect(m.giver).toBe("Covalex_Hauling");
  });

  it("RedWind template variant/grade parse (giver-agnostic)", () => {
    store.applyEvent(
      marker(
        "rw1",
        "dropoff_x_0",
        "dropoff",
        "Redwind_Stanton_SmallGrade_Planetary_Hydrogen",
        1000,
        "RedWind_Hauling",
      ),
    );
    const m = store.getMission("rw1")!;
    expect(m.grade).toBe("SMALL");
    expect(m.giver).toBe("RedWind_Hauling");
  });

  it("objectiveDeclared is authoritative for commodity/scu/location", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(
      marker(
        "m1",
        "dropoff_p_0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
      ),
    );
    store.applyEvent(
      declared("m1", "dropoff_p_0", "Pressurized Ice", 13, "HDPC-Cassillo"),
    );
    const leg = store
      .getMission("m1")!
      .legs.find((l) => l.id === "dropoff_p_0")!;
    expect(leg.commodity).toBe("Pressurized Ice");
    expect(leg.scuTotal).toBe(13);
    expect(leg.location).toBe("HDPC-Cassillo");
    expect(leg.kind).toBe("dropoff");
  });

  // FIX 2: when the game suppresses the New Objective line (no objectiveDeclared),
  // the marker's contract template still encodes the commodity. The store must
  // auto-fill the leg's commodity from the template so it isn't "(no commodity)".
  it("marker auto-fills leg commodity from the template when objectiveDeclared is suppressed", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(
      marker(
        "m1",
        "dropoff_p_0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
      ),
    );
    // No objectiveDeclared ever arrives (the suppression bug).
    const leg = store
      .getMission("m1")!
      .legs.find((l) => l.id === "dropoff_p_0")!;
    expect(leg.commodity).toBe("Waste"); // from the template, not "(no commodity)"
    // SCU + location still come from the suppressed line -> remain blank.
    expect(leg.scuTotal).toBe(0);
    expect(leg.location).toBeNull();
  });

  it("marker auto-fills commodity for a RedWind template (Hydrogen)", () => {
    store.applyEvent(accepted("m2", "Haul", 1000));
    store.applyEvent(
      marker(
        "m2",
        "dropoff_p_0",
        "dropoff",
        "Redwind_Stanton_SmallGrade_Planetary_Hydrogen",
        1000,
        "RedWind_Hauling",
      ),
    );
    const leg = store
      .getMission("m2")!
      .legs.find((l) => l.id === "dropoff_p_0")!;
    expect(leg.commodity).toBe("Hydrogen");
  });

  it("a real objectiveDeclared commodity OVERRIDES the template-derived one (declared wins)", () => {
    store.applyEvent(accepted("m3", "Haul", 1000));
    store.applyEvent(
      marker(
        "m3",
        "dropoff_p_0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
      ),
    );
    // Template pre-fills "Waste"; then the authoritative declared line arrives.
    store.applyEvent(
      declared("m3", "dropoff_p_0", "Pressurized Ice", 13, "HDPC-Cassillo"),
    );
    const leg = store
      .getMission("m3")!
      .legs.find((l) => l.id === "dropoff_p_0")!;
    expect(leg.commodity).toBe("Pressurized Ice"); // declared, not template "Waste"
  });

  it("a later marker re-fire does NOT clobber a declared commodity", () => {
    store.applyEvent(accepted("m4", "Haul", 1000));
    store.applyEvent(
      marker(
        "m4",
        "dropoff_p_0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
      ),
    );
    store.applyEvent(declared("m4", "dropoff_p_0", "Titanium", 50, "Lorville"));
    // Marker fires again (idempotent re-read) — must not revert to "Waste".
    store.applyEvent(
      marker(
        "m4",
        "dropoff_p_0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
      ),
    );
    const leg = store
      .getMission("m4")!
      .legs.find((l) => l.id === "dropoff_p_0")!;
    expect(leg.commodity).toBe("Titanium");
  });

  it("first objectiveCompleted -> in_progress; missionEnded(complete) -> complete", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A"));
    store.applyEvent(declared("m1", "d1", "Ice", 5, "B"));
    expect(store.getMission("m1")!.status).toBe("accepted");

    store.applyEvent(completedObj("m1", "d0", 2000));
    expect(store.getMission("m1")!.status).toBe("in_progress");

    store.applyEvent(ended("m1", "complete", 3000));
    const m = store.getMission("m1")!;
    expect(m.status).toBe("complete");
    expect(m.completedAt).toBe(3000);
    // completed leg has scuDelivered == scuTotal
    const d0 = m.legs.find((l) => l.id === "d0")!;
    expect(d0.completed).toBe(true);
    expect(d0.scuDelivered).toBe(10);
  });

  it("missionEnded(abandon) -> abandoned", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(ended("m1", "abandon", 3000));
    expect(store.getMission("m1")!.status).toBe("abandoned");
  });

  it("objectiveCompleted does NOT downgrade a terminal mission", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A"));
    store.applyEvent(ended("m1", "complete", 3000));
    // a late completion event should not move it back to in_progress
    store.applyEvent(completedObj("m1", "d0", 4000));
    expect(store.getMission("m1")!.status).toBe("complete");
  });

  it("out-of-order: completion before accept still reconciles", () => {
    store.applyEvent(completedObj("m1", "d0", 2000));
    store.applyEvent(accepted("m1", "Haul", 1000));
    const m = store.getMission("m1")!;
    // d0 is the only leg and it's completed -> A1 rolls the mission up to
    // 'complete' (all legs done). (Pre-A1 this asserted 'in_progress', before the
    // completion roll-up existed.) The leg state still reconciles either way.
    expect(m.status).toBe("complete");
    expect(m.legs.find((l) => l.id === "d0")!.completed).toBe(true);
  });
});

// =============================================================================
// A1 — leg-derived completion roll-up + reactivity (the completion bug fix)
// =============================================================================

describe("completion roll-up (A1)", () => {
  it("ALL legs done -> status 'complete' + completed_at set (leg-derived)", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A"));
    store.applyEvent(declared("m1", "d1", "Ice", 5, "B"));
    expect(store.getMission("m1")!.status).toBe("accepted");

    store.toggleLeg("m1", "d0", true);
    expect(store.getMission("m1")!.status).toBe("in_progress");

    store.toggleLeg("m1", "d1", true);
    const m = store.getMission("m1")!;
    expect(m.status).toBe("complete");
    expect(m.completedAt).not.toBeNull();
  });

  it("un-checking a leg reverts a leg-derived complete back to in_progress", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A"));
    store.applyEvent(declared("m1", "d1", "Ice", 5, "B"));
    store.toggleLeg("m1", "d0", true);
    store.toggleLeg("m1", "d1", true);
    expect(store.getMission("m1")!.status).toBe("complete");

    // Un-check one leg: a leg-derived complete is REACTIVE -> reverts.
    const reverted = store.toggleLeg("m1", "d1", false);
    expect(reverted.status).toBe("in_progress");
    expect(reverted.completedAt).toBeNull();
  });

  it("adding an incomplete leg reverts a leg-derived complete", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A"));
    store.toggleLeg("m1", "d0", true);
    expect(store.getMission("m1")!.status).toBe("complete");

    // A fresh incomplete leg means the mission is no longer all-done.
    const m = store.updateMission("m1", {
      addLegs: [{ kind: "dropoff", commodity: "Gold", scuTotal: 4 }],
    });
    expect(m.status).toBe("in_progress");
    expect(m.completedAt).toBeNull();
  });

  it("a GAME EndMission complete stays complete even if a leg looks incomplete", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A"));
    store.applyEvent(declared("m1", "d1", "Ice", 5, "B"));
    store.toggleLeg("m1", "d0", true); // only one of two legs done
    store.applyEvent(ended("m1", "complete", 3000));
    expect(store.getMission("m1")!.status).toBe("complete");

    // Toggling/adding legs must NOT downgrade a game-authoritative terminal.
    store.toggleLeg("m1", "d0", false);
    expect(store.getMission("m1")!.status).toBe("complete");
    const m = store.updateMission("m1", {
      addLegs: [{ kind: "dropoff", commodity: "Gold", scuTotal: 4 }],
    });
    expect(m.status).toBe("complete");
  });

  it("abandoned (game) is never resurrected by a later leg recompute", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A"));
    store.applyEvent(ended("m1", "abandon", 3000));
    expect(store.getMission("m1")!.status).toBe("abandoned");
    // Completing the leg must not pull it out of abandoned.
    store.toggleLeg("m1", "d0", true);
    expect(store.getMission("m1")!.status).toBe("abandoned");
  });

  it("a zero-leg mission is NEVER force-completed", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    // No legs at all -> stays accepted, not complete.
    expect(store.getMission("m1")!.status).toBe("accepted");
  });
});

// =============================================================================
// A2 — manual "Mark complete" / status escape hatch (authoritative terminal)
// =============================================================================

describe("manual mark-complete (A2)", () => {
  it("updateMission({status:'complete'}) completes + sets completed_at", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A")); // still incomplete
    const m = store.updateMission("m1", { status: "complete" });
    expect(m.status).toBe("complete");
    expect(m.completedAt).not.toBeNull();
  });

  it("a manually-completed mission is NOT downgraded by a later leg recompute", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A"));
    store.applyEvent(declared("m1", "d1", "Ice", 5, "B"));
    store.updateMission("m1", { status: "complete" }); // forced while incomplete
    expect(store.getMission("m1")!.status).toBe("complete");

    // Adding / toggling legs must not silently revert a manual terminal.
    store.toggleLeg("m1", "d0", true);
    expect(store.getMission("m1")!.status).toBe("complete");
    const m = store.updateMission("m1", {
      addLegs: [{ kind: "dropoff", commodity: "Gold", scuTotal: 4 }],
    });
    expect(m.status).toBe("complete");
  });

  it("manually completed -> leaves Active list, appears in History", () => {
    store.applyEvent(accepted("m1", "Live Haul", 1000), "live");
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A", 1000), "live");
    expect(store.activeMissions().map((m) => m.id)).toContain("m1");

    store.updateMission("m1", { status: "complete" });
    expect(store.activeMissions().map((m) => m.id)).not.toContain("m1");
    expect(store.history().map((m) => m.id)).toContain("m1");
  });

  it("re-opening a completed mission (status->in_progress) clears the terminal", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A"));
    store.updateMission("m1", { status: "complete" });
    expect(store.getMission("m1")!.status).toBe("complete");

    // Explicitly re-open: terminal_source cleared -> reactive to legs again.
    store.updateMission("m1", { status: "in_progress" });
    // Now un-completing/checking a leg drives status from legs (proves reactive):
    store.toggleLeg("m1", "d0", true);
    expect(store.getMission("m1")!.status).toBe("complete"); // leg-derived now
    store.toggleLeg("m1", "d0", false);
    expect(store.getMission("m1")!.status).toBe("accepted");
  });
});

// =============================================================================
// Idempotency under replay (backfill + live, or re-scan)
// =============================================================================

describe("idempotency", () => {
  it("re-applying the full event stream does not duplicate or double-count", () => {
    const events: DomainEvent[] = [
      accepted("m1", "Haul", 1000),
      marker(
        "m1",
        "d0",
        "dropoff",
        "HaulCargo_AToB_Ice_Ice_Stanton1_SupplyGrade",
      ),
      declared("m1", "d0", "Ice", 10, "A"),
      completedObj("m1", "d0", 2000),
      ended("m1", "complete", 3000),
      award(5000, 3100),
    ];
    events.forEach((e) => store.applyEvent(e));
    events.forEach((e) => store.applyEvent(e)); // replay

    const missions = store.listMissions();
    expect(missions).toHaveLength(1);
    expect(missions[0].legs).toHaveLength(1);
    expect(store.totals().creditsEarned).toBe(5000); // not 10000
    expect(missions[0].payout).toBe(5000);
    expect(missions[0].payoutConfidence).toBe("confirmed");
  });

  it("duplicate award (same amount, same ts) counts once", () => {
    store.applyEvent(award(316575, 5000));
    store.applyEvent(award(316575, 5000));
    expect(store.totals().creditsEarned).toBe(316575);
  });

  it("same amount at a DIFFERENT ts counts twice (distinct awards)", () => {
    store.applyEvent(award(1000, 5000));
    store.applyEvent(award(1000, 6000));
    expect(store.totals().creditsEarned).toBe(2000);
  });
});

// =============================================================================
// Payout attribution (SPEC §4a)
// =============================================================================

describe("payout attribution", () => {
  it("0 completions in window -> other income, total accrues, no mission attributed", () => {
    // a cargo sale: award with no recent mission completion
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(ended("m1", "complete", 1000)); // far before the award window
    store.applyEvent(award(28400, 10000)); // 9s later, outside 2s window
    expect(store.totals().creditsEarned).toBe(28400);
    expect(store.getMission("m1")!.payout).toBeNull();
    expect(store.getMission("m1")!.payoutConfidence).toBe("unknown");
  });

  it("1 completion in window -> confirmed attribution", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(
      marker(
        "m1",
        "d0",
        "dropoff",
        "HaulCargo_AToB_Ice_Ice_Stanton1_SupplyGrade",
      ),
    );
    store.applyEvent(ended("m1", "complete", 5000));
    store.applyEvent(award(142500, 5170)); // 170ms after completion
    const m = store.getMission("m1")!;
    expect(m.payout).toBe(142500);
    expect(m.payoutConfidence).toBe("confirmed");
    expect(store.totals().creditsEarned).toBe(142500);
  });

  it("N>1 completions (batch) -> approximate, total still sums all awards", () => {
    // three missions complete simultaneously, two awards fire (dropped award case)
    for (const id of ["a", "b", "c"]) {
      store.applyEvent(accepted(id, `Haul ${id}`, 1000));
      store.applyEvent(
        marker(
          id,
          "d0",
          "dropoff",
          "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
        ),
      );
      store.applyEvent(ended(id, "complete", 5000));
    }
    store.applyEvent(award(34625, 5100));
    store.applyEvent(award(35625, 5200));

    const a = store.getMission("a")!;
    const b = store.getMission("b")!;
    const c = store.getMission("c")!;
    // every candidate is at least 'approximate' (none confirmed)
    for (const m of [a, b, c]) {
      expect(m.payoutConfidence).toBe("approximate");
    }
    // two awards landed on two of the three missions; one stays payout=null
    const payouts = [a.payout, b.payout, c.payout];
    const attributed = payouts.filter((p) => p !== null);
    expect(attributed.sort()).toEqual([34625, 35625]);
    expect(payouts.filter((p) => p === null)).toHaveLength(1); // dropped-award mission
    // total credits earned = sum of ALL awards regardless of attribution
    expect(store.totals().creditsEarned).toBe(34625 + 35625);
  });

  it("non-hauling completion in window -> award goes to other income", () => {
    store.applyEvent(accepted("m1", "Bounty", 1000));
    // giver never set to a hauling giver via marker -> not hauling
    store.applyEvent(ended("m1", "complete", 5000));
    store.applyEvent(award(50000, 5150));
    expect(store.getMission("m1")!.payout).toBeNull();
    expect(store.totals().creditsEarned).toBe(50000);
  });

  it("manual setPayout overrides to confirmed", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(
      marker(
        "m1",
        "d0",
        "dropoff",
        "HaulCargo_AToB_Ice_Ice_Stanton1_SupplyGrade",
      ),
    );
    store.applyEvent(ended("m1", "complete", 5000));
    store.applyEvent(award(34625, 5100));
    store.applyEvent(award(35625, 5150)); // make it approximate (N>1 not needed; single mission)
    store.setPayout("m1", 999999);
    const m = store.getMission("m1")!;
    expect(m.payout).toBe(999999);
    expect(m.payoutConfidence).toBe("confirmed");
  });

  it("fines tracked separately, never reduce payout", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(
      marker(
        "m1",
        "d0",
        "dropoff",
        "HaulCargo_AToB_Ice_Ice_Stanton1_SupplyGrade",
      ),
    );
    store.applyEvent(ended("m1", "complete", 5000));
    store.applyEvent(award(100000, 5100));
    store.applyEvent(fine(5000, 6000));
    expect(store.getMission("m1")!.payout).toBe(100000); // unchanged
    expect(store.totals().creditsEarned).toBe(100000);
    expect(store.totals().finesTotal).toBe(5000);
  });
});

// =============================================================================
// By-dropoff aggregation math
// =============================================================================

describe("by-dropoff aggregation", () => {
  beforeEach(() => {
    // Mission 1: Ice 13 -> Cassillo, Food 188 -> Teasa, Ice 9 -> Farnesway, Food 150 -> Cassillo
    store.applyEvent(accepted("m1", "Haul 1", 1000));
    store.applyEvent(
      declared("m1", "d0", "Pressurized Ice", 13, "HDPC-Cassillo"),
    );
    store.applyEvent(
      declared("m1", "d1", "Processed Food", 188, "Teasa Spaceport"),
    );
    store.applyEvent(
      declared("m1", "d2", "Pressurized Ice", 9, "HDPC-Farnesway"),
    );
    store.applyEvent(
      declared("m1", "d3", "Processed Food", 150, "HDPC-Cassillo"),
    );
    // Mission 2: also drops Ice 20 -> Cassillo (combines with m1's Ice at Cassillo)
    store.applyEvent(accepted("m2", "Haul 2", 1000));
    store.applyEvent(
      declared("m2", "d0", "Pressurized Ice", 20, "HDPC-Cassillo"),
    );
  });

  it("combines remaining SCU per commodity across missions at one location", () => {
    const groups = store.dropoffGroups(null);
    const cassillo = groups.find((g) => g.location === "HDPC-Cassillo")!;
    const ice = cassillo.todo.find((c) => c.commodity === "Pressurized Ice")!;
    const food = cassillo.todo.find((c) => c.commodity === "Processed Food")!;
    expect(ice.scuRemaining).toBe(13 + 20); // m1 d0 + m2 d0
    expect(food.scuRemaining).toBe(150);
    // both legs feeding the ice line are referenced for toggle-together
    expect(ice.legRefs).toHaveLength(2);
    expect(cassillo.scuRemaining).toBe(33 + 150);
    expect(cassillo.scuTotal).toBe(33 + 150);
    expect(cassillo.allDone).toBe(false);
  });

  it("completed legs count as delivered, drop out of todo, update pct", () => {
    // deliver m1's Ice at Cassillo (13 of the 33)
    store.applyEvent(completedObj("m1", "d0", 2000));
    const groups = store.dropoffGroups(null);
    const cassillo = groups.find((g) => g.location === "HDPC-Cassillo")!;
    const ice = cassillo.todo.find((c) => c.commodity === "Pressurized Ice")!;
    expect(ice.scuRemaining).toBe(20); // only m2's 20 remains
    expect(ice.scuDelivered).toBe(13);
    // group total unchanged (33 ice + 150 food), remaining drops by 13
    expect(cassillo.scuTotal).toBe(183);
    expect(cassillo.scuRemaining).toBe(170);
    expect(cassillo.pctDelivered).toBe(Math.round((13 / 183) * 100));
  });

  it("a location fully delivered -> allDone true, nothing in todo", () => {
    // Farnesway only has m1 d2 (Ice 9) -> complete it
    store.applyEvent(completedObj("m1", "d2", 2000));
    const groups = store.dropoffGroups(null);
    const farnesway = groups.find((g) => g.location === "HDPC-Farnesway")!;
    expect(farnesway.allDone).toBe(true);
    expect(farnesway.todo).toHaveLength(0);
    expect(farnesway.delivered).toHaveLength(1);
    expect(farnesway.pctDelivered).toBe(100);
  });

  it("excludes legs from terminal (complete/abandoned) missions", () => {
    store.applyEvent(ended("m2", "complete", 3000));
    const groups = store.dropoffGroups(null);
    const cassillo = groups.find((g) => g.location === "HDPC-Cassillo")!;
    const ice = cassillo.todo.find((c) => c.commodity === "Pressurized Ice")!;
    expect(ice.scuRemaining).toBe(13); // m2's 20 excluded now
  });

  it("flags the current location", () => {
    const groups = store.dropoffGroups("Teasa Spaceport");
    const teasa = groups.find((g) => g.location === "Teasa Spaceport")!;
    expect(teasa.isCurrentLocation).toBe(true);
    const other = groups.find((g) => g.location === "HDPC-Cassillo")!;
    expect(other.isCurrentLocation).toBe(false);
  });

  it("ignores dropoff legs with no known location (token-suppressed)", () => {
    store.applyEvent(accepted("m3", "Haul 3", 1000));
    store.applyEvent(
      marker(
        "m3",
        "d0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
      ),
    );
    // no objectiveDeclared -> location stays null
    const groups = store.dropoffGroups(null);
    const refsAll = groups.flatMap((g) =>
      [...g.todo, ...g.delivered].flatMap((c) => c.legRefs),
    );
    expect(refsAll.some((r) => r.missionId === "m3")).toBe(false);
  });
});

// =============================================================================
// FIX 3: title-derived location autofill (New Objective suppressed)
// =============================================================================

describe("title-route location autofill (objectiveDeclared suppressed)", () => {
  it("fills pickup+dropoff from the title for an A->B mission with no declared location", () => {
    // A->B mission: title carries Seraphim Station > Everus Harbor. A marker
    // seeds commodity (and the single pickup + single dropoff legs) but NO
    // objectiveDeclared arrives (game suppressed it).
    store.applyEvent(
      acceptedWithRoute(
        "m1",
        "DIRECT Large Haul | Seraphim Station > Everus Harbor",
        "Seraphim Station",
        "Everus Harbor",
      ),
    );
    store.applyEvent(
      marker(
        "m1",
        "pickup_p_0",
        "pickup",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
      ),
    );
    store.applyEvent(
      marker(
        "m1",
        "dropoff_p_0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
      ),
    );

    const m = store.getMission("m1")!;
    const pickup = m.legs.find((l) => l.kind === "pickup")!;
    const dropoff = m.legs.find((l) => l.kind === "dropoff")!;
    expect(pickup.location).toBe("Seraphim Station");
    expect(dropoff.location).toBe("Everus Harbor");

    // By-dropoff groups the suppressed leg under the title's dropoff, NOT Unknown.
    const groups = store.dropoffGroups(null);
    const everus = groups.find((g) => g.location === "Everus Harbor");
    expect(everus).toBeDefined();
    expect(
      everus!.todo.some((c) => c.legRefs.some((r) => r.missionId === "m1")),
    ).toBe(true);

    // SCU is genuinely unavailable when suppressed -> untouched (0), still manual.
    expect(dropoff.scuTotal).toBe(0);
  });

  it("MERGES a title-derived dropoff with a declared dropoff of the same location into ONE group", () => {
    // Regression guard for the dirty-name bug: parseTitleRoute now strips
    // contract-modifier tokens / trailing colon, so a title-derived dropoff is a
    // CLEAN name. It must key-match an authoritative objectiveDeclared location
    // of the same name and form a SINGLE By-Dropoff group — not split into two
    // (e.g. "Everus Harbor [BP]* :" vs "Everus Harbor").

    // Mission A: New Objective suppressed -> dropoff filled from the (clean) title.
    store.applyEvent(
      acceptedWithRoute(
        "mA",
        "DIRECT Large Haul | Seraphim Station > Everus Harbor",
        "Seraphim Station",
        "Everus Harbor", // already cleaned by parseTitleRoute upstream
      ),
    );
    store.applyEvent(
      marker(
        "mA",
        "dropoff_p_0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
      ),
    );

    // Mission B: a normal mission with an authoritative declared dropoff there.
    store.applyEvent(accepted("mB", "Haul B", 1000));
    store.applyEvent(
      declared("mB", "d0", "Pressurized Ice", 12, "Everus Harbor"),
    );

    const groups = store.dropoffGroups(null);
    const everusGroups = groups.filter((g) => g.location === "Everus Harbor");
    // The whole point: exactly ONE group for Everus Harbor, fed by BOTH missions.
    expect(everusGroups).toHaveLength(1);
    const refs = [
      ...everusGroups[0].todo,
      ...everusGroups[0].delivered,
    ].flatMap((c) => c.legRefs.map((r) => r.missionId));
    expect(refs).toContain("mA");
    expect(refs).toContain("mB");
  });

  it("declared location wins: a later objectiveDeclared overrides the title-derived one", () => {
    store.applyEvent(
      acceptedWithRoute(
        "m1",
        "DIRECT Large Haul | Seraphim Station > Everus Harbor",
        "Seraphim Station",
        "Everus Harbor",
      ),
    );
    store.applyEvent(
      marker(
        "m1",
        "dropoff_p_0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
      ),
    );
    // Title-derived dropoff in place...
    expect(store.getMission("m1")!.legs[0].location).toBe("Everus Harbor");
    // ...now the authoritative New Objective arrives with a real location.
    store.applyEvent(
      declared("m1", "dropoff_p_0", "Waste", 29, "Port Tressler"),
    );
    const dropoff = store
      .getMission("m1")!
      .legs.find((l) => l.kind === "dropoff")!;
    expect(dropoff.location).toBe("Port Tressler"); // declared wins
    expect(dropoff.scuTotal).toBe(29);
  });

  it("declared-first is NOT overwritten by a later marker (title fallback never clobbers declared)", () => {
    store.applyEvent(
      acceptedWithRoute(
        "m1",
        "DIRECT Large Haul | Seraphim Station > Everus Harbor",
        "Seraphim Station",
        "Everus Harbor",
      ),
    );
    // Declared arrives FIRST with the real (different) location.
    store.applyEvent(
      declared("m1", "dropoff_p_0", "Waste", 29, "Port Tressler"),
    );
    // Marker for the same leg fires later (would carry the title fallback).
    store.applyEvent(
      marker(
        "m1",
        "dropoff_p_0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
      ),
    );
    const dropoff = store
      .getMission("m1")!
      .legs.find((l) => l.kind === "dropoff")!;
    expect(dropoff.location).toBe("Port Tressler");
  });

  it("does NOT guess the dropoff for a multi-dropoff mission", () => {
    // Two dropoff legs -> not a clean A->B; the title's single dropoff must NOT
    // be smeared across both. (Pickup is still single, but be conservative.)
    store.applyEvent(
      acceptedWithRoute(
        "m1",
        "BULK Multi Haul | Seraphim Station > Everus Harbor",
        "Seraphim Station",
        "Everus Harbor",
      ),
    );
    store.applyEvent(
      marker(
        "m1",
        "dropoff_p_0",
        "dropoff",
        "HaulCargo_SingleToMulti3_Processed_Mixed_PressIce_Stanton1_SupplyGrade",
      ),
    );
    store.applyEvent(
      marker(
        "m1",
        "dropoff_p_1",
        "dropoff",
        "HaulCargo_SingleToMulti3_Processed_Mixed_PressIce_Stanton1_SupplyGrade",
      ),
    );
    const dropoffs = store
      .getMission("m1")!
      .legs.filter((l) => l.kind === "dropoff");
    expect(dropoffs).toHaveLength(2);
    for (const d of dropoffs) expect(d.location).toBeNull();
  });

  it("no-op when the title carries no route (legs stay null)", () => {
    store.applyEvent(accepted("m1", "Senior Rank - Medium Cargo Haul", 1000));
    store.applyEvent(
      marker(
        "m1",
        "dropoff_p_0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
      ),
    );
    const dropoff = store.getMission("m1")!.legs[0];
    expect(dropoff.location).toBeNull();
  });
});

// =============================================================================
// Totals + history + manual CRUD
// =============================================================================

describe("totals, history, manual CRUD", () => {
  it("totals: completed count, SCU hauled, credits, fines", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(declared("m1", "d0", "Ice", 13, "A"));
    store.applyEvent(declared("m1", "d1", "Ice", 7, "B"));
    store.applyEvent(completedObj("m1", "d0", 2000));
    store.applyEvent(completedObj("m1", "d1", 2100));
    store.applyEvent(ended("m1", "complete", 3000));
    store.applyEvent(award(50000, 3100));
    store.applyEvent(fine(2000, 4000));

    const t = store.totals();
    expect(t.missionsCompleted).toBe(1);
    expect(t.scuHauled).toBe(20);
    expect(t.creditsEarned).toBe(50000);
    expect(t.finesTotal).toBe(2000);
  });

  it("history lists completed + abandoned, newest first; excludes active", () => {
    store.applyEvent(accepted("m1", "Done", 1000));
    store.applyEvent(ended("m1", "complete", 2000));
    store.applyEvent(accepted("m2", "Dropped", 1000));
    store.applyEvent(ended("m2", "abandon", 3000));
    store.applyEvent(accepted("m3", "Active", 1000)); // still accepted

    const h = store.history();
    expect(h.map((m) => m.id)).toEqual(["m2", "m1"]); // newest completedAt first
    expect(h.some((m) => m.id === "m3")).toBe(false);
  });

  it("addManualMission persists with source manual + MANUAL variant", () => {
    const m = store.addManualMission({
      title: "Manual run",
      giver: "Covalex Hauling",
      status: "accepted",
      legs: [
        {
          kind: "dropoff",
          commodity: "Titanium",
          location: "Area18",
          scuTotal: 64,
        },
      ],
    });
    expect(m.source).toBe("manual");
    expect(m.variant).toBe("MANUAL");
    expect(m.legs).toHaveLength(1);
    expect(m.legs[0].scuTotal).toBe(64);
    expect(store.getMission(m.id)).toBeDefined();
  });

  it("toggleLeg marks delivered + recomputes status", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A"));
    store.applyEvent(declared("m1", "d1", "Ice", 5, "B"));
    const updated = store.toggleLeg("m1", "d0", true);
    expect(updated.legs[0].completed).toBe(true);
    expect(updated.legs[0].scuDelivered).toBe(10);
    // One of two legs done -> in_progress (all-legs-done would now roll up to
    // 'complete'; see the A1 roll-up suite, which covers the single-leg case).
    expect(updated.status).toBe("in_progress");
  });

  it("updateMission patches notes + payout (confirmed)", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    const m = store.updateMission("m1", { notes: "fragile", payout: 12345 });
    expect(m.notes).toBe("fragile");
    expect(m.payout).toBe(12345);
    expect(m.payoutConfidence).toBe("confirmed");
  });

  it("abandon sets status abandoned (keeps the record)", () => {
    store.applyEvent(accepted("m1", "Haul", 1000));
    const m = store.abandon("m1");
    expect(m.status).toBe("abandoned");
    expect(store.getMission("m1")).toBeDefined();
  });
});

// =============================================================================
// Active vs historical session split + Clear / Reset (the bug fix)
// =============================================================================

describe("active vs historical session", () => {
  it("activeMissions = live + non-terminal only; historical non-terminal excluded", () => {
    // A live, still-accepted mission -> active.
    store.applyEvent(accepted("live1", "Live Haul", 1000), "live");
    // A historical mission that never logged a terminal event (the bug case) ->
    // stale, must NOT be active.
    store.applyEvent(accepted("hist1", "Stale Old Haul", 500), "historical");
    // A historical completed mission -> History, not active.
    store.applyEvent(accepted("hist2", "Old Done", 400), "historical");
    store.applyEvent(ended("hist2", "complete", 450), "historical");
    // A live mission that completed this session -> History, not active.
    store.applyEvent(accepted("live2", "Live Done", 1100), "live");
    store.applyEvent(ended("live2", "complete", 1200), "live");

    const active = store.activeMissions();
    expect(active.map((m) => m.id)).toEqual(["live1"]);

    const history = store.history();
    // Both terminal missions present regardless of session; newest first.
    expect(history.map((m) => m.id).sort()).toEqual(["hist2", "live2"]);
    // The stale historical non-terminal mission is in neither active nor history.
    expect(history.some((m) => m.id === "hist1")).toBe(false);
  });

  it("default source is 'live' (no-arg applyEvent keeps current-session semantics)", () => {
    store.applyEvent(accepted("m1", "Haul", 1000)); // no source arg
    expect(store.activeMissions().map((m) => m.id)).toEqual(["m1"]);
  });

  it("a live event PROMOTES a historical mission to active (seen again live)", () => {
    store.applyEvent(accepted("m1", "Haul", 1000), "historical");
    expect(store.activeMissions()).toHaveLength(0); // stale historical

    // The same mission appears in the current live log -> it's genuinely active.
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A", 2000), "live");
    expect(store.activeMissions().map((m) => m.id)).toEqual(["m1"]);
  });

  it("dropoffGroups exclude historical non-terminal legs", () => {
    // Historical non-terminal mission with a dropoff leg -> must NOT aggregate.
    store.applyEvent(accepted("hist1", "Old", 500), "historical");
    store.applyEvent(
      declared("hist1", "d0", "Ice", 50, "HDPC-Cassillo", 500),
      "historical",
    );
    // Live mission with a dropoff at the same location -> should aggregate.
    store.applyEvent(accepted("live1", "New", 1000), "live");
    store.applyEvent(
      declared("live1", "d0", "Ice", 13, "HDPC-Cassillo", 1000),
      "live",
    );

    const groups = store.dropoffGroups(null);
    const cassillo = groups.find((g) => g.location === "HDPC-Cassillo")!;
    const ice = cassillo.todo.find((c) => c.commodity === "Ice")!;
    // Only the live 13 — the historical 50 is excluded.
    expect(ice.scuRemaining).toBe(13);
  });

  it("clearActiveMissions deletes live non-terminal, keeps history", () => {
    store.applyEvent(accepted("live1", "Active A", 1000), "live");
    store.applyEvent(accepted("live2", "Active B", 1000), "live");
    store.applyEvent(accepted("done1", "Done", 1000), "live");
    store.applyEvent(ended("done1", "complete", 1100), "live");
    store.applyEvent(accepted("hist1", "Stale", 500), "historical");

    const removed = store.clearActiveMissions();
    expect(removed).toBe(2); // live1 + live2
    expect(store.activeMissions()).toHaveLength(0);
    // History (done1) preserved.
    expect(store.history().map((m) => m.id)).toEqual(["done1"]);
    // The stale historical mission is also still present in the full list (it was
    // never active, so Clear doesn't touch it).
    expect(store.getMission("hist1")).toBeDefined();
  });

  it("clearActiveMissions cascades legs of removed missions", () => {
    store.applyEvent(accepted("live1", "Active", 1000), "live");
    store.applyEvent(declared("live1", "d0", "Ice", 13, "A", 1000), "live");
    store.clearActiveMissions();
    expect(store.getMission("live1")).toBeUndefined();
    // Re-add a mission with the SAME objectiveId -> proves the old leg is gone
    // (composite key would otherwise collide / show stale data).
    store.applyEvent(accepted("live1", "Active", 2000), "live");
    store.applyEvent(declared("live1", "d0", "Food", 5, "B", 2000), "live");
    const leg = store.getMission("live1")!.legs.find((l) => l.id === "d0")!;
    expect(leg.commodity).toBe("Food");
    expect(leg.scuTotal).toBe(5);
  });

  it("resetAllData wipes missions, legs, earnings and fines", () => {
    store.applyEvent(accepted("m1", "Haul", 1000), "live");
    store.applyEvent(declared("m1", "d0", "Ice", 10, "A", 1000), "live");
    store.applyEvent(ended("m1", "complete", 1100), "live");
    store.applyEvent(award(50000, 1150));
    store.applyEvent(fine(2000, 1200));
    store.applyEvent(accepted("hist1", "Old", 500), "historical");

    const removed = store.resetAllData();
    expect(removed).toBe(2); // m1 + hist1
    expect(store.listMissions()).toHaveLength(0);
    expect(store.activeMissions()).toHaveLength(0);
    expect(store.history()).toHaveLength(0);
    const t = store.totals();
    expect(t.creditsEarned).toBe(0);
    expect(t.finesTotal).toBe(0);
    expect(t.missionsCompleted).toBe(0);
  });
});

// =============================================================================
// FIX 2 — bidirectional leg toggle + manual-override persistence
// =============================================================================

describe("leg toggle — bidirectional + manual override", () => {
  const seedLeg = (): void => {
    store.applyEvent(accepted("m1", "Haul", 1000), "live");
    store.applyEvent(
      declared("m1", "d0", "Ice", 10, "HDPC-Cassillo", 1000),
      "live",
    );
  };

  it("toggleLeg completes then UN-completes (completed=false, scuDelivered=0)", () => {
    seedLeg();
    const on = store.toggleLeg("m1", "d0", true);
    expect(on.legs[0].completed).toBe(true);
    expect(on.legs[0].scuDelivered).toBe(10);

    // Un-check: must reset both completed AND scuDelivered.
    const off = store.toggleLeg("m1", "d0", false);
    expect(off.legs[0].completed).toBe(false);
    expect(off.legs[0].scuDelivered).toBe(0);
  });

  it("un-completing drops the leg back into by-dropoff todo (remaining restored)", () => {
    seedLeg();
    // A second leg at a DIFFERENT location keeps the mission non-terminal when
    // only d0 is delivered (so it stays in the active by-dropoff view — A1 would
    // otherwise roll a fully-delivered single-leg mission to 'complete', removing
    // it from dropoffGroups entirely). The HDPC-Cassillo assertions below are
    // unaffected by this Teasa leg.
    store.applyEvent(
      declared("m1", "d1", "Food", 5, "Teasa Spaceport", 1000),
      "live",
    );
    store.toggleLeg("m1", "d0", true);
    // Delivered -> not in todo.
    let g = store
      .dropoffGroups(null)
      .find((x) => x.location === "HDPC-Cassillo")!;
    expect(g.todo.find((c) => c.commodity === "Ice")).toBeUndefined();
    expect(g.allDone).toBe(true);

    // Un-deliver -> back to todo with full remaining.
    store.toggleLeg("m1", "d0", false);
    g = store.dropoffGroups(null).find((x) => x.location === "HDPC-Cassillo")!;
    const ice = g.todo.find((c) => c.commodity === "Ice")!;
    expect(ice.scuRemaining).toBe(10);
    expect(g.allDone).toBe(false);
  });

  it("a manual UN-check is NOT clobbered by a HISTORICAL objectiveCompleted replay", () => {
    seedLeg();
    // Log said it was completed at some point.
    store.applyEvent(completedObj("m1", "d0", 1100), "live");
    expect(store.getMission("m1")!.legs[0].completed).toBe(true);

    // User manually un-checks (mistaken/auto-applied check).
    store.toggleLeg("m1", "d0", false);
    expect(store.getMission("m1")!.legs[0].completed).toBe(false);

    // Reset/Re-sync re-applies the historical backfill, which re-fires the
    // completion event as 'historical'. It must NOT re-complete the user's leg.
    store.applyEvent(completedObj("m1", "d0", 1100), "historical");
    const leg = store.getMission("m1")!.legs[0];
    expect(leg.completed).toBe(false);
    expect(leg.scuDelivered).toBe(0);
  });

  it("a genuinely-new LIVE objectiveCompleted still completes a manually-untouched leg", () => {
    seedLeg();
    // No manual toggle here -> live completion is honored normally.
    store.applyEvent(completedObj("m1", "d0", 1100), "live");
    expect(store.getMission("m1")!.legs[0].completed).toBe(true);
  });

  it("manual override also protects a manually-COMPLETED leg's scuDelivered on historical replay", () => {
    seedLeg();
    // User manually completes; then a historical replay should be a no-op clobber-wise.
    store.toggleLeg("m1", "d0", true);
    store.applyEvent(completedObj("m1", "d0", 1100), "historical");
    const leg = store.getMission("m1")!.legs[0];
    expect(leg.completed).toBe(true);
    expect(leg.scuDelivered).toBe(10);
  });

  it("updateMission can set completed both true and false (persisted)", () => {
    seedLeg();
    store.updateMission("m1", { legs: [{ legId: "d0", completed: true }] });
    expect(store.getMission("m1")!.legs[0].completed).toBe(true);
    store.updateMission("m1", { legs: [{ legId: "d0", completed: false }] });
    expect(store.getMission("m1")!.legs[0].completed).toBe(false);
  });
});

// =============================================================================
// FIX — editable leg fields for token-suppressed missions
// (the objectiveDeclared bug: blank commodity / scuTotal=0 / null location)
// =============================================================================

describe("leg field edits — fill in token-suppressed details", () => {
  // The bug case: marker-only mission (accept + CreateMarker, no objectiveDeclared).
  // The leg exists but commodity="", scuTotal=0, location=null -> invisible to
  // by-dropoff.
  const seedBlankLeg = (): void => {
    store.applyEvent(
      accepted("m1", "Senior Rank - Medium Cargo Haul", 1000),
      "live",
    );
    store.applyEvent(
      marker(
        "m1",
        "d0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
        1000,
      ),
      "live",
    );
  };

  it("a marker-only leg auto-fills commodity from the template, but SCU/location stay blank", () => {
    seedBlankLeg();
    const leg = store.getMission("m1")!.legs.find((l) => l.id === "d0")!;
    // FIX 2: commodity is now seeded from the contract template (was "").
    expect(leg.commodity).toBe("Waste");
    // SCU + location still come from the suppressed New Objective line -> blank.
    expect(leg.scuTotal).toBe(0);
    expect(leg.location).toBeNull();
    // Still not in by-dropoff (no location yet) — the user must add a destination.
    const refs = store
      .dropoffGroups(null)
      .flatMap((g) => [...g.todo, ...g.delivered].flatMap((c) => c.legRefs));
    expect(refs.some((r) => r.legId === "d0")).toBe(false);
  });

  it("patching commodity/scuTotal/location persists and stamps manual_override", () => {
    seedBlankLeg();
    store.updateMission("m1", {
      legs: [
        {
          legId: "d0",
          commodity: "Pressurized Ice",
          scuTotal: 42,
          location: "HDPC-Cassillo",
        },
      ],
    });
    const leg = store.getMission("m1")!.legs.find((l) => l.id === "d0")!;
    expect(leg.commodity).toBe("Pressurized Ice");
    expect(leg.scuTotal).toBe(42);
    expect(leg.location).toBe("HDPC-Cassillo");

    // manual_override must be stamped so a historical replay can't clobber it.
    // (Proven below; here we assert the persistence round-trips.)
    expect(store.getMission("m1")!.legs[0].scuTotal).toBe(42);
  });

  it("a filled-in leg now FLOWS INTO the by-dropoff aggregation (end-to-end)", () => {
    seedBlankLeg();
    // Before: absent.
    expect(
      store.dropoffGroups(null).find((g) => g.location === "HDPC-Cassillo"),
    ).toBeUndefined();

    // User fills it in.
    store.updateMission("m1", {
      legs: [
        {
          legId: "d0",
          commodity: "Pressurized Ice",
          scuTotal: 42,
          location: "HDPC-Cassillo",
        },
      ],
    });

    // After: appears, with the right remaining SCU.
    const g = store
      .dropoffGroups(null)
      .find((x) => x.location === "HDPC-Cassillo")!;
    expect(g).toBeDefined();
    const ice = g.todo.find((c) => c.commodity === "Pressurized Ice")!;
    expect(ice.scuRemaining).toBe(42);
    expect(ice.legRefs).toEqual([{ missionId: "m1", legId: "d0" }]);
  });

  it("field edits survive a HISTORICAL objectiveDeclared replay (manual override wins)", () => {
    seedBlankLeg();
    store.updateMission("m1", {
      legs: [
        {
          legId: "d0",
          commodity: "Pressurized Ice",
          scuTotal: 42,
          location: "HDPC-Cassillo",
        },
      ],
    });

    // A Reset/Re-sync re-runs backfill. If a stale/different historical
    // objectiveDeclared somehow fires for this leg, the user's values must win.
    store.applyEvent(
      declared("m1", "d0", "Quantanium", 999, "Some Other Place", 1000),
      "historical",
    );
    const leg = store.getMission("m1")!.legs.find((l) => l.id === "d0")!;
    expect(leg.commodity).toBe("Pressurized Ice");
    expect(leg.scuTotal).toBe(42);
    expect(leg.location).toBe("HDPC-Cassillo");
  });

  it("a genuinely-new LIVE objectiveDeclared still fills an un-touched leg", () => {
    seedBlankLeg();
    // No manual edit -> a later live declaration is honored normally.
    store.applyEvent(
      declared("m1", "d0", "Processed Food", 30, "Teasa Spaceport", 1100),
      "live",
    );
    const leg = store.getMission("m1")!.legs.find((l) => l.id === "d0")!;
    expect(leg.commodity).toBe("Processed Food");
    expect(leg.scuTotal).toBe(30);
    expect(leg.location).toBe("Teasa Spaceport");
  });

  it("location can be cleared back to null via an explicit null patch", () => {
    seedBlankLeg();
    store.updateMission("m1", {
      legs: [{ legId: "d0", location: "HDPC-Cassillo" }],
    });
    expect(store.getMission("m1")!.legs[0].location).toBe("HDPC-Cassillo");
    store.updateMission("m1", { legs: [{ legId: "d0", location: null }] });
    expect(store.getMission("m1")!.legs[0].location).toBeNull();
  });

  it("editing scuTotal on a completed leg keeps scuDelivered consistent", () => {
    seedBlankLeg();
    // Fill in, then mark delivered, then correct the SCU figure.
    store.updateMission("m1", {
      legs: [{ legId: "d0", commodity: "Ice", scuTotal: 10, location: "A" }],
    });
    store.updateMission("m1", { legs: [{ legId: "d0", completed: true }] });
    expect(store.getMission("m1")!.legs[0].scuDelivered).toBe(10);
    // Correct the total upward; delivered should track for a completed leg.
    store.updateMission("m1", { legs: [{ legId: "d0", scuTotal: 25 }] });
    const leg = store.getMission("m1")!.legs[0];
    expect(leg.scuTotal).toBe(25);
    expect(leg.scuDelivered).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Add / remove legs from an existing mission (Mission Detail panel).
// A Multi-to-Single / Single-to-Multi haul (or a log-suppressed mission) needs
// extra pickups/dropoffs added after the fact, and mistaken legs removed.
// ---------------------------------------------------------------------------
describe("updateMission add/remove legs", () => {
  const seedMission = (): void => {
    store.applyEvent(accepted("m1", "Hauling Job"), "live");
    store.applyEvent(
      marker(
        "m1",
        "d0",
        "dropoff",
        "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
        1000,
      ),
      "live",
    );
  };

  it("adds a new pickup leg with generated id, defaults, and manual_override", () => {
    seedMission();
    const before = store.getMission("m1")!.legs.length;
    store.updateMission("m1", {
      addLegs: [
        {
          kind: "pickup",
          commodity: "Titanium",
          scuTotal: 16,
          location: "Area18",
        },
      ],
    });
    const legs = store.getMission("m1")!.legs;
    expect(legs.length).toBe(before + 1);
    const added = legs.find(
      (l) => l.kind === "pickup" && l.commodity === "Titanium",
    )!;
    expect(added).toBeDefined();
    expect(added.id).not.toBe("d0");
    expect(added.scuTotal).toBe(16);
    expect(added.location).toBe("Area18");
    expect(added.completed).toBe(false);
    expect(added.scuDelivered).toBe(0);
    // manual_override must be stamped so a historical replay can't clobber it.
    const raw = (
      store as unknown as { db: import("better-sqlite3").Database }
    ).db // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .prepare(
        "SELECT manual_override FROM legs WHERE mission_id = 'm1' AND objective_id = @o",
      )
      .get({ o: added.id }) as { manual_override: number | null };
    expect(raw.manual_override).not.toBeNull();
  });

  it("adds a new dropoff leg with field defaults when omitted", () => {
    seedMission();
    store.updateMission("m1", { addLegs: [{ kind: "dropoff" }] });
    const added = store
      .getMission("m1")!
      .legs.filter((l) => l.kind === "dropoff")
      .find((l) => l.id !== "d0")!;
    expect(added).toBeDefined();
    expect(added.commodity).toBe("");
    expect(added.scuTotal).toBe(0);
    expect(added.location).toBeNull();
    expect(added.kind).toBe("dropoff");
  });

  it("two added legs in one patch get distinct ids", () => {
    seedMission();
    store.updateMission("m1", {
      addLegs: [{ kind: "pickup" }, { kind: "pickup" }],
    });
    const ids = store.getMission("m1")!.legs.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      store.getMission("m1")!.legs.filter((l) => l.kind === "pickup").length,
    ).toBe(2);
  });

  it("removes a leg by id (gone from legsFor)", () => {
    seedMission();
    store.updateMission("m1", {
      addLegs: [
        { kind: "pickup", commodity: "Gold", scuTotal: 8, location: "Area18" },
      ],
    });
    const added = store
      .getMission("m1")!
      .legs.find((l) => l.kind === "pickup")!;
    store.updateMission("m1", { removeLegIds: [added.id] });
    const legs = store.getMission("m1")!.legs;
    expect(legs.some((l) => l.id === added.id)).toBe(false);
    expect(legs.some((l) => l.id === "d0")).toBe(true);
  });

  it("a newly-added located dropoff leg appears in by-dropoff aggregation", () => {
    seedMission();
    store.updateMission("m1", {
      addLegs: [
        {
          kind: "dropoff",
          commodity: "Pressurized Ice",
          scuTotal: 30,
          location: "HDPC-Cassillo",
        },
      ],
    });
    const g = store
      .dropoffGroups(null)
      .find((x) => x.location === "HDPC-Cassillo")!;
    expect(g).toBeDefined();
    const ice = g.todo.find((c) => c.commodity === "Pressurized Ice")!;
    expect(ice.scuRemaining).toBe(30);
  });

  it("removing a dropoff leg removes it from by-dropoff aggregation", () => {
    seedMission();
    store.updateMission("m1", {
      addLegs: [
        {
          kind: "dropoff",
          commodity: "Quantanium",
          scuTotal: 12,
          location: "HDPC-Cassillo",
        },
      ],
    });
    const added = store
      .getMission("m1")!
      .legs.find((l) => l.commodity === "Quantanium")!;
    expect(
      store.dropoffGroups(null).find((x) => x.location === "HDPC-Cassillo"),
    ).toBeDefined();
    store.updateMission("m1", { removeLegIds: [added.id] });
    expect(
      store.dropoffGroups(null).find((x) => x.location === "HDPC-Cassillo"),
    ).toBeUndefined();
  });
});

// =============================================================================
// Phase B1 — partial turn-in (scuDelivered between 0 and scuTotal)
// =============================================================================

describe("partial turn-in", () => {
  const seed = (scuTotal = 100): void => {
    store.applyEvent(accepted("m1", "Haul", 1000), "live");
    store.applyEvent(
      declared("m1", "d0", "Ice", scuTotal, "HDPC-Cassillo", 1000),
      "live",
    );
  };

  it("updateMission persists a partial scuDelivered (no completion)", () => {
    seed(100);
    const m = store.updateMission("m1", {
      legs: [{ legId: "d0", scuDelivered: 60 }],
    });
    expect(m.legs[0].scuDelivered).toBe(60);
    expect(m.legs[0].completed).toBe(false);
  });

  it("a partial leg stays in by-dropoff todo with remaining = total - delivered", () => {
    seed(100);
    store.updateMission("m1", { legs: [{ legId: "d0", scuDelivered: 60 }] });
    const g = store
      .dropoffGroups(null)
      .find((x) => x.location === "HDPC-Cassillo")!;
    // Still outstanding (NOT delivered) until full.
    const ice = g.todo.find((c) => c.commodity === "Ice")!;
    expect(ice).toBeDefined();
    expect(ice.scuRemaining).toBe(40); // 100 - 60
    expect(g.scuRemaining).toBe(40);
    expect(g.allDone).toBe(false);
    // 60% delivered shows on the group progress.
    expect(g.pctDelivered).toBe(60);
  });

  it("checking the box from a partial fills to full (completed, scuDelivered = scuTotal)", () => {
    seed(100);
    // A second, still-open leg elsewhere keeps the mission non-terminal after d0
    // is fully delivered, so it stays in the active by-dropoff view (A1 would
    // otherwise roll a fully-delivered single-leg mission to 'complete' and
    // exclude it from dropoffGroups). It doesn't touch the Cassillo group below.
    store.applyEvent(
      declared("m1", "d1", "Food", 5, "Teasa Spaceport", 1000),
      "live",
    );
    store.updateMission("m1", { legs: [{ legId: "d0", scuDelivered: 60 }] });
    const m = store.toggleLeg("m1", "d0", true);
    const d0 = m.legs.find((l) => l.id === "d0")!;
    expect(d0.completed).toBe(true);
    expect(d0.scuDelivered).toBe(100);
    const g = store
      .dropoffGroups(null)
      .find((x) => x.location === "HDPC-Cassillo")!;
    expect(g.allDone).toBe(true);
  });

  it("un-checking resets a partial leg to 0 (completed=false, scuDelivered=0)", () => {
    seed(100);
    store.updateMission("m1", { legs: [{ legId: "d0", scuDelivered: 60 }] });
    const m = store.toggleLeg("m1", "d0", false);
    expect(m.legs[0].completed).toBe(false);
    expect(m.legs[0].scuDelivered).toBe(0);
  });

  it("delivering exactly scuTotal via scuDelivered does NOT auto-complete (box still drives completed)", () => {
    // scuDelivered alone never flips `completed`; only the checkbox/full toggle
    // does. A leg with scuDelivered == scuTotal but completed=false has 0
    // remaining yet is still 'open' -> stays in todo (suppressed-qty rule).
    seed(100);
    const m = store.updateMission("m1", {
      legs: [{ legId: "d0", scuDelivered: 100 }],
    });
    expect(m.legs[0].completed).toBe(false);
    const g = store
      .dropoffGroups(null)
      .find((x) => x.location === "HDPC-Cassillo")!;
    // Remaining is 0, but the leg is still open -> remains actionable in todo.
    const ice = g.todo.find((c) => c.commodity === "Ice")!;
    expect(ice).toBeDefined();
    expect(g.allDone).toBe(false);
  });
});

// =============================================================================
// Phase B2 — mission.reward (manual; drives the partial-payout estimate)
// =============================================================================

describe("mission reward", () => {
  it("defaults to null and is settable via updateMission, independent of payout", () => {
    store.applyEvent(accepted("m1", "Haul", 1000), "live");
    expect(store.getMission("m1")!.reward).toBeNull();

    const m = store.updateMission("m1", { reward: 130000 });
    expect(m.reward).toBe(130000);
    // Setting reward must NOT touch the actual logged payout / confidence.
    expect(m.payout).toBeNull();
    expect(m.payoutConfidence).toBe("unknown");
  });

  it("reward and payout coexist (estimate vs actual)", () => {
    store.applyEvent(accepted("m1", "Haul", 1000), "live");
    const m = store.updateMission("m1", { reward: 130000, payout: 124750 });
    expect(m.reward).toBe(130000);
    expect(m.payout).toBe(124750);
    expect(m.payoutConfidence).toBe("confirmed"); // payout edit -> confirmed
  });

  it("reward = null clears a previously-set reward", () => {
    store.applyEvent(accepted("m1", "Haul", 1000), "live");
    store.updateMission("m1", { reward: 99999 });
    expect(store.getMission("m1")!.reward).toBe(99999);
    const m = store.updateMission("m1", { reward: null });
    expect(m.reward).toBeNull();
  });

  it("reward survives a manual mission round-trip (defaults null)", () => {
    const created = store.addManualMission({
      title: "Manual",
      giver: "Covalex Hauling",
      status: "accepted",
      legs: [],
    });
    expect(created.reward).toBeNull();
    const m = store.updateMission(created.id, { reward: 75000 });
    expect(store.getMission(m.id)!.reward).toBe(75000);
  });
});
