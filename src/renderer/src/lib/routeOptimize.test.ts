// ============================================================================
// routeOptimize.test.ts — pure route optimizer (Phase C).
// ----------------------------------------------------------------------------
// Covers: distance/pathDistance geometry, stop construction (active + pending
// only), precedence (never violated), capacity (never exceeded when set + honest
// infeasible flag), missing-position handling (appended, stable, flagged),
// determinism, a known-geometry case where NN+2-opt beats the naive order, and
// empty/one-stop edge cases.
// ============================================================================

import { describe, it, expect } from "vitest";
import type { Mission, Leg, Position } from "@shared/types";
import {
  distance,
  pathDistance,
  buildStops,
  buildPrecedence,
  precedenceOk,
  capacityOk,
  optimizeRoute,
  resolveStartPosition,
  locationVisitOrder,
  type Stop,
} from "./routeOptimize";

// --- builders ---------------------------------------------------------------

// `scu` is a convenience alias for scuTotal in these fixtures.
function leg(
  over: Partial<Leg> & { id: string; missionId: string; scu?: number },
): Leg {
  return {
    id: over.id,
    missionId: over.missionId,
    kind: over.kind ?? "pickup",
    commodity: over.commodity ?? "Laranite",
    scuTotal: over.scuTotal ?? over.scu ?? 10,
    scuDelivered: over.scuDelivered ?? 0,
    location: over.location ?? "Loc",
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
    acceptedAt: over.acceptedAt ?? null,
    completedAt: over.completedAt ?? null,
    notes: over.notes ?? "",
    legs,
  };
}

const P = (x: number, y: number, z = 0): Position => ({ x, y, z });

function stopOf(over: Partial<Stop> & { id: string }): Stop {
  return {
    id: over.id,
    kind: over.kind ?? "pickup",
    // preserve an explicit `null` location (only default when the key is absent)
    location: "location" in over ? (over.location ?? null) : "Loc",
    position: over.position,
    commodity: over.commodity ?? "Laranite",
    scu: over.scu ?? 10,
    missionId: over.missionId ?? "m1",
    legId: over.legId ?? "l1",
    missingPosition: over.missingPosition ?? over.position == null,
  };
}

// --- geometry ---------------------------------------------------------------

describe("distance", () => {
  it("computes 3-4-5 Euclidean distance", () => {
    expect(distance(P(0, 0, 0), P(3, 4, 0))).toBeCloseTo(5);
  });
  it("includes the z axis", () => {
    expect(distance(P(0, 0, 0), P(0, 0, 2))).toBeCloseTo(2);
  });
});

describe("pathDistance", () => {
  it("sums consecutive positioned legs, optionally from start", () => {
    const stops = [
      stopOf({ id: "a", position: P(0, 0) }),
      stopOf({ id: "b", position: P(0, 10) }),
      stopOf({ id: "c", position: P(0, 25) }),
    ];
    expect(pathDistance(stops)).toBeCloseTo(25); // 10 + 15
    expect(pathDistance(stops, P(0, -5))).toBeCloseTo(30); // +5 from start
  });
  it("skips position-less stops without breaking the chain", () => {
    const stops = [
      stopOf({ id: "a", position: P(0, 0) }),
      stopOf({ id: "x", position: undefined, missingPosition: true }),
      stopOf({ id: "b", position: P(0, 10) }),
    ];
    expect(pathDistance(stops)).toBeCloseTo(10);
  });
});

// --- buildStops -------------------------------------------------------------

