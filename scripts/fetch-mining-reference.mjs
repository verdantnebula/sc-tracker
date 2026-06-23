// ============================================================================
// scripts/fetch-mining-reference.mjs — DEV-ONLY mining reference snapshot gen.
// ----------------------------------------------------------------------------
// Regenerates electron/data/mining-reference.json from two BUNDLED source CSVs
// of pure Star Citizen GAME reference data (no personal data, no network, no
// token). Run when the source CSVs change for a new game patch:
//
//     npm run fetch:mining-reference
//
// Sources (committed under electron/data/sources/):
//   • rock_values.csv        header: RockName,Rarity,1,2,3,4,5,6
//       Columns 1..6 are the radar SCAN SIGNATURE values a miner reads off the
//       mining scanner — NOT prices. Each of the 6 is base × 1..6 (tier).
//       Rarity ∈ Common/Uncommon/Rare/Epic/Legendary.
//   • mineable_locations.csv header: Name,Type,FoundAt
//       Type ∈ Ship/Hand/Ground Vehicle Mineable, Harvestable, Creature (plus
//       rarity-qualified variants). FoundAt is a comma-separated location list
//       or a phrase ("Found in All Deposits", "All Moons/Planets/Caves").
//
// Output shape (electron/data/mining-reference.json):
//   {
//     fetchedAt: number,
//     source: string,
//     rocks:    [{ name, rarity, scanValues: number[6] }],   // 26 rows
//     deposits: [{ name, type, foundAt: string[] }],          // 61 rows
//   }
//
// GAME QUIRKS preserved as-is (intentional, do NOT "fix"):
//   • three Aluminum spellings in the deposits list: Aluminium / Aluminum /
//     Alumium (the last is a CIG typo) — kept verbatim.
//   • "Janalite (Caves only)" kept as a distinct deposit row.
// NORMALIZATION:
//   • the rocks list spells one ore "Gold 1"; that is the SAME ore as the "Gold"
//     row in the deposits list, so we normalize "Gold 1" -> "Gold" in the rocks
//     output. This lets the SCAN LOOKUP cross-link a Gold match to its deposit
//     info by name. (Only the rocks list is normalized — deposits already say
//     "Gold".)
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC_DIR = join(ROOT, "electron", "data", "sources");
const ROCKS_CSV = join(SRC_DIR, "rock_values.csv");
const LOCATIONS_CSV = join(SRC_DIR, "mineable_locations.csv");
const OUT_PATH = join(ROOT, "electron", "data", "mining-reference.json");

// ---------------------------------------------------------------------------
// Minimal RFC-4180-ish CSV parser: handles quoted fields that contain commas
// (the FoundAt column is a quoted, comma-separated list) and doubled "" quotes.
// Returns an array of string-cell rows (no header handling here).
// ---------------------------------------------------------------------------
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  // Normalize newlines so a trailing \r never sneaks into the last cell.
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // Flush the trailing field/row (file may not end in a newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-empty rows (e.g. a blank trailing line in the source CSV).
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

// ---------------------------------------------------------------------------
// rock_values.csv -> rocks[]
// ---------------------------------------------------------------------------
export function parseRocks(csvText) {
  const rows = parseCsv(csvText);
  const [header, ...body] = rows;
  if (!header || header[0].trim() !== "RockName") {
    throw new Error(
      `[fetch:mining-reference] unexpected rock_values.csv header: ${JSON.stringify(
        header,
      )}`,
    );
  }
  return body.map((cols) => {
    const rawName = cols[0].trim();
    // "Gold 1" in the rocks list is the same ore as "Gold" in deposits.
    const name = rawName === "Gold 1" ? "Gold" : rawName;
    const rarity = cols[1].trim();
    const scanValues = cols.slice(2, 8).map((v) => {
      const n = Number(v.trim());
      if (!Number.isFinite(n)) {
        throw new Error(
          `[fetch:mining-reference] non-numeric scan value for ${rawName}: ${JSON.stringify(
            v,
          )}`,
        );
      }
      return n;
    });
    if (scanValues.length !== 6) {
      throw new Error(
        `[fetch:mining-reference] ${rawName} has ${scanValues.length} scan values (expected 6).`,
      );
    }
    return { name, rarity, scanValues };
  });
}

// ---------------------------------------------------------------------------
// mineable_locations.csv -> deposits[]
// FoundAt: split on commas + trim. Phrases that are a single descriptive entry
// ("Found in All Deposits", "All Moons/Planets/Caves") have no top-level comma,
// so they survive as one element naturally.
// ---------------------------------------------------------------------------
export function parseDeposits(csvText) {
  const rows = parseCsv(csvText);
  const [header, ...body] = rows;
  if (!header || header[0].trim() !== "Name") {
    throw new Error(
      `[fetch:mining-reference] unexpected mineable_locations.csv header: ${JSON.stringify(
        header,
      )}`,
    );
  }
  return body.map((cols) => {
    const name = cols[0].trim();
    const type = cols[1].trim();
    const foundAt = (cols[2] ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    return { name, type, foundAt };
  });
}

export function buildSnapshot(rocksCsv, locationsCsv) {
  const rocks = parseRocks(rocksCsv);
  const deposits = parseDeposits(locationsCsv);
  return {
    fetchedAt: Date.now(),
    source: "rock_values.csv + mineable_locations.csv (bundled game reference)",
    rocks,
    deposits,
  };
}

// ---------------------------------------------------------------------------
// main (only when run directly, not when imported by tests)
// ---------------------------------------------------------------------------
function main() {
  const rocksCsv = readFileSync(ROCKS_CSV, "utf-8");
  const locationsCsv = readFileSync(LOCATIONS_CSV, "utf-8");
  const snapshot = buildSnapshot(rocksCsv, locationsCsv);

  if (snapshot.rocks.length === 0 || snapshot.deposits.length === 0) {
    throw new Error(
      `[fetch:mining-reference] refusing to write empty snapshot ` +
        `(rocks=${snapshot.rocks.length}, deposits=${snapshot.deposits.length}).`,
    );
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");

  const byRarity = snapshot.rocks.reduce((acc, r) => {
    acc[r.rarity] = (acc[r.rarity] || 0) + 1;
    return acc;
  }, {});
  const byType = snapshot.deposits.reduce((acc, d) => {
    acc[d.type] = (acc[d.type] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `[fetch:mining-reference] wrote ${OUT_PATH}\n` +
      `  rocks:    ${snapshot.rocks.length}  by rarity: ${JSON.stringify(byRarity)}\n` +
      `  deposits: ${snapshot.deposits.length}  by type:   ${JSON.stringify(byType)}`,
  );
}

// Run main only as a CLI; tests import the pure helpers above.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    console.error("[fetch:mining-reference] failed:", err.message);
    process.exit(1);
  }
}
