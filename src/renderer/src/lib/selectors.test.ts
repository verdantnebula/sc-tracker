// selectors.test.ts — pure renderer derivations. Focused on the "incomplete"
// predicate that drives the ⚠ Details-missing indicator (the token-suppressed
// objectiveDeclared bug), plus the by-dropoff appearance once a leg is filled in.
import { describe, it, expect } from "vitest";
import type { Mission, Leg, LogPathInfo, LogStatus } from "@shared/types";
import {
  isLegIncomplete,
  isMissionIncomplete,
  missionTotals,
  dropoffGroups,
  pickupGroups,
  routeEdges,
  routeStopCount,
  shouldShowLogBanner,
  UNKNOWN_DESTINATION,
  UNKNOWN_PICKUP,
  UNKNOWN_ROUTE_NODE,
} from "./selectors";

function leg(partial: Partial<Leg>): Leg {
  return {
    id: "d0",
    missionId: "m1",
    kind: "dropoff",
    commodity: "",
    scuTotal: 0,
    scuDelivered: 0,
    location: null,
    completed: false,
    ...partial,
  };
}

function mission(legs: Leg[]): Mission {
  return {
    id: "m1",
    title: "Senior Rank - Medium Cargo Haul",
    giver: "Covalex_Hauling",
    variant: "SINGLE_TO_MULTI",
    grade: "BULK",
    status: "accepted",
    payout: null,
    payoutConfidence: "unknown",
    reward: null,
    source: "log",
    acceptedAt: 1000,
    completedAt: null,
    notes: "",
    legs,
  };
}

describe("isLegIncomplete", () => {
  it("a dropoff with no location is incomplete", () => {
    expect(isLegIncomplete(leg({ scuTotal: 10, location: null }))).toBe(true);
  });

  it("a dropoff with scuTotal 0 is incomplete", () => {
    expect(
      isLegIncomplete(leg({ scuTotal: 0, location: "HDPC-Cassillo" })),
    ).toBe(true);
  });

  it("a fully-detailed dropoff is complete", () => {
    expect(
      isLegIncomplete(leg({ scuTotal: 10, location: "HDPC-Cassillo" })),
    ).toBe(false);
  });

  it("a blank PICKUP is not flagged (pickups don't feed by-dropoff)", () => {
    expect(
      isLegIncomplete(leg({ kind: "pickup", scuTotal: 0, location: null })),
    ).toBe(false);
  });
});

describe("isMissionIncomplete", () => {
  it("flags a mission with any token-suppressed dropoff leg", () => {
    const m = mission([
      leg({ id: "d0", commodity: "", scuTotal: 0, location: null }),
      leg({ id: "d1", commodity: "Ice", scuTotal: 10, location: "A" }),
    ]);
    expect(isMissionIncomplete(m)).toBe(true);
  });

  it("does NOT flag a fully-detailed mission", () => {
    const m = mission([
      leg({ id: "d0", commodity: "Ice", scuTotal: 10, location: "A" }),
      leg({ id: "d1", commodity: "Food", scuTotal: 20, location: "B" }),
    ]);
    expect(isMissionIncomplete(m)).toBe(false);
  });

  it("a mission whose only blank leg is a pickup is not flagged", () => {
    const m = mission([
      leg({
        id: "p0",
        kind: "pickup",
        commodity: "",
        scuTotal: 0,
        location: null,
      }),
      leg({ id: "d0", commodity: "Ice", scuTotal: 10, location: "A" }),
    ]);
    expect(isMissionIncomplete(m)).toBe(false);
  });
});

