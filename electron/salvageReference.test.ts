// ============================================================================
// salvageReference.test.ts — bundled salvage reference snapshot loader.
// ----------------------------------------------------------------------------
// The loader is LOCAL-FIRST (mirrors uexClient): it serves the bundled
// electron/data/salvage-reference.json with no network/token. These tests pin
// the extracted shape + sizes so a future worksheet refresh is a deliberate,
// reviewed change (re-run `npm run fetch:salvage-reference`).
// ============================================================================

import { describe, it, expect, vi } from "vitest";
import { createSalvageReference } from "./salvageReference";
import refData from "./data/salvage-reference.json";
import type { SalvageComponentType } from "@shared/types";

const COMPONENT_TYPES = new Set<SalvageComponentType>([
  "powerplant",
  "shield",
  "quantumdrive",
  "cooler",
  "radar",
  "weapon",
]);

describe("salvageReference (bundled snapshot)", () => {
  it("serves the bundled snapshot with no network involved", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ref = createSalvageReference().getReferenceData();

    // Extracted from the SC 4.8 worksheet. If a future patch changes these,
    // refresh the snapshot via `npm run fetch:salvage-reference` and adjust
    // these counts deliberately.
    expect(ref.ships).toHaveLength(26);
    expect(ref.components).toHaveLength(466);
    expect(ref.haulers).toHaveLength(9);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns data matching the bundled JSON exactly", () => {
    const ref = createSalvageReference().getReferenceData();
    expect(ref.ships).toEqual(refData.ships);
    expect(ref.components).toEqual(refData.components);
    expect(ref.haulers).toEqual(refData.haulers);
    expect(ref.materialPrices).toEqual(refData.materialPrices);
  });

  it("has the expected material prices (RMC 7200 / CMAT 12000 per SCU)", () => {
    const { materialPrices } = createSalvageReference().getReferenceData();
    expect(materialPrices.rmcPerScu).toBe(7200);
    expect(materialPrices.cmatPerScu).toBe(12000);
  });

  it("ships have a valid shape and cover all 4 cost tiers", () => {
    const { ships } = createSalvageReference().getReferenceData();
    for (const s of ships) {
      expect(typeof s.name).toBe("string");
      expect(s.name.length).toBeGreaterThan(0);
      expect(Array.isArray(s.components.weapons)).toBe(true);
    }
    const tiers = new Set(ships.map((s) => s.costTier));
    expect(tiers).toEqual(new Set([300, 500, 10000, 20000]));
    // A known ship is present (sanity that data is real, not a stub).
    expect(ships.some((s) => s.name === "Vulture")).toBe(true);
  });

  it("components have valid types and non-empty models", () => {
    const { components } = createSalvageReference().getReferenceData();
    const byType: Record<string, number> = {};
    for (const c of components) {
      expect(COMPONENT_TYPES.has(c.type)).toBe(true);
      expect(c.model.length).toBeGreaterThan(0);
      expect(c.sellPrice === null || typeof c.sellPrice === "number").toBe(
        true,
      );
      byType[c.type] = (byType[c.type] ?? 0) + 1;
    }
    // Per-sheet counts from the extraction.
    expect(byType).toEqual({
      powerplant: 73,
      shield: 63,
      quantumdrive: 57,
      radar: 58,
      cooler: 72,
      weapon: 143,
    });
  });

  it("haulers have a name and numeric grid capacity", () => {
    const { haulers } = createSalvageReference().getReferenceData();
    for (const h of haulers) {
      expect(h.name.length).toBeGreaterThan(0);
      expect(typeof h.gridScu).toBe("number");
    }
    expect(haulers.some((h) => h.name === "Hull C")).toBe(true);
  });

  it("isActive() is true (the bundled snapshot is always present)", () => {
    expect(createSalvageReference().isActive()).toBe(true);
  });

  it("accepts an injected snapshot override (for tests)", () => {
    const custom = {
      ships: [],
      components: [],
      materialPrices: { rmcPerScu: 1, cmatPerScu: 2 },
      haulers: [{ name: "X", gridScu: 1 }],
    };
    const ref = createSalvageReference({ snapshot: custom }).getReferenceData();
    expect(ref).toEqual(custom);
  });
});
