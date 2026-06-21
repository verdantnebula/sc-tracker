// ============================================================================
// salvageSelectors.ts — pure derivations from the SalvageRun model to view
// models for the salvage UI. The mirror of cargo's selectors.ts.
// ----------------------------------------------------------------------------
// No React, no IO — just the value math + grouping, so it is trivially unit
// testable and shared by every salvage view. The payout math is kept IDENTICAL
// to electron/salvagePayout.ts (the frozen backend contract) so a renderer-side
// preview and a persisted run never disagree:
//   rmcValue       = rmcScu  * materialPrices.rmcPerScu
//   cmatValue      = cmatScu * materialPrices.cmatPerScu
//   componentValue = Σ over SOLD stripped components of qty * sellPriceEach
//   totalValue     = rmcValue + cmatValue + componentValue
//   valuePerPlayer = totalValue / max(1, crewSize)
// constructionScu is captured but has no agreed per-SCU price, so (matching the
// backend) it does NOT contribute to totalValue.
// ============================================================================

import type {
  SalvageRun,
  SalvageRunStatus,
  SalvageTotals,
  SalvageMaterialPrices,
  SalvageComponentType,
  StrippedComponent,
  SalvageReferenceComponent,
} from "@shared/types";

export const fmt = (n: number): string =>
  Math.round(n || 0).toLocaleString("en-US");

/** Currency display used across the salvage views. */
export const aUEC = (n: number): string => `${fmt(n)} aUEC`;

// ---------------------------------------------------------------------------
// Payout math — kept byte-for-byte equivalent to electron/salvagePayout.ts.
// ---------------------------------------------------------------------------

/** The minimal run shape the payout math needs (a full SalvageRun satisfies it). */
export interface PayoutInput {
  crewSize: number;
  rmcScu: number;
  cmatScu: number;
  stripped: Pick<StrippedComponent, "qty" | "sellPriceEach" | "sold">[];
}

/**
 * Compute a run's derived payout figures. Pure: same inputs -> same output.
 * Mirrors computeSalvageTotals in the backend exactly.
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
  const valuePerPlayer = totalValue / Math.max(1, run.crewSize);
  return { rmcValue, cmatValue, componentValue, totalValue, valuePerPlayer };
}

// ---------------------------------------------------------------------------
// Component grouping — for the Sell & Split itemization. Stripped components are
// grouped by type (powerplant / shield / … / weapon) and, within a type, by
// model, so identical pulls collapse into one line with a summed qty + value.
// ---------------------------------------------------------------------------

/** One model line within a component-type group. */
export interface ComponentLine {
  type: SalvageComponentType;
  model: string;
  qty: number;
  sellPriceEach: number;
  /** qty * sellPriceEach (always — independent of sold, for display). */
  lineValue: number;
  /** True only when ALL contributing pulls are sold (value counts toward total). */
  sold: boolean;
  /** The stripped-component ids feeding this line (for bulk sold-toggle). */
  ids: string[];
}

/** A group of component lines sharing a type. */
export interface ComponentGroup {
  type: SalvageComponentType;
  lines: ComponentLine[];
  /** Σ lineValue over SOLD lines in this group. */
  soldValue: number;
  /** Σ lineValue over all lines (sold + unsold). */
  grossValue: number;
}

/** Canonical display order + label for component types. */
export const COMPONENT_TYPE_ORDER: SalvageComponentType[] = [
  "weapon",
  "powerplant",
  "shield",
  "quantumdrive",
  "cooler",
  "radar",
];

export const COMPONENT_TYPE_LABEL: Record<SalvageComponentType, string> = {
  weapon: "Weapons",
  powerplant: "Power Plants",
  shield: "Shields",
  quantumdrive: "Quantum Drives",
  cooler: "Coolers",
  radar: "Radars",
};

/**
 * Group a run's stripped components by type, then model. Lines are summed across
 * identical (type, model, price, sold) pulls; differing prices/sold-state stay
 * as separate lines so nothing is silently merged away. Groups are returned in
 * COMPONENT_TYPE_ORDER, omitting empty types.
 */
