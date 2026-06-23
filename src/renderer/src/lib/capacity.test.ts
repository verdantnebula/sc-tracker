// ============================================================================
// capacity.test.ts — pure hold-capacity helper (Phase A ship picker).
// ----------------------------------------------------------------------------
// capacityStatus(totalScu, shipScu) maps "how much cargo is still owed" against
// "how big is my hold" into the view-model the CapacityBar renders: fill %, a
// tier (ok/warn/over/none), overflow SCU, and the trip count. Every branch is
// covered: no ship, ok, the warn/over boundaries, trips, and a zero total.
// ============================================================================

import { describe, it, expect } from "vitest";
import { capacityStatus } from "./capacity";

describe("capacityStatus", () => {
  it("no ship (null) -> tier 'none', no trips, no overflow", () => {
    const s = capacityStatus(500, null);
    expect(s.tier).toBe("none");
    expect(s.trips).toBe(0);
    expect(s.overflowScu).toBe(0);
    expect(s.usedPct).toBe(0);
  });

  it("no ship (shipScu <= 0) -> tier 'none'", () => {
    expect(capacityStatus(500, 0).tier).toBe("none");
    expect(capacityStatus(500, -10).tier).toBe("none");
    expect(capacityStatus(500, 0).trips).toBe(0);
  });

  it("zero total with a ship -> tier 'ok', 0% used, no trips needed (1 by floor when total>0)", () => {
    const s = capacityStatus(0, 696);
    expect(s.tier).toBe("ok");
    expect(s.usedPct).toBe(0);
    expect(s.overflowScu).toBe(0);
    // No cargo owed -> zero trips.
    expect(s.trips).toBe(0);
  });

  it("comfortably under capacity -> tier 'ok'", () => {
    const s = capacityStatus(300, 696); // ~0.43
    expect(s.tier).toBe("ok");
    expect(s.usedPct).toBeCloseTo(300 / 696, 5);
    expect(s.overflowScu).toBe(0);
    expect(s.trips).toBe(1);
  });

  it("just below the warn boundary (0.8) -> 'ok'", () => {
    const s = capacityStatus(79, 100); // 0.79
    expect(s.tier).toBe("ok");
  });

  it("at the warn boundary (exactly 0.8) -> 'warn'", () => {
    const s = capacityStatus(80, 100); // 0.80
    expect(s.tier).toBe("warn");
    expect(s.usedPct).toBeCloseTo(0.8, 5);
    expect(s.overflowScu).toBe(0);
    expect(s.trips).toBe(1);
  });

  it("between warn and full (0.8..1.0) -> 'warn'", () => {
    expect(capacityStatus(95, 100).tier).toBe("warn");
  });

  it("exactly full (1.0) -> 'warn', not over", () => {
    const s = capacityStatus(100, 100);
    expect(s.tier).toBe("warn");
    expect(s.overflowScu).toBe(0);
    expect(s.trips).toBe(1);
  });

  it("over capacity (>1.0) -> 'over', overflow + multi-trip", () => {
    const s = capacityStatus(150, 100); // 1.5
    expect(s.tier).toBe("over");
    expect(s.overflowScu).toBe(50);
    expect(s.trips).toBe(2); // ceil(150/100)
  });

  it("caps usedPct display at 1.0 even when over", () => {
    const s = capacityStatus(250, 100); // 2.5 raw
    expect(s.usedPct).toBe(1);
    expect(s.tier).toBe("over");
    expect(s.overflowScu).toBe(150);
    expect(s.trips).toBe(3); // ceil(250/100)
  });

  it("trips round up for a partial last load", () => {
    expect(capacityStatus(201, 100).trips).toBe(3); // ceil(2.01)
    expect(capacityStatus(200, 100).trips).toBe(2); // exact
  });
});
