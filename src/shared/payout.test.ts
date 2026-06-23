// ============================================================================
// payout.test.ts — the pure partial-payout model (TDD, every bracket + boundary).
// ----------------------------------------------------------------------------
// Verifies the community step-function curve, snap rounding, and the
// partialPayout composition incl. its edge cases (zero total, zero reward). The
// boundary tests are the important ones: `>` vs `>=` at 0.25 / 0.5 / 0.75 / 1.0.
// ============================================================================

import { describe, it, expect } from "vitest";
import { payoutFactor, snapPayout, partialPayout } from "./payout";

describe("payoutFactor", () => {
  it("pays the FULL reward at and above ratio 1 (the only inclusive boundary)", () => {
    expect(payoutFactor(1)).toBe(1);
    expect(payoutFactor(1.5)).toBe(1); // over-delivery never pays more than 100%
  });

  it("pays 76% in the (0.75, 1) bracket", () => {
    expect(payoutFactor(0.76)).toBe(0.76);
    expect(payoutFactor(0.9)).toBe(0.76);
    expect(payoutFactor(0.999)).toBe(0.76);
  });

  it("pays 45% in the (0.5, 0.75] bracket", () => {
    expect(payoutFactor(0.51)).toBe(0.45);
    expect(payoutFactor(0.6)).toBe(0.45);
    expect(payoutFactor(0.75)).toBe(0.45); // EXACTLY 0.75 is the lower bracket
  });

  it("pays 15% in the (0.25, 0.5] bracket", () => {
    expect(payoutFactor(0.26)).toBe(0.15);
    expect(payoutFactor(0.4)).toBe(0.15);
    expect(payoutFactor(0.5)).toBe(0.15); // EXACTLY 0.5 is the lower bracket
  });

  it("pays 0% in the (0, 0.25] bracket", () => {
    expect(payoutFactor(0.01)).toBe(0);
    expect(payoutFactor(0.2)).toBe(0);
    expect(payoutFactor(0.25)).toBe(0); // EXACTLY 0.25 earns nothing
  });

  it("pays 0% at or below ratio 0", () => {
    expect(payoutFactor(0)).toBe(0);
    expect(payoutFactor(-1)).toBe(0);
  });

  // Boundary table: `>` (strict) at the three middle thresholds, `>=` at full.
  it.each([
    [0.25, 0],
    [0.2500001, 0.15],
    [0.5, 0.15],
    [0.5000001, 0.45],
    [0.75, 0.45],
    [0.7500001, 0.76],
    [1, 1],
  ])("boundary: factor(%d) === %d", (ratio, expected) => {
    expect(payoutFactor(ratio)).toBe(expected);
  });
});

describe("snapPayout", () => {
  it("rounds to the nearest 250", () => {
    expect(snapPayout(0)).toBe(0);
    expect(snapPayout(124)).toBe(0); // 124/250 -> 0
    expect(snapPayout(125)).toBe(250); // halfway rounds up
    expect(snapPayout(374)).toBe(250);
    expect(snapPayout(375)).toBe(500);
    expect(snapPayout(1000)).toBe(1000);
    expect(snapPayout(1100)).toBe(1000);
    expect(snapPayout(1125)).toBe(1250);
  });
});

describe("partialPayout", () => {
  it("snaps reward * factor for a normal partial", () => {
    // 100000 reward, 60/100 delivered -> ratio 0.6 -> factor 0.45 -> 45000 -> snap 45000
    expect(partialPayout(100000, 60, 100)).toBe(45000);
  });

  it("pays the full snapped reward at full delivery", () => {
    expect(partialPayout(100000, 100, 100)).toBe(100000);
    expect(partialPayout(99980, 100, 100)).toBe(100000); // snapped from 99980
  });

  it("pays nothing at or under the 25% threshold", () => {
    expect(partialPayout(100000, 25, 100)).toBe(0); // exactly 25%
    expect(partialPayout(100000, 10, 100)).toBe(0);
  });

  it("76% bracket above three-quarters", () => {
    // ratio 0.8 -> 0.76 -> 76000
    expect(partialPayout(100000, 80, 100)).toBe(76000);
  });

  it("snaps a non-round product to the nearest 250", () => {
    // 33333 reward, full -> snap(33333) = 33250 (33333/250 = 133.33 -> 133*250)
    expect(partialPayout(33333, 100, 100)).toBe(33250);
    // 50000 * 0.15 = 7500 (already a multiple of 250)
    expect(partialPayout(50000, 30, 100)).toBe(7500);
  });

  it("falls back to the snapped raw reward when totalScu <= 0 (unknown quantity)", () => {
    expect(partialPayout(100000, 0, 0)).toBe(100000);
    expect(partialPayout(99980, 50, 0)).toBe(100000);
    expect(partialPayout(100000, 0, -5)).toBe(100000);
  });

  it("a zero / negative reward yields 0", () => {
    expect(partialPayout(0, 100, 100)).toBe(0);
    expect(partialPayout(0, 0, 0)).toBe(0);
  });
});