describe("buildStops", () => {
  it("flattens active missions into one stop per pending leg", () => {
    const m = mission("m1", [
      leg({ id: "p1", missionId: "m1", kind: "pickup" }),
      leg({ id: "d1", missionId: "m1", kind: "dropoff" }),
    ]);
    const stops = buildStops([m]);
    expect(stops.map((s) => s.id)).toEqual(["m1:p1", "m1:d1"]);
    expect(stops[0].kind).toBe("pickup");
    expect(stops[1].kind).toBe("dropoff");
  });

  it("excludes completed legs and terminal/inactive missions", () => {
    const active = mission("m1", [
      leg({ id: "p1", missionId: "m1", completed: true }),
      leg({ id: "d1", missionId: "m1", kind: "dropoff" }),
    ]);
    const done = mission("m2", [leg({ id: "p2", missionId: "m2" })], {
      status: "complete",
    });
    const stops = buildStops([active, done]);
    expect(stops.map((s) => s.id)).toEqual(["m1:d1"]);
  });

  it("flags missing positions", () => {
    const m = mission("m1", [
      leg({ id: "p1", missionId: "m1", position: P(1, 2, 3) }),
      leg({ id: "p2", missionId: "m1", position: undefined }),
    ]);
    const stops = buildStops([m]);
    expect(stops[0].missingPosition).toBe(false);
    expect(stops[1].missingPosition).toBe(true);
  });
});

// --- precedence -------------------------------------------------------------

describe("buildPrecedence / precedenceOk", () => {
  it("a dropoff requires its same-mission same-commodity pickup", () => {
    const stops = buildStops([
      mission("m1", [
        leg({ id: "p1", missionId: "m1", kind: "pickup", commodity: "Gold" }),
        leg({ id: "d1", missionId: "m1", kind: "dropoff", commodity: "Gold" }),
      ]),
    ]);
    const prec = buildPrecedence(stops);
    expect(prec.get("m1:d1")).toEqual(new Set(["m1:p1"]));

    const pickupFirst = [
      stops.find((s) => s.id === "m1:p1")!,
      stops.find((s) => s.id === "m1:d1")!,
    ];
    const dropFirst = [...pickupFirst].reverse();
    expect(precedenceOk(pickupFirst, prec)).toBe(true);
    expect(precedenceOk(dropFirst, prec)).toBe(false);
  });

  it("does not couple pickups/dropoffs across missions", () => {
    const stops = buildStops([
      mission("m1", [
        leg({ id: "p1", missionId: "m1", kind: "pickup", commodity: "Gold" }),
      ]),
      mission("m2", [
        leg({ id: "d2", missionId: "m2", kind: "dropoff", commodity: "Gold" }),
      ]),
    ]);
    const prec = buildPrecedence(stops);
    expect(prec.has("m2:d2")).toBe(false);
  });

  it("a dropoff with no matching pickup is unconstrained", () => {
    const stops = buildStops([
      mission("m1", [
        leg({ id: "d1", missionId: "m1", kind: "dropoff", commodity: "Gold" }),
      ]),
    ]);
    expect(buildPrecedence(stops).has("m1:d1")).toBe(false);
  });
});

// --- capacity ---------------------------------------------------------------

describe("capacityOk", () => {
  const stops = [
    stopOf({ id: "p1", kind: "pickup", scu: 60 }),
    stopOf({ id: "p2", kind: "pickup", scu: 60 }),
    stopOf({ id: "d1", kind: "dropoff", scu: 60 }),
    stopOf({ id: "d2", kind: "dropoff", scu: 60 }),
  ];
  it("no capacity (0) always passes", () => {
    expect(capacityOk(stops, 0)).toBe(true);
  });
  it("rejects an order that exceeds the hold", () => {
    // p1, p2 -> load 120 > 100
    expect(capacityOk(stops, 100)).toBe(false);
  });
  it("accepts an interleaved order within the hold", () => {
    const ok = [stops[0], stops[2], stops[1], stops[3]]; // p1 d1 p2 d2 -> max 60
    expect(capacityOk(ok, 100)).toBe(true);
  });
});

// --- optimizeRoute: edges ---------------------------------------------------

