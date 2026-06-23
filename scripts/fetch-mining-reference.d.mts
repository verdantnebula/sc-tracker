// Type declarations for the dev converter script's PURE, exported helpers so
// they can be imported from TypeScript tests (the runtime is plain JS .mjs).
// These mirror the shapes produced by scripts/fetch-mining-reference.mjs.

import type { MiningRock, MiningDeposit } from "../src/shared/types";

/** Minimal RFC-4180-ish CSV parser: quoted fields, doubled quotes, blank-row drop. */
export function parseCsv(text: string): string[][];

/** rock_values.csv -> rocks[] (with 'Gold 1' normalized to 'Gold'). */
export function parseRocks(csvText: string): MiningRock[];

/** mineable_locations.csv -> deposits[] (FoundAt parsed to a string array). */
export function parseDeposits(csvText: string): MiningDeposit[];

/** The full bundled snapshot (rocks + deposits + metadata). */
export function buildSnapshot(
  rocksCsv: string,
  locationsCsv: string,
): {
  fetchedAt: number;
  source: string;
  rocks: MiningRock[];
  deposits: MiningDeposit[];
};
