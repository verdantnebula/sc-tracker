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
      type: "distribution",
    },
    {
      name: "teasa-spaceport",
      displayname: "Teasa Spaceport",
      nickname: "Teasa",
      is_cargo_center: true,
      max_container_size: "24",
      type: "venue",
    },
    {
      // A non-cargo-center destination: it must NOT be dropped any more (the bug
      // fix) — players deliver to plenty of non-cargo-center locations.
      name: "everus-harbor",
      displayname: "Everus Harbor",
      nickname: "Everus",
      is_cargo_center: 0,
      max_container_size: null,
      type: "station",
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

  it("maps ALL terminals (no cargo-center filter), coerces flags + sizes + type", () => {
    const out = mapTerminals(terminalsPayload);
    // The non-cargo-center destination is KEPT now (the bug fix): every named
    // delivery location must be offerable.
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      name: "hdpc-cassillo",
      displayname: "HDPC-Cassillo",
      nickname: "Cassillo",
      isCargoCenter: true,
      maxContainerSize: 32,
      type: "distribution",
    });
    // numeric string container size coerced to number
    expect(out[1].maxContainerSize).toBe(24);
    // non-cargo-center row survives, carries its type, flag is false
    const everus = out.find((t) => t.name === "everus-harbor");
    expect(everus?.isCargoCenter).toBe(false);
    expect(everus?.type).toBe("station");
  });

  it("accepts the bundled snapshot shape (isCargoCenter / maxContainerSize keys)", () => {
    // The bundled snapshot stores already-normalized rows (isCargoCenter, not
    // is_cargo_center). mapTerminals must round-trip them unchanged in shape.
    const out = mapTerminals([
      {
        name: "Everus Harbor",
        displayname: "Everus Harbor",
        nickname: "Everus Harbor",
        isCargoCenter: true,
        maxContainerSize: 32,
        type: "station",
      },
    ]);
    expect(out[0]).toEqual({
      name: "Everus Harbor",
      displayname: "Everus Harbor",
      nickname: "Everus Harbor",
      isCargoCenter: true,
      maxContainerSize: 32,
      type: "station",
    });
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

    // Non-empty and the documented per-patch sizes. Locations are now the FULL
    // unioned destination set (stations + outposts + cities + venues +
    // distribution + curated), not just cargo centers. If a future patch changes
    // these, update via `npm run fetch:reference` and adjust deliberately.
    expect(ref.commodities).toHaveLength(205);
    expect(ref.terminals.length).toBeGreaterThan(150);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("returned data matches the bundled JSON exactly", () => {
    const client = createUexClient();
    const ref = client.getReferenceData();
    expect(ref.commodities).toEqual(refData.commodities);
    expect(ref.terminals).toEqual(refData.terminals);
    expect(ref.ships).toEqual(refData.ships);
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

  it("terminals have the correct shape (cargo-center is a flag, not a filter)", () => {
    const ref = createUexClient().getReferenceData();
    for (const t of ref.terminals as Terminal[]) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.displayname).toBe("string");
      expect(typeof t.nickname).toBe("string");
      expect(typeof t.isCargoCenter).toBe("boolean");
      expect(
        t.maxContainerSize === null || typeof t.maxContainerSize === "number",
      ).toBe(true);
    }
    // The fix: the set is NOT limited to cargo centers — most destinations are
    // not flagged cargo centers, so the list must contain non-cargo-center rows.
    expect(ref.terminals.some((t) => !t.isCargoCenter)).toBe(true);
  });

  it("serves cargo ships (scu > 0), sorted scu-descending, with real shapes", () => {
    const ref = createUexClient().getReferenceData();
    expect(ref.ships.length).toBeGreaterThan(0);
    for (const s of ref.ships) {
      expect(typeof s.name).toBe("string");
      expect(s.name.length).toBeGreaterThan(0);
      expect(typeof s.nameFull).toBe("string");
      expect(typeof s.company).toBe("string");
      expect(typeof s.slug).toBe("string");
      expect(s.slug.length).toBeGreaterThan(0);
      expect(typeof s.scu).toBe("number");
      expect(s.scu).toBeGreaterThan(0);
      expect(typeof s.gameVersion).toBe("string");
    }
    // Sorted by scu descending.
    for (let i = 1; i < ref.ships.length; i++) {
      expect(ref.ships[i - 1].scu).toBeGreaterThanOrEqual(ref.ships[i].scu);
    }
    // A known big hauler present (sanity that the data is real, not stub).
    expect(ref.ships.some((s) => s.name === "Hull E")).toBe(true);
  });

  it("offers the real haul destinations users were missing (the bug fix)", () => {
    const ref = createUexClient().getReferenceData();
    const has = (needle: string) =>
      ref.terminals.some((t) =>
        t.name.toLowerCase().includes(needle.toLowerCase()),
      );
    // Every destination from the bug report must now be pickable.
    expect(has("Everus Harbor")).toBe(true);
    expect(has("HDPC")).toBe(true);
    expect(has("Teasa")).toBe(true);
    expect(has("Lorville")).toBe(true);
    expect(has("Port Tressler")).toBe(true);
    expect(has("Baijini")).toBe(true);
  });

  it("isActive() is true (the bundled snapshot is always present)", () => {
    expect(createUexClient().isActive()).toBe(true);
  });

  it("accepts an injected snapshot override (for tests)", () => {
    const custom = {
      commodities: [{ name: "Quantanium", code: "QUAN", kind: "Mineral" }],
      terminals: [],
      ships: [
        {
          name: "Hull C",
          nameFull: "MISC Hull C",
          company: "MISC",
          slug: "hull-c",
          scu: 4608,
          gameVersion: "4.8",
        },
      ],
    };
    const ref = createUexClient({ snapshot: custom }).getReferenceData();
    expect(ref).toEqual(custom);
  });

  it("close() is a harmless no-op", () => {
    const client = createUexClient();
    expect(() => client.close()).not.toThrow();
  });
});