describe("optimizeRoute edge cases", () => {
  it("empty -> empty, zero distance, no flags", () => {
    const r = optimizeRoute([]);
    expect(r.ordered).toEqual([]);
    expect(r.totalDistance).toBe(0);
    expect(r.hasMissingPositions).toBe(false);
    expect(r.infeasibleCapacity).toBe(false);
  });

  it("single stop -> returned as-is, zero distance", () => {
    const r = optimizeRoute([
      mission("m1", [leg({ id: "p1", missionId: "m1", position: P(5, 5) })]),
    ]);
    expect(r.ordered.map((s) => s.id)).toEqual(["m1:p1"]);
    expect(r.totalDistance).toBe(0);
  });
});

// --- optimizeRoute: missing positions --------------------------------------

describe("optimizeRoute missing positions", () => {
  it("appends position-less stops at the end, stable by id, flagged", () => {
    const r = optimizeRoute([
      mission("m1", [
        leg({ id: "p1", missionId: "m1", kind: "pickup", position: P(0, 0) }),
        leg({ id: "d1", missionId: "m1", kind: "dropoff", position: P(0, 10) }),
        leg({ id: "zNoPos", missionId: "m1", kind: "pickup", commodity: "X" }),
        leg({ id: "aNoPos", missionId: "m1", kind: "pickup", commodity: "Y" }),
      ]),
    ]);
    expect(r.hasMissingPositions).toBe(true);
    const ids = r.ordered.map((s) => s.id);
    // positioned first (some order), then missing sorted by id
    expect(ids.slice(-2)).toEqual(["m1:aNoPos", "m1:zNoPos"]);
    expect(r.ordered.find((s) => s.id === "m1:aNoPos")!.missingPosition).toBe(
      true,
    );
  });

  it("positioned dropoff + unsequenced pickup -> no crash, pickup trails", () => {
    // The pickup has no position so it can't be geometrically sequenced; it is
    // appended to the unsequenced group rather than constraining the dropoff.
    const r = optimizeRoute([
      mission("m1", [
        leg({ id: "pNo", missionId: "m1", kind: "pickup", commodity: "Au" }),
        leg({
          id: "dPos",
          missionId: "m1",
          kind: "dropoff",
          commodity: "Au",
          position: P(0, 5),
        }),
      ]),
    ]);
    const ids = r.ordered.map((s) => s.id);
    expect(ids).toEqual(["m1:dPos", "m1:pNo"]);
    expect(r.hasMissingPositions).toBe(true);
  });

  it("all stops missing positions -> stable order, zero distance", () => {
    const r = optimizeRoute([
      mission("m1", [
        leg({ id: "b", missionId: "m1" }),
        leg({ id: "a", missionId: "m1" }),
      ]),
    ]);
    expect(r.ordered.map((s) => s.id)).toEqual(["m1:a", "m1:b"]);
    expect(r.totalDistance).toBe(0);
  });
});

// --- optimizeRoute: precedence never violated -------------------------------

describe("optimizeRoute precedence", () => {
  it("never places a dropoff before its supplying pickup", () => {
    // Geometry deliberately tempts placing the dropoff first (it's nearer start).
    const r = optimizeRoute(
      [
        mission("m1", [
          leg({
            id: "p1",
            missionId: "m1",
            kind: "pickup",
            commodity: "Gold",
            position: P(0, 100),
          }),
          leg({
            id: "d1",
            missionId: "m1",
            kind: "dropoff",
            commodity: "Gold",
            position: P(0, 1),
          }),
        ]),
      ],
      { start: P(0, 0) },
    );
    const ids = r.ordered.map((s) => s.id);
    expect(ids.indexOf("m1:p1")).toBeLessThan(ids.indexOf("m1:d1"));
  });
});

// --- optimizeRoute: capacity never exceeded ---------------------------------