describe("filled-in leg flows into by-dropoff (renderer selector)", () => {
  it("a blank leg is absent; once filled it appears with the right remaining SCU", () => {
    const blank = mission([
      leg({ id: "d0", commodity: "", scuTotal: 0, location: null }),
    ]);
    // Blank dropoff falls under the needs-location bucket with 0 remaining.
    const before = dropoffGroups([blank], null);
    expect(before.find((g) => g.location === "HDPC-Cassillo")).toBeUndefined();
    expect(
      before.find((g) => g.location === UNKNOWN_DESTINATION),
    ).toBeDefined();

    const filled = mission([
      leg({
        id: "d0",
        commodity: "Pressurized Ice",
        scuTotal: 42,
        location: "HDPC-Cassillo",
      }),
    ]);
    const after = dropoffGroups([filled], null);
    const g = after.find((x) => x.location === "HDPC-Cassillo")!;
    expect(g).toBeDefined();
    const ice = g.todo.find((c) => c.commodity === "Pressurized Ice")!;
    expect(ice.scuRemaining).toBe(42);
    expect(g.allDone).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The synthetic "needs a destination" bucket: dropoff legs with null location
// land here, the group is flagged `needsLocation`, it floats to the top of the
// list (most actionable), and its commodity line carries the legRefs so the UI
// can resolve each leg for inline editing. Normal grouping is unchanged.
// ---------------------------------------------------------------------------
describe("needs-location group (UNKNOWN_DESTINATION / needsLocation)", () => {
  it("a null-location dropoff lands in the needsLocation group with that flag set", () => {
    const m = mission([
      leg({ id: "d0", commodity: "Titanium", scuTotal: 0, location: null }),
    ]);
    const groups = dropoffGroups([m], null);
    const g = groups.find((x) => x.location === UNKNOWN_DESTINATION)!;
    expect(g).toBeDefined();
    expect(g.needsLocation).toBe(true);
    // The leg is preserved as a ref so the UI can resolve + edit it inline.
    const line = g.todo.find((c) => c.commodity === "Titanium")!;
    expect(line).toBeDefined();
    expect(line.legRefs).toEqual([{ missionId: "m1", legId: "d0" }]);
  });

  it("a known-location group is NOT flagged needsLocation", () => {
    const m = mission([
      leg({ id: "d0", commodity: "Ice", scuTotal: 10, location: "A" }),
    ]);
    const groups = dropoffGroups([m], null);
    const g = groups.find((x) => x.location === "A")!;
    expect(g).toBeDefined();
    expect(g.needsLocation).toBe(false);
  });

  it("the needs-location group floats above normal active stops", () => {
    const m = mission([
      // A real stop with lots of remaining SCU…
      leg({ id: "d0", commodity: "Ice", scuTotal: 500, location: "A" }),
      // …and a suppressed leg with 0 remaining that must still surface first.
      leg({ id: "d1", commodity: "Gold", scuTotal: 0, location: null }),
    ]);
    const groups = dropoffGroups([m], null);
    expect(groups[0].location).toBe(UNKNOWN_DESTINATION);
    expect(groups[0].needsLocation).toBe(true);
  });

  it("a COMPLETED null-location dropoff (suppressed delivery) emits NO needsLocation group", () => {
    // A dropoff leg with no destination that the user checked off without ever
    // assigning a location would land in the needs-location bucket's `delivered`
    // tray, leaving `todo` empty -> allDone && needsLocation -> a nonsensical
    // already-CLEARED "Set destination" card. The action prompt must not exist
    // when there's nothing left needing a destination.
    const m = mission([
      leg({
        id: "d0",
        commodity: "Gold",
        scuTotal: 0,
        location: null,
        completed: true,
      }),
    ]);
    const groups = dropoffGroups([m], null);
    expect(groups.find((g) => g.needsLocation)).toBeUndefined();
    expect(
      groups.find((g) => g.location === UNKNOWN_DESTINATION),
    ).toBeUndefined();
  });

  it("an UNDELIVERED null-location dropoff STILL emits a needsLocation group (regression guard)", () => {
    const m = mission([
      leg({
        id: "d0",
        commodity: "Titanium",
        scuTotal: 0,
        location: null,
        completed: false,
      }),
    ]);
    const groups = dropoffGroups([m], null);
    const g = groups.find((x) => x.needsLocation);
    expect(g).toBeDefined();
    expect(g!.location).toBe(UNKNOWN_DESTINATION);
    expect(g!.todo.length).toBeGreaterThan(0);
  });

  it("a MIX of undelivered + completed null-location legs keeps the needsLocation group with only the undelivered todo", () => {
    const m = mission([
      // suppressed delivery already checked off (no destination) -> delivered tray
      leg({
        id: "d0",
        commodity: "Gold",
        scuTotal: 0,
        location: null,
        completed: true,
      }),
      // still needs a destination -> keeps the action prompt alive
      leg({
        id: "d1",
        commodity: "Titanium",
        scuTotal: 12,
        location: null,
        completed: false,
      }),
    ]);
    const groups = dropoffGroups([m], null);
    const g = groups.find((x) => x.needsLocation);
    expect(g).toBeDefined();
    expect(g!.allDone).toBe(false);
    expect(g!.todo.map((c) => c.commodity)).toEqual(["Titanium"]);
  });

  it("aggregates null-location legs across missions into one bucket with all refs", () => {
    const a = {
      ...mission([
        leg({
          id: "x",
          missionId: "mA",
          commodity: "Ore",
          scuTotal: 0,
          location: null,
        }),
      ]),
      id: "mA",
    };
    const b = {
      ...mission([
        leg({
          id: "y",
          missionId: "mB",
          commodity: "Ore",
          scuTotal: 0,
          location: null,
        }),
      ]),
      id: "mB",
    };
    const groups = dropoffGroups([a, b], null);
    const g = groups.find((x) => x.location === UNKNOWN_DESTINATION)!;
    const line = g.todo.find((c) => c.commodity === "Ore")!;
    expect(line.legRefs).toEqual([
      { missionId: "mA", legId: "x" },
      { missionId: "mB", legId: "y" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// pickupGroups — the pickup mirror of dropoffGroups (ROUTE tab LIST left column).
// Same grouping/sorting/needs-location-drop behavior, but over pickup legs and
// the UNKNOWN_PICKUP sentinel.
// ---------------------------------------------------------------------------
describe("pickupGroups", () => {
  it("groups pickup legs by source location with remaining SCU", () => {
    const m = mission([
      leg({
        id: "p0",
        kind: "pickup",
        commodity: "Ice",
        scuTotal: 30,
        location: "Origin",
      }),
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Ice",
        scuTotal: 30,
        location: "Dest",
      }),
    ]);
    const groups = pickupGroups([m], null);
    // Only the pickup leg feeds this view — the dropoff is ignored.
    expect(groups.map((g) => g.location)).toEqual(["Origin"]);
    const g = groups[0];
    const ice = g.todo.find((c) => c.commodity === "Ice")!;
    expect(ice.scuRemaining).toBe(30);
    expect(ice.legRefs).toEqual([{ missionId: "m1", legId: "p0" }]);
    expect(g.needsLocation).toBe(false);
  });

  it("a null-location pickup lands in the UNKNOWN_PICKUP needsLocation bucket", () => {
    const m = mission([
      leg({
        id: "p0",
        kind: "pickup",
        commodity: "Gold",
        scuTotal: 12,
        location: null,
      }),
    ]);
    const groups = pickupGroups([m], null);
    const g = groups.find((x) => x.location === UNKNOWN_PICKUP)!;
    expect(g).toBeDefined();
    expect(g.needsLocation).toBe(true);
    expect(g.todo.find((c) => c.commodity === "Gold")!.legRefs).toEqual([
      { missionId: "m1", legId: "p0" },
    ]);
  });

  it("drops the empty needs-location bucket (collected null-location pickup)", () => {
    const m = mission([
      leg({
        id: "p0",
        kind: "pickup",
        commodity: "Gold",
        scuTotal: 0,
        location: null,
        completed: true,
      }),
    ]);
    const groups = pickupGroups([m], null);
    expect(groups.find((g) => g.needsLocation)).toBeUndefined();
    expect(groups.find((g) => g.location === UNKNOWN_PICKUP)).toBeUndefined();
  });

  it("ignores dropoff legs entirely", () => {
    const m = mission([
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Ice",
        scuTotal: 10,
        location: "A",
      }),
    ]);
    expect(pickupGroups([m], null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// routeEdges — directed haul edges (pickup -> dropoff) for the ROUTE map.
// ---------------------------------------------------------------------------
describe("routeEdges", () => {
  it("A->B: one pickup + one dropoff yields a single edge", () => {
    const m = mission([
      leg({
        id: "p0",
        kind: "pickup",
        commodity: "Ice",
        scuTotal: 50,
        location: "Origin",
      }),
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Ice",
        scuTotal: 50,
        location: "Dest",
      }),
    ]);
    const edges = routeEdges([m]);
    expect(edges).toHaveLength(1);
    const e = edges[0];
    expect(e.fromLocation).toBe("Origin");
    expect(e.toLocation).toBe("Dest");
    expect(e.commodity).toBe("Ice");
    expect(e.scu).toBe(50);
    expect(e.fromKnown).toBe(true);
    expect(e.toKnown).toBe(true);
    expect(e.done).toBe(false);
  });

  it("single-to-multi: one pickup + N dropoffs yields N edges sharing the pickup", () => {
    const m = mission([
      leg({
        id: "p0",
        kind: "pickup",
        commodity: "Ore",
        scuTotal: 100,
        location: "Origin",
      }),
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Ore",
        scuTotal: 40,
        location: "A",
      }),
      leg({
        id: "d1",
        kind: "dropoff",
        commodity: "Ore",
        scuTotal: 60,
        location: "B",
      }),
    ]);
    const edges = routeEdges([m]);
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.fromLocation === "Origin")).toBe(true);
    expect(edges.map((e) => e.toLocation).sort()).toEqual(["A", "B"]);
    expect(edges.map((e) => e.scu).sort((a, b) => a - b)).toEqual([40, 60]);
  });

  it("single-to-multi with DIFFERING commodities: each edge carries its own dropoff's commodity + SCU (drives map labels)", () => {
    // One pickup fanning out to three dropoffs, each hauling a DIFFERENT
    // commodity at a DISTINCT SCU. The map labels each edge per-dropoff, so the
    // commodity/SCU must be taken from the dropoff leg — never shared across the
    // fan-out. This guards the RouteMapView label being correct per haul.
    const m = mission([
      leg({
        id: "p0",
        kind: "pickup",
        commodity: "Aluminum",
        scuTotal: 96,
        location: "Origin",
      }),
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Aluminum",
        scuTotal: 16,
        location: "A",
      }),
      leg({
        id: "d1",
        kind: "dropoff",
        commodity: "Titanium",
        scuTotal: 32,
        location: "B",
      }),
      leg({
        id: "d2",
        kind: "dropoff",
        commodity: "Quantanium",
        scuTotal: 48,
        location: "C",
      }),
    ]);
    const edges = routeEdges([m]);
    expect(edges).toHaveLength(3);
    expect(edges.every((e) => e.fromLocation === "Origin")).toBe(true);

    // Each edge pairs the right destination with the right commodity + SCU.
    const byDest = new Map(edges.map((e) => [e.toLocation, e]));
    expect(byDest.get("A")!.commodity).toBe("Aluminum");
    expect(byDest.get("A")!.scu).toBe(16);
    expect(byDest.get("B")!.commodity).toBe("Titanium");
    expect(byDest.get("B")!.scu).toBe(32);
    expect(byDest.get("C")!.commodity).toBe("Quantanium");
    expect(byDest.get("C")!.scu).toBe(48);

    // The commodities are genuinely distinct (not a shared/repeated value).
    expect(new Set(edges.map((e) => e.commodity)).size).toBe(3);
  });

  it("multi-to-single: N pickups + one dropoff yields N edges sharing the dropoff", () => {
    const m = mission([
      leg({
        id: "p0",
        kind: "pickup",
        commodity: "Ice",
        scuTotal: 20,
        location: "PA",
      }),
      leg({
        id: "p1",
        kind: "pickup",
        commodity: "Ore",
        scuTotal: 20,
        location: "PB",
      }),
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Ice",
        scuTotal: 20,
        location: "Hub",
      }),
      leg({
        id: "d1",
        kind: "dropoff",
        commodity: "Ore",
        scuTotal: 20,
        location: "Hub",
      }),
    ]);
    const edges = routeEdges([m]);
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.toLocation === "Hub")).toBe(true);
    // Commodity match distributes the two distinct sources, not reuse of #0.
    expect(edges.map((e) => e.fromLocation).sort()).toEqual(["PA", "PB"]);
  });

  it("null locations become the Unknown sentinel with from/toKnown false", () => {
    const m = mission([
      leg({
        id: "p0",
        kind: "pickup",
        commodity: "Gold",
        scuTotal: 10,
        location: null,
      }),
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Gold",
        scuTotal: 10,
        location: null,
      }),
    ]);
    const edges = routeEdges([m]);
    expect(edges).toHaveLength(1);
    expect(edges[0].fromLocation).toBe(UNKNOWN_ROUTE_NODE);
    expect(edges[0].toLocation).toBe(UNKNOWN_ROUTE_NODE);
    expect(edges[0].fromKnown).toBe(false);
    expect(edges[0].toKnown).toBe(false);
  });

  it("a fully-delivered haul is flagged done (not skipped)", () => {
    const m = mission([
      leg({
        id: "p0",
        kind: "pickup",
        commodity: "Ice",
        scuTotal: 10,
        location: "O",
        completed: true,
      }),
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Ice",
        scuTotal: 10,
        location: "D",
        completed: true,
      }),
    ]);
    const edges = routeEdges([m]);
    expect(edges).toHaveLength(1);
    expect(edges[0].done).toBe(true);
  });

  it("a dropoff-only mission (no pickup) still emits an edge from Unknown", () => {
    const m = mission([
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Ice",
        scuTotal: 10,
        location: "D",
      }),
    ]);
    const edges = routeEdges([m]);
    expect(edges).toHaveLength(1);
    expect(edges[0].fromLocation).toBe(UNKNOWN_ROUTE_NODE);
    expect(edges[0].fromKnown).toBe(false);
    expect(edges[0].toLocation).toBe("D");
  });

  it("excludes terminal (non-active) missions", () => {
    const m = {
      ...mission([
        leg({
          id: "p0",
          kind: "pickup",
          commodity: "Ice",
          scuTotal: 10,
          location: "O",
        }),
        leg({
          id: "d0",
          kind: "dropoff",
          commodity: "Ice",
          scuTotal: 10,
          location: "D",
        }),
      ]),
      status: "complete" as const,
    };
    expect(routeEdges([m])).toEqual([]);
  });

  it("routeStopCount counts the union of from + to locations", () => {
    const m = mission([
      leg({
        id: "p0",
        kind: "pickup",
        commodity: "Ore",
        scuTotal: 100,
        location: "Origin",
      }),
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Ore",
        scuTotal: 40,
        location: "A",
      }),
      leg({
        id: "d1",
        kind: "dropoff",
        commodity: "Ore",
        scuTotal: 60,
        location: "B",
      }),
    ]);
    expect(routeStopCount(routeEdges([m]))).toBe(3); // Origin, A, B
  });
});

