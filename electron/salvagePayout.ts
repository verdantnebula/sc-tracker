// ============================================================================
// salvagePayout.ts — pure payout calculator for a salvage run.
// ----------------------------------------------------------------------------
// No DB, no IO — just the value math, so it is trivially unit-testable and
// reused identically by the store (for persisted runs) and any caller wanting a
// preview. Rules (frozen contract):
//   rmcValue       = rmcScu  * materialPrices.rmcPerScu
//   cmatValue      = cmatScu * materialPrices.cmatPerScu
//   componentValue = Σ over SOLD stripped components of qty * sellPriceEach
//   totalValue     = rmcValue + cmatValue + componentValue
//   valuePerPlayer = totalValue / max(1, crewSize)
//
// constructionScu is captured on the run but has no agreed per-SCU price yet, so
// it does NOT contribute to totalValue here (reserved for a future rule). Unsold
// components are excluded from componentValue.
// ============================================================================

import type {
  SalvageMaterialPrices,
  SalvageTotals,
  StrippedComponent,
} from "@shared/types";

/** The minimal run shape the payout math needs (a full SalvageRun satisfies it). */
export interface PayoutInput {
  crewSize: number;
  rmcScu: number;
  cmatScu: number;
  stripped: Pick<StrippedComponent, "qty" | "sellPriceEach" | "sold">[];
}

/**
 * Compute a run's derived payout figures. Pure: same inputs -> same output.
 * `materialPrices` are the reference defaults (or a per-run override if supplied
 * by the caller).
 */
export function computeSalvageTotals(
  run: PayoutInput,
  materialPrices: SalvageMaterialPrices,
): SalvageTotals {
  const rmcValue = run.rmcScu * materialPrices.rmcPerScu;
  const cmatValue = run.cmatScu * materialPrices.cmatPerScu;

  const componentValue = run.stripped.reduce(
    (sum, c) => (c.sold ? sum + c.qty * c.sellPriceEach : sum),
    0,
  );

  const totalValue = rmcValue + cmatValue + componentValue;
  // crewSize is clamped to >= 1 so a 0/negative crew can never divide-by-zero
  // or inflate the per-player share.
  const valuePerPlayer = totalValue / Math.max(1, run.crewSize);

  return { rmcValue, cmatValue, componentValue, totalValue, valuePerPlayer };
}