describe("optimizeRoute capacity", () => {
  it("keeps running load within a set capacity by interleaving", () => {
    // Two A->B hauls of 60 SCU each; hold = 100. Must not carry both pickups at
    // once -> p,d,p,d style ordering.
    const r = optimizeRoute(
      [
        mission("m1", [
          leg({
            id: "p1",
            missionId: "m1",
            kind: "pickup",
            scu: 60,
            position: P(0, 0),
          }),
          leg({
            id: "d1",
            missionId: "m1",
            kind: "dropoff",
            scu: 60,
            position: P(0, 5),
          }),
        ]),
        mission("m2", [
          leg({
            id: "p2",
            missionId: "m2",
            kind: "pickup",
            scu: 60,
            position: P(0, 10),
          }),
          leg({
            id: "d2",
            missionId: "m2",
            kind: "dropoff",
            scu: 60,
            position: P(0, 15),
          }),
        ]),
      ],
      { capacity: 100 },
    );
    expect(capacityOk(r.ordered, 100)).toBe(true);
    expect(r.infeasibleCapacity).toBe(false);
  });

  it("flags infeasibleCapacity when a single pickup exceeds the hold", () => {
    const r = optimizeRoute(
      [
        mission("m1", [
          leg({
            id: "p1",
            missionId: "m1",
            kind: "pickup",
            scu: 500,
            position: P(0, 0),
          }),
          leg({
            id: "d1",
            missionId: "m1",
            kind: "dropoff",
            scu: 500,
            position: P(0, 5),
          }),
        ]),
      ],
      { capacity: 100 },
    );
    expect(r.infeasibleCapacity).toBe(true);
    // still returns a best-effort order
    expect(r.ordered.length).toBe(2);
  });

  it("no capacity given -> never flags infeasible even with huge loads", () => {
    const r = optimizeRoute([
      mission("m1", [
        leg({
          id: "p1",
          missionId: "m1",
          kind: "pickup",
          scu: 9999,
          position: P(0, 0),
        }),
        leg({
          id: "d1",
          missionId: "m1",
          kind: "dropoff",
          scu: 9999,
          position: P(0, 5),
        }),
      ]),
    ]);
    expect(r.infeasibleCapacity).toBe(false);
  });
});

// --- optimizeRoute: known geometry (NN + 2-opt beats naive) -----------------

describe("optimizeRoute known geometry", () => {
  it("orders 4 collinear pickups by proximity from start (shorter than input)", () => {
    // Stops on a line at y = 0,10,20,30 but fed in a scrambled order. With no
    // precedence/capacity (all pickups), the optimal visit from start(0,-5) is
    // simply 0->10->20->30. Naive (input) order is longer.
    const m = mission("m1", [
      leg({
        id: "p30",
        missionId: "m1",
        kind: "pickup",
        commodity: "A",
        position: P(0, 30),
      }),
      leg({
        id: "p00",
        missionId: "m1",
        kind: "pickup",
        commodity: "B",
        position: P(0, 0),
      }),
      leg({
        id: "p20",
        missionId: "m1",
        kind: "pickup",
        commodity: "C",
        position: P(0, 20),
      }),
      leg({
        id: "p10",
        missionId: "m1",
        kind: "pickup",
        commodity: "D",
        position: P(0, 10),
      }),
    ]);
    const r = optimizeRoute([m], { start: P(0, -5) });
    expect(r.ordered.map((s) => s.id)).toEqual([
      "m1:p00",
      "m1:p10",
      "m1:p20",
      "m1:p30",
    ]);
    expect(r.totalDistance).toBeCloseTo(35); // 5 + 10 + 10 + 10
  });

  it("improves a deliberately crossed square via 2-opt", () => {
    // Unit square corners; a crossed tour is longer than the perimeter tour.
    const m = mission("m1", [
      leg({
        id: "a",
        missionId: "m1",
        kind: "pickup",
        commodity: "1",
        position: P(0, 0),
      }),
      leg({
        id: "b",
        missionId: "m1",
        kind: "pickup",
        commodity: "2",
        position: P(10, 10),
      }),
      leg({
        id: "c",
        missionId: "m1",
        kind: "pickup",
        commodity: "3",
        position: P(10, 0),
      }),
      leg({
        id: "d",
        missionId: "m1",
        kind: "pickup",
        commodity: "4",
        position: P(0, 10),
      }),
    ]);
    const r = optimizeRoute([m], { start: P(0, 0) });
    // Perimeter path from (0,0): 0,0 -> 10,0 -> 10,10 -> 0,10 = 30. A crossed
    // path (e.g. via diagonals) is strictly longer.
    expect(r.totalDistance).toBeCloseTo(30);
  });
});