// ---------------------------------------------------------------------------
// shouldShowLogBanner — the show/hide predicate for the log-not-found warning
// strip. Found -> hidden; missing -> shown; transient boot/searching -> hidden.
// ---------------------------------------------------------------------------
describe("shouldShowLogBanner", () => {
  const pathInfo = (over: Partial<LogPathInfo>): LogPathInfo => ({
    liveFolder: null,
    gameLogPath: "C:/StarCitizen/LIVE/Game.log",
    isDefault: true,
    gameLogExists: true,
    ...over,
  });
  const status = (over: Partial<LogStatus>): LogStatus => ({
    state: "connected",
    logPath: "C:/StarCitizen/LIVE/Game.log",
    uexActive: true,
    ...over,
  });

  it("hidden when Game.log is found (connected)", () => {
    expect(
      shouldShowLogBanner(pathInfo({ gameLogExists: true }), status({})),
    ).toBe(false);
  });

  it("shown when Game.log does not exist on disk", () => {
    expect(
      shouldShowLogBanner(
        pathInfo({ gameLogExists: false }),
        status({ state: "searching" }),
      ),
    ).toBe(true);
  });

  it("shown when the file exists but the watcher is hard-disconnected", () => {
    expect(
      shouldShowLogBanner(
        pathInfo({ gameLogExists: true }),
        status({ state: "disconnected" }),
      ),
    ).toBe(true);
  });

  it("hidden while still resolving (no path info yet)", () => {
    expect(shouldShowLogBanner(null, status({ state: "searching" }))).toBe(
      false,
    );
  });

  it("hidden during transient searching state when the file does exist", () => {
    expect(
      shouldShowLogBanner(
        pathInfo({ gameLogExists: true }),
        status({ state: "searching" }),
      ),
    ).toBe(false);
  });

  it("tolerates a null log status (found -> hidden, missing -> shown)", () => {
    expect(shouldShowLogBanner(pathInfo({ gameLogExists: true }), null)).toBe(
      false,
    );
    expect(shouldShowLogBanner(pathInfo({ gameLogExists: false }), null)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Phase B1 — partial turn-in: the renderer selectors reflect 0 < delivered < total.
// ---------------------------------------------------------------------------
describe("partial turn-in (renderer selectors)", () => {
  it("missionTotals: a partial leg's remaining = total - delivered (not full, not zero)", () => {
    const m = mission([
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Ice",
        scuTotal: 100,
        scuDelivered: 60,
        location: "HDPC-Cassillo",
        completed: false,
      }),
    ]);
    const t = missionTotals(m);
    expect(t.scuTotal).toBe(100);
    expect(t.scuRemaining).toBe(40); // 100 - 60
    expect(t.legsDone).toBe(0); // partial is NOT done
    expect(t.legsTotal).toBe(1);
  });

  it("dropoffGroups: a partial leg stays in todo with the partial remaining", () => {
    const m = mission([
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Ice",
        scuTotal: 100,
        scuDelivered: 45,
        location: "HDPC-Cassillo",
        completed: false,
      }),
    ]);
    const g = dropoffGroups([m], null).find(
      (x) => x.location === "HDPC-Cassillo",
    )!;
    const ice = g.todo.find((c) => c.commodity === "Ice")!;
    expect(ice).toBeDefined(); // still TODO, not delivered
    expect(ice.scuRemaining).toBe(55); // 100 - 45
    expect(g.scuRemaining).toBe(55);
    expect(g.allDone).toBe(false);
    expect(g.pctDelivered).toBe(45);
  });

  it("dropoffGroups: a fully-completed leg leaves todo (delivered), unlike a partial", () => {
    const m = mission([
      leg({
        id: "d0",
        kind: "dropoff",
        commodity: "Ice",
        scuTotal: 100,
        scuDelivered: 100,
        location: "HDPC-Cassillo",
        completed: true,
      }),
    ]);
    const g = dropoffGroups([m], null).find(
      (x) => x.location === "HDPC-Cassillo",
    )!;
    expect(g.todo.find((c) => c.commodity === "Ice")).toBeUndefined();
    expect(g.allDone).toBe(true);
    expect(g.pctDelivered).toBe(100);
  });
});
