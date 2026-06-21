// ============================================================================
// sortDestinations.test.ts — the dropdown ordering helper (FIX 1).
// sortDestinations OFFERS every destination (never filters) and surfaces cargo
// centers first, each group alphabetical. Pure; no Electron/IO.
// ============================================================================

import { describe, it, expect } from "vitest";
import { sortDestinations } from "@shared/location";
import type { Terminal } from "@shared/types";

function term(
  name: string,
  isCargoCenter: boolean,
  type?: Terminal["type"],
): Terminal {
  return {
    name,
    displayname: name,
    nickname: name,
    isCargoCenter,
    maxContainerSize: null,
    ...(type ? { type } : {}),
  };
}

describe("sortDestinations", () => {
  it("keeps EVERY destination — it sorts, it never filters", () => {
    const input = [
      term("Everus Harbor", false, "station"),
      term("Port Tressler", true, "station"),
      term("HDPC-Cassillo", true, "distribution"),
    ];
    const out = sortDestinations(input);
    expect(out).toHaveLength(3); // nothing dropped, including the non-cargo-center
    expect(out.map((t) => t.name).sort()).toEqual([
      "Everus Harbor",
      "HDPC-Cassillo",
      "Port Tressler",
    ]);
  });

  it("surfaces cargo centers first, then everything else, each alphabetical", () => {
    const input = [
      term("Zeta Station", false),
      term("Alpha Outpost", false),
      term("Port Tressler", true),
      term("Baijini Point", true),
    ];
    const out = sortDestinations(input).map((t) => t.name);
    // cargo centers (alpha) first, then non-cargo-centers (alpha)
    expect(out).toEqual([
      "Baijini Point",
      "Port Tressler",
      "Alpha Outpost",
      "Zeta Station",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [term("B", false), term("A", true)];
    const copy = [...input];
    sortDestinations(input);
    expect(input).toEqual(copy);
  });
});
