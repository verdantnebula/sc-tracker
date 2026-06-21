// salvageSelectors.test.ts — pure salvage derivations. Covers the payout math
// (kept identical to electron/salvagePayout.ts), component grouping for Sell &
// Split, terminal-run history sort, and the reference price lookup.
import { describe, it, expect } from "vitest";
import type {
  SalvageRun,
  StrippedComponent,
  SalvageMaterialPrices,
  SalvageReferenceComponent,
} from "@shared/types";
import {
  computeSalvageTotals,
  groupStripped,
  historyRuns,
  isRunTerminal,
  componentModelsByType,
  refSellPrice,
  runMaterialScu,
} from "./salvageSelectors";

const PRICES: SalvageMaterialPrices = { rmcPerScu: 7200, cmatPerScu: 12000 };

function strip(p: Partial<StrippedComponent>): StrippedComponent {
  return {
    id: p.id ?? "s0",
    runId: p.runId ?? "r0",
    type: p.type ?? "weapon",
    model: p.model ?? "AD4B",
    qty: p.qty ?? 1,
    sellPriceEach: p.sellPriceEach ?? 1000,
    sold: p.sold ?? false,
  };
}

function run(p: Partial<SalvageRun>): SalvageRun {
  return {
    id: p.id ?? "r0",
    startedAt: p.startedAt ?? 1000,
    completedAt: p.completedAt ?? null,
    status: p.status ?? "active",
    crewSize: p.crewSize ?? 1,
    notes: p.notes ?? "",
    rmcScu: p.rmcScu ?? 0,
    cmatScu: p.cmatScu ?? 0,
    constructionScu: p.constructionScu ?? 0,
    stripped: p.stripped ?? [],
    wrecks: p.wrecks ?? [],
  };
}

describe("computeSalvageTotals", () => {
  it("sums RMC + CMAT + SOLD components and splits per player", () => {
    const t = computeSalvageTotals(
      {
        crewSize: 2,
        rmcScu: 10, // 10 * 7200 = 72,000
        cmatScu: 5, //  5 * 12000 = 60,000
        stripped: [
          { qty: 2, sellPriceEach: 3000, sold: true }, // +6,000
          { qty: 1, sellPriceEach: 9999, sold: false }, // excluded (unsold)
        ],
      },
      PRICES,
    );
    expect(t.rmcValue).toBe(72_000);
    expect(t.cmatValue).toBe(60_000);
    expect(t.componentValue).toBe(6_000);
    expect(t.totalValue).toBe(138_000);
    expect(t.valuePerPlayer).toBe(69_000);
  });

  it("clamps crewSize to >= 1 (no divide-by-zero / inflation)", () => {
    const t = computeSalvageTotals(
      { crewSize: 0, rmcScu: 1, cmatScu: 0, stripped: [] },
      PRICES,
    );
    expect(t.valuePerPlayer).toBe(7_200);
  });

  it("ignores constructionScu (no agreed price) — matches backend", () => {
    const t = computeSalvageTotals(
      { crewSize: 1, rmcScu: 0, cmatScu: 0, stripped: [] },
      PRICES,
    );
    expect(t.totalValue).toBe(0);
  });

  // The renderer calculator MUST stay identical to electron/salvagePayout.ts
  // (the frozen backend contract) so a live preview never disagrees with a
  // persisted run. We pin the exact formula here rather than cross-importing the
  // electron module (which is outside the web tsconfig's compile boundary).
  it("matches the frozen backend formula exactly", () => {
    const r = run({
      crewSize: 3,
      rmcScu: 7,
      cmatScu: 4,
      stripped: [
        strip({ qty: 3, sellPriceEach: 2500, sold: true }),
        strip({ qty: 1, sellPriceEach: 4000, sold: false }),
      ],
    });
    const rmcValue = r.rmcScu * PRICES.rmcPerScu;
    const cmatValue = r.cmatScu * PRICES.cmatPerScu;
    const componentValue = r.stripped.reduce(
      (sum, c) => (c.sold ? sum + c.qty * c.sellPriceEach : sum),
      0,
    );
    const totalValue = rmcValue + cmatValue + componentValue;
    expect(computeSalvageTotals(r, PRICES)).toEqual({
      rmcValue,
      cmatValue,
      componentValue,
      totalValue,
      valuePerPlayer: totalValue / Math.max(1, r.crewSize),
    });
  });
});

