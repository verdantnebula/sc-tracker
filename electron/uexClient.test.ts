// ============================================================================
// uexClient.test.ts — bundled reference snapshot + mapping helpers (SPEC §9)
// ----------------------------------------------------------------------------
// The client is now LOCAL-FIRST: getReferenceData() returns the bundled
// snapshot (electron/data/reference-data.json) with NO network, NO token, NO
// TTL. These tests verify the bundled data is served correctly and that the
// shared mapping helpers (reused by scripts/fetch-reference.mjs) still normalize
// raw UEX rows as expected. No fetch is ever touched.
// ============================================================================

import { describe, it, expect, vi } from "vitest";
import { createUexClient, mapCommodities, mapTerminals } from "./uexClient";
import refData from "./data/reference-data.json";
import type { Commodity, Terminal } from "@shared/types";

// --- sample raw UEX payloads (shape per SPEC §2: { data: [...] }) -------------

const commoditiesPayload = {
  status: "ok",
  data: [
    { name: "Pressurized Ice", code: "PICE", kind: "Mineral", price_buy: 1 },
    { name: "Processed Food", code: "PFOO", kind: "Food" },
    { name: "", code: "BAD", kind: "junk" }, // dropped (no name)
  ],
};

const terminalsPayload = {
  status: "ok",
  data: [
    {
      name: "hdpc-cassillo",
      displayname: "HDPC-Cassillo",
      nickname: "Cassillo",
      is_cargo_center: 1,
      max_container_size: 32,
    },
    {
      name: "teasa-spaceport",
      displayname: "Teasa Spaceport",
      nickname: "Teasa",
      is_cargo_center: true,
      max_container_size: "24",
    },
    {
      name: "some-shop",
      displayname: "Some Shop",
      nickname: "shop",
      is_cargo_center: 0, // dropped (not a cargo center)
      max_container_size: null,
    },
  ],
};

// =============================================================================
// Pure mapping (reused by scripts/fetch-reference.mjs)
// =============================================================================

describe("mapping", () => {
  it("maps commodities to {name, code, kind}, drops nameless rows", () => {
    const out = mapCommodities(commoditiesPayload);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      name: "Pressurized Ice",
      code: "PICE",
      kind: "Mineral",
    });
  });

  it("maps terminals, filters to is_cargo_center, coerces flags + sizes", () => {
    const out = mapTerminals(terminalsPayload);
    expect(out).toHaveLength(2); // the non-cargo-center shop is filtered out
    expect(out[0]).toEqual({
      name: "hdpc-cassillo",
      displayname: "HDPC-Cassillo",
      nickname: "Cassillo",
      isCargoCenter: true,
      maxContainerSize: 32,
    });
    // numeric string container size coerced to number
    expect(out[1].maxContainerSize).toBe(24);
  });

  it("accepts a bare array payload too", () => {
    expect(mapCommodities([{ name: "X", code: "X", kind: "k" }])).toHaveLength(
      1,
    );
  });

  it("returns [] for garbage input", () => {
    expect(mapCommodities(null)).toEqual([]);
    expect(mapTerminals("nope")).toEqual([]);
  });
});

// =============================================================================
// Client: serves the bundled snapshot, no network/token/TTL
// =============================================================================

describe("uexClient (bundled snapshot)", () => {
  it("getReferenceData returns the bundled snapshot, no fetch involved", () => {
    // Spy on global fetch to prove the runtime path never touches the network.
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const client = createUexClient();
    const ref = client.getReferenceData();

    // Non-empty and the documented per-patch sizes (205 commodities, 34 cargo
    // centers). If a future patch changes these, update the snapshot via
    // `npm run fetch:reference` and adjust these numbers deliberately.
    expect(ref.commodities).toHaveLength(205);
    expect(ref.terminals).toHaveLength(34);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("returned data matches the bundled JSON exactly", () => {
    const client = createUexClient();
    const ref = client.getReferenceData();
    expect(ref.commodities).toEqual(refData.commodities);
    expect(ref.terminals).toEqual(refData.terminals);
  });

  it("commodities have the correct {name, code, kind} shape", () => {
    const ref = createUexClient().getReferenceData();
    for (const c of ref.commodities as Commodity[]) {
      expect(typeof c.name).toBe("string");
      expect(c.name.length).toBeGreaterThan(0);
      expect(typeof c.code).toBe("string");
      expect(typeof c.kind).toBe("string");
    }
    // A known commodity present in the snapshot (sanity that data is real).
    expect(ref.commodities.some((c) => c.name === "Agricium")).toBe(true);
  });

  it("terminals are all cargo centers with the correct shape", () => {
    const ref = createUexClient().getReferenceData();
    for (const t of ref.terminals as Terminal[]) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.displayname).toBe("string");
      expect(typeof t.nickname).toBe("string");
      expect(t.isCargoCenter).toBe(true); // SPEC §2: dropdowns are cargo centers
      expect(
        t.maxContainerSize === null || typeof t.maxContainerSize === "number",
      ).toBe(true);
    }
  });

  it("isActive() is true (the bundled snapshot is always present)", () => {
    expect(createUexClient().isActive()).toBe(true);
  });

  it("accepts an injected snapshot override (for tests)", () => {
    const custom = {
      commodities: [{ name: "Quantanium", code: "QUAN", kind: "Mineral" }],
      terminals: [],
    };
    const ref = createUexClient({ snapshot: custom }).getReferenceData();
    expect(ref).toEqual(custom);
  });

  it("close() is a harmless no-op", () => {
    const client = createUexClient();
    expect(() => client.close()).not.toThrow();
  });
});
