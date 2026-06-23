// ============================================================================
// nextStop.test.ts — pure "next stop" derivation for the overlay (Phase D).
// ----------------------------------------------------------------------------
// Covers: empty/no-active cases, cleared-stop exclusion, cargo-line aggregation
// (matches By-Dropoff), optimizer-driven ordering (positions decide "next"),
// current-location flag passthrough, and the needs-location bucket.
// ============================================================================

import { describe, it, expect } from "vitest";
import type { Mission, Leg, Position } from "@shared/types";
import { nextStops } from "./nextStop";

// --- builders ---------------------------------------------------------------

function leg(
  over: Partial<Leg> & { id: string; missionId: string; scu?: number },
): Leg {
  return {
    id: over.id,
    missionId: over.missionId,
    kind: over.kind ?? "dropoff",
    commodity: over.commodity ?? "Laranite",
    scuTotal: over.scuTotal ?? over.scu ?? 10,
    scuDelivered: over.scuDelivered ?? 0,
    // Preserve an explicit `location: null` (a log-suppressed destination);
    // only default to "Loc" when the caller omits the key entirely.
    location: "location" in over ? (over.location ?? null) : "Loc",
    position: over.position,
    completed: over.completed ?? false,
  };
}

function mission(
  id: string,
  legs: Leg[],
  over: Partial<Mission> = {},
): Mission {
  return {
    id,
    title: over.title ?? "Cargo Haul",
    giver: over.giver ?? "Test_Hauling",
    variant: over.variant ?? "A_TO_B",
    grade: over.grade ?? "SMALL",
    status: over.status ?? "in_progress",
    payout: over.payout ?? null,
    payoutConfidence: over.payoutConfidence ?? "unknown",
    reward: over.reward ?? null,
    source: over.source ?? "log",
    acceptedAt: over.acceptedAt ?? 0,
    completedAt: over.completedAt ?? null,
    notes: over.notes ?? "",
    legs,
  };
}

const pos = (x: number, y: number, z: number): Position => ({ x, y, z });

// --- tests ------------------------------------------------------------------

describe("nextStops", () => {
  it("returns no stops for an empty mission set", () => {
    expect(nextStops([], null).stops).toEqual([]);
  });

  it("ignores terminal (history) missions", () => {
    const m = mission(
      "m1",
      [leg({ id: "d", missionId: "m1", location: "A", scu: 50 })],
      { status: "complete" },
    );
    expect(nextStops([m], null).stops).toEqual([]);
  });

  it("excludes a fully-delivered (cleared) stop", () => {
    const m = mission("m1", [
      leg({
        id: "d",
        missionId: "m1",
        location: "A",
        scu: 50,
        scuDelivered: 50,
        completed: true,
      }),
    ]);
    expect(nextStops([m], null).stops).toEqual([]);
  });

  it("aggregates cargo lines per location (matches By-Dropoff)", () => {
    const m = mission("m1", [
      leg({
        id: "d1",
        missionId: "m1",
        location: "A",
        commodity: "Gold",
        scu: 20,
      }),
      leg({
        id: "d2",
        missionId: "m1",
        location: "A",
        commodity: "Iron",
        scu: 80,
      }),
    ]);
    const { stops } = nextStops([m], null);
    expect(stops).toHaveLength(1);
    expect(stops[0].location).toBe("A");
    expect(stops[0].scuRemaining).toBe(100);
    // Lines sorted by remaining desc -> Iron (80) before Gold (20).
    expect(stops[0].lines.map((l) => l.commodity)).toEqual(["Iron", "Gold"]);
    expect(stops[0].lines.map((l) => l.scuRemaining)).toEqual([80, 20]);
  });

  it("orders stops by the optimizer's visit order using positions", () => {
    // Pending pickup at Origin (a positioned anchor); currentLocation="Origin"
    // resolves the optimizer's START there. Of the two dropoffs, B (x=10) is
    // closer than A (x=100), so nearest-neighbor visits B before A. The pickup
    // itself is not a dropoff -> it never appears as an overlay stop.
    const m = mission("m1", [
      leg({
        id: "p",
        missionId: "m1",
        kind: "pickup",
        location: "Origin",
        scu: 100,
        position: pos(0, 0, 0),
      }),
      leg({
        id: "dA",
        missionId: "m1",
        kind: "dropoff",
        location: "A",
        scu: 40,
        position: pos(100, 0, 0),
      }),
      leg({
        id: "dB",
        missionId: "m1",
        kind: "dropoff",
        location: "B",
        scu: 60,
        position: pos(10, 0, 0),
      }),
    ]);
    const { stops } = nextStops([m], "Origin");
    expect(stops.map((s) => s.location)).toEqual(["B", "A"]);
  });

  it("passes through the current-location flag (YOU ARE HERE)", () => {
    const m = mission("m1", [
      leg({ id: "d", missionId: "m1", location: "Everus Harbor", scu: 30 }),
    ]);
    const { stops } = nextStops([m], "Everus Harbor");
    expect(stops[0].isCurrentLocation).toBe(true);
  });

  it("flags a stop the log never gave a destination", () => {
    const m = mission("m1", [
      leg({ id: "d", missionId: "m1", location: null, scu: 25 }),
    ]);
    const { stops } = nextStops([m], null);
    expect(stops).toHaveLength(1);
    expect(stops[0].needsLocation).toBe(true);
  });
});