describe("groupStripped", () => {
  it("collapses identical (model, price, sold) pulls into one line", () => {
    const groups = groupStripped([
      strip({
        id: "a",
        type: "weapon",
        model: "AD4B",
        qty: 1,
        sellPriceEach: 3000,
        sold: true,
      }),
      strip({
        id: "b",
        type: "weapon",
        model: "AD4B",
        qty: 2,
        sellPriceEach: 3000,
        sold: true,
      }),
    ]);
    expect(groups).toHaveLength(1);
    const line = groups[0].lines[0];
    expect(line.qty).toBe(3);
    expect(line.lineValue).toBe(9_000);
    expect(line.ids).toEqual(["a", "b"]);
  });

  it("keeps sold and unsold pulls of the same model as distinct lines", () => {
    const groups = groupStripped([
      strip({
        type: "shield",
        model: "FR-66",
        qty: 1,
        sellPriceEach: 1000,
        sold: true,
      }),
      strip({
        type: "shield",
        model: "FR-66",
        qty: 1,
        sellPriceEach: 1000,
        sold: false,
      }),
    ]);
    expect(groups[0].lines).toHaveLength(2);
    expect(groups[0].soldValue).toBe(1_000); // only the sold line
    expect(groups[0].grossValue).toBe(2_000); // both lines
  });

  it("orders groups by COMPONENT_TYPE_ORDER and omits empty types", () => {
    const groups = groupStripped([
      strip({ type: "cooler", model: "Polar" }),
      strip({ type: "weapon", model: "AD4B" }),
    ]);
    expect(groups.map((g) => g.type)).toEqual(["weapon", "cooler"]);
  });
});

describe("historyRuns", () => {
  it("returns only terminal runs, newest first", () => {
    const runs = [
      run({ id: "active", status: "active", startedAt: 5000 }),
      run({ id: "old", status: "sold", completedAt: 1000 }),
      run({ id: "new", status: "abandoned", completedAt: 3000 }),
    ];
    expect(historyRuns(runs).map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("isRunTerminal flags sold + abandoned, not active", () => {
    expect(isRunTerminal(run({ status: "active" }))).toBe(false);
    expect(isRunTerminal(run({ status: "sold" }))).toBe(true);
    expect(isRunTerminal(run({ status: "abandoned" }))).toBe(true);
  });
});

describe("reference helpers", () => {
  const components: SalvageReferenceComponent[] = [
    {
      type: "weapon",
      model: "AD4B",
      class: "Ballistic",
      size: 4,
      grade: null,
      sellPrice: 3000,
    },
    {
      type: "weapon",
      model: "CF-337",
      class: "Laser",
      size: 3,
      grade: null,
      sellPrice: null,
    },
    {
      type: "shield",
      model: "FR-66",
      class: "Civilian",
      size: 1,
      grade: "C",
      sellPrice: 1200,
    },
  ];

  it("componentModelsByType filters + sorts by model", () => {
    const weapons = componentModelsByType(components, "weapon");
    expect(weapons.map((c) => c.model)).toEqual(["AD4B", "CF-337"]);
  });

  it("refSellPrice resolves a known price", () => {
    expect(refSellPrice(components, "weapon", "AD4B")).toBe(3000);
  });

  it("refSellPrice returns null for an unpriced model", () => {
    expect(refSellPrice(components, "weapon", "CF-337")).toBeNull();
  });

  it("refSellPrice returns null for an unknown model", () => {
    expect(refSellPrice(components, "weapon", "Nope")).toBeNull();
  });
});

describe("runMaterialScu", () => {
  it("sums RMC + CMAT + construction SCU", () => {
    expect(
      runMaterialScu(run({ rmcScu: 10, cmatScu: 5, constructionScu: 2 })),
    ).toBe(17);
  });
});