// --- optimizeRoute: determinism ---------------------------------------------

describe("optimizeRoute determinism", () => {
  const build = (): Mission[] => [
    mission("m1", [
      leg({
        id: "p1",
        missionId: "m1",
        kind: "pickup",
        commodity: "Gold",
        scu: 40,
        position: P(3, 7),
      }),
      leg({
        id: "d1",
        missionId: "m1",
        kind: "dropoff",
        commodity: "Gold",
        scu: 40,
        position: P(9, 2),
      }),
    ]),
    mission("m2", [
      leg({
        id: "p2",
        missionId: "m2",
        kind: "pickup",
        commodity: "Ore",
        scu: 30,
        position: P(1, 1),
      }),
      leg({
        id: "d2",
        missionId: "m2",
        kind: "dropoff",
        commodity: "Ore",
        scu: 30,
        position: P(8, 8),
      }),
    ]),
  ];

  it("produces an identical order across repeated runs", () => {
    const a = optimizeRoute(build(), { capacity: 100, start: P(0, 0) });
    const b = optimizeRoute(build(), { capacity: 100, start: P(0, 0) });
    expect(a.ordered.map((s) => s.id)).toEqual(b.ordered.map((s) => s.id));
    expect(a.totalDistance).toBeCloseTo(b.totalDistance);
  });

  it("is independent of input mission order (canonical via id tie-breaks)", () => {
    const forward = optimizeRoute(build(), { start: P(0, 0) });
    const reversed = optimizeRoute([...build()].reverse(), { start: P(0, 0) });
    // Distances must match; the geometric optimum is order-independent.
    expect(forward.totalDistance).toBeCloseTo(reversed.totalDistance);
  });
});

// --- resolveStartPosition ---------------------------------------------------

describe("resolveStartPosition", () => {
  const missions = [
    mission("m1", [
      leg({
        id: "p1",
        missionId: "m1",
        kind: "pickup",
        location: "Area18",
        position: P(7, 7, 7),
      }),
      leg({
        id: "d1",
        missionId: "m1",
        kind: "dropoff",
        location: "Lorville",
        position: P(1, 2, 3),
      }),
    ]),
  ];

  it("returns null when currentLocation is null", () => {
    expect(resolveStartPosition(missions, null)).toBeNull();
  });

  it("resolves the position of a confidently-matched pending leg", () => {
    expect(resolveStartPosition(missions, "Area18")).toEqual(P(7, 7, 7));
  });

  it("returns null when no leg matches the location", () => {
    expect(resolveStartPosition(missions, "Nowhere Station")).toBeNull();
  });
});

// --- locationVisitOrder -----------------------------------------------------

describe("locationVisitOrder", () => {
  it("numbers each location by first appearance, skipping missing/null", () => {
    const ordered: Stop[] = [
      stopOf({ id: "a", location: "Alpha", position: P(0, 0) }),
      stopOf({ id: "b", location: "Beta", position: P(0, 1) }),
      // repeat of Alpha keeps its first number
      stopOf({ id: "c", location: "Alpha", position: P(0, 2) }),
      // unsequenced / null are skipped
      stopOf({ id: "d", location: "Gamma", missingPosition: true }),
      stopOf({ id: "e", location: null, position: P(0, 3) }),
    ];
    const m = locationVisitOrder(ordered);
    expect(m.get("Alpha")).toBe(1);
    expect(m.get("Beta")).toBe(2);
    expect(m.has("Gamma")).toBe(false);
    expect(m.size).toBe(2);
  });
});