export function groupStripped(stripped: StrippedComponent[]): ComponentGroup[] {
  const byType = new Map<SalvageComponentType, Map<string, ComponentLine>>();

  for (const c of stripped) {
    let lines = byType.get(c.type);
    if (!lines) {
      lines = new Map();
      byType.set(c.type, lines);
    }
    // Key on the dimensions that must NOT be merged across (a sold and an unsold
    // pull of the same model are distinct lines; so are two different prices).
    const key = `${c.model}::${c.sellPriceEach}::${c.sold ? 1 : 0}`;
    const existing = lines.get(key);
    if (existing) {
      existing.qty += c.qty;
      existing.lineValue = existing.qty * existing.sellPriceEach;
      existing.ids.push(c.id);
    } else {
      lines.set(key, {
        type: c.type,
        model: c.model,
        qty: c.qty,
        sellPriceEach: c.sellPriceEach,
        lineValue: c.qty * c.sellPriceEach,
        sold: c.sold,
        ids: [c.id],
      });
    }
  }

  const groups: ComponentGroup[] = [];
  for (const type of COMPONENT_TYPE_ORDER) {
    const lines = byType.get(type);
    if (!lines || lines.size === 0) continue;
    const lineList = Array.from(lines.values()).sort(
      (a, b) => b.lineValue - a.lineValue || a.model.localeCompare(b.model),
    );
    const soldValue = lineList.reduce(
      (s, l) => (l.sold ? s + l.lineValue : s),
      0,
    );
    const grossValue = lineList.reduce((s, l) => s + l.lineValue, 0);
    groups.push({ type, lines: lineList, soldValue, grossValue });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Run status partitioning + history sort (mirrors cargo's isActive/isTerminal).
// ---------------------------------------------------------------------------

export const TERMINAL_RUN_STATUSES: SalvageRunStatus[] = ["sold", "abandoned"];

export const isRunTerminal = (r: SalvageRun): boolean =>
  TERMINAL_RUN_STATUSES.includes(r.status);

/** Terminal runs (sold + abandoned), newest first by completed/started time. */
export function historyRuns(runs: SalvageRun[]): SalvageRun[] {
  return runs
    .filter(isRunTerminal)
    .slice()
    .sort(
      (a, b) =>
        (b.completedAt ?? b.startedAt ?? 0) -
        (a.completedAt ?? a.startedAt ?? 0),
    );
}

/** Total raw material SCU (RMC + CMAT + construction) entered for a run. */
export const runMaterialScu = (r: SalvageRun): number =>
  r.rmcScu + r.cmatScu + r.constructionScu;

// ---------------------------------------------------------------------------
// Reference-data resolution helpers (Active Run dropdowns + Reference tables).
// ---------------------------------------------------------------------------

/** Distinct component models of a given type, sorted, for the add dropdown. */
export function componentModelsByType(
  components: SalvageReferenceComponent[],
  type: SalvageComponentType,
): SalvageReferenceComponent[] {
  return components
    .filter((c) => c.type === type)
    .slice()
    .sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * Look up a reference component's sell price by (type, model). Returns null when
 * the model is unknown OR the worksheet had no price (many are null per the
 * data) — the caller then lets the user type a price.
 */
export function refSellPrice(
  components: SalvageReferenceComponent[],
  type: SalvageComponentType,
  model: string,
): number | null {
  const hit = components.find((c) => c.type === type && c.model === model);
  return hit?.sellPrice ?? null;
}

// ---------------------------------------------------------------------------
// Status badge metadata for runs (matches cargo's STATUS_META shape; tokens skin
// it to the active theme so salvage gets the Drake palette automatically).
// ---------------------------------------------------------------------------

export interface RunStatusMeta {
  label: string;
  color: string;
  bg: string;
}

export const RUN_STATUS_META: Record<SalvageRunStatus, RunStatusMeta> = {
  active: {
    label: "ACTIVE",
    color: "var(--status-progress)",
    bg: "var(--status-progress-bg)",
  },
  sold: {
    label: "SOLD",
    color: "var(--status-complete)",
    bg: "var(--status-complete-bg)",
  },
  abandoned: {
    label: "ABANDONED",
    color: "var(--status-abandoned)",
    bg: "var(--status-abandoned-bg)",
  },
};

/** Short date for run rows (mirrors HistoryView.formatDate). */
export function formatRunDate(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
