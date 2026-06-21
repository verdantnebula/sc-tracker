// ============================================================================
// salvagePayout.test.ts — pure payout math for a salvage run.
// ----------------------------------------------------------------------------
// Verifies the frozen rules: material values, component value (SOLD only),
// total, and per-player split (clamped crew). No DB involved.
// ============================================================================

import { describe, it, expect } from "vitest";
import { computeSalvageTotals } from "./salvagePayout";
import type { SalvageMaterialPrices } from "@shared/types";

const PRICES: SalvageMaterialPrices = { rmcPerScu: 7200, cmatPerScu: 12000 };

describe("computeSalvageTotals", () => {
  it("computes material values from SCU * per-SCU rate", () => {
    const t = computeSalvageTotals(
      { crewSize: 1, rmcScu: 10, cmatScu: 5, stripped: [] },
      PRICES,
    );
    expect(t.rmcValue).toBe(72000); // 10 * 7200
    expect(t.cmatValue).toBe(60000); // 5 * 12000
    expect(t.componentValue).toBe(0);
    expect(t.totalValue).toBe(132000);
  });

  it("sums only SOLD components into componentValue", () => {
    const t = computeSalvageTotals(
      {
        crewSize: 1,
        rmcScu: 0,
        cmatScu: 0,
        stripped: [
          { qty: 2, sellPriceEach: 3000, sold: true }, // 6000
          { qty: 1, sellPriceEach: 5000, sold: false }, // excluded
          { qty: 4, sellPriceEach: 1000, sold: true }, // 4000
        ],
      },
      PRICES,
    );
    expect(t.componentValue).toBe(10000); // 6000 + 4000, unsold excluded
    expect(t.totalValue).toBe(10000);
  });

  it("combines materials + sold components into totalValue", () => {
    const t = computeSalvageTotals(
      {
        crewSize: 1,
        rmcScu: 1,
        cmatScu: 1,
        stripped: [{ qty: 1, sellPriceEach: 800, sold: true }],
      },
      PRICES,
    );
    expect(t.totalValue).toBe(7200 + 12000 + 800);
  });

  it("splits totalValue across crewSize for valuePerPlayer", () => {
    const t = computeSalvageTotals(
      { crewSize: 4, rmcScu: 10, cmatScu: 0, stripped: [] },
      PRICES,
    );
    expect(t.totalValue).toBe(72000);
    expect(t.valuePerPlayer).toBe(18000); // 72000 / 4
  });

  it("clamps crewSize to >= 1 (no divide-by-zero, no inflation)", () => {
    const zero = computeSalvageTotals(
      { crewSize: 0, rmcScu: 10, cmatScu: 0, stripped: [] },
      PRICES,
    );
    expect(zero.valuePerPlayer).toBe(72000); // divided by max(1,0)=1

    const neg = computeSalvageTotals(
      { crewSize: -5, rmcScu: 10, cmatScu: 0, stripped: [] },
      PRICES,
    );
    expect(neg.valuePerPlayer).toBe(72000);
  });

  it("returns all-zero figures for an empty run", () => {
    const t = computeSalvageTotals(
      { crewSize: 1, rmcScu: 0, cmatScu: 0, stripped: [] },
      PRICES,
    );
    expect(t).toEqual({
      rmcValue: 0,
      cmatValue: 0,
      componentValue: 0,
      totalValue: 0,
      valuePerPlayer: 0,
    });
  });

  it("honors a per-run material price override", () => {
    const t = computeSalvageTotals(
      { crewSize: 1, rmcScu: 10, cmatScu: 0, stripped: [] },
      { rmcPerScu: 8000, cmatPerScu: 12000 },
    );
    expect(t.rmcValue).toBe(80000);
  });
});
