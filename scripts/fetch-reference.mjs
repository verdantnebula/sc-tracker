// ============================================================================
// scripts/fetch-reference.mjs — DEV-ONLY UEX reference snapshot generator
// ----------------------------------------------------------------------------
// Regenerates electron/data/reference-data.json from the live UEX Corp API.
// Run this once per game patch (commodities/locations change per patch):
//
//     npm run fetch:reference
//
// It reads the Bearer token from config.local.json (gitignored, dev-only — the
// token is NEVER shipped in the packaged app). The packaged app reads only the
// bundled snapshot this script writes; it never hits the network or the token.
//
// The UEX API 403s the default Node fetch User-Agent, so we send a browser-like
// one.
//
// LOCATIONS (the fix): the cargo dropdowns need EVERY place a player can deliver
// to, not just `is_cargo_center` terminals. So we UNION named locations from
//   /space_stations  (Everus Harbor, Baijini Point, Port Tressler, …)
//   /outposts        (HDMS-*, mining outposts, …)
//   /cities          (Lorville, Area 18, …)
//   /terminals       (the parent *_name fields + parsed venue names like
//                     "Teasa Spaceport"; ALL terminals, not just cargo centers)
//   /poi             (distribution / logistics depots — S4DC*, S4LD* haul drops)
// then de-duplicate by name into the shared Terminal shape. is_cargo_center is
// PRESERVED (for optional sort/group) but NEVER used to exclude a destination.
//
// SHIPS (Phase A): we also fetch /vehicles and keep the cargo-capable ones
// (scu > 0) as ShipReference rows for the ship picker + hold-capacity bar. The
// read endpoint is token-free, but we call it with the same Bearer header for
// consistency with the rest of the script. Sorted scu-descending.
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CONFIG_PATH = join(ROOT, "config.local.json");
const OUT_PATH = join(ROOT, "electron", "data", "reference-data.json");

const BASE_URL = "https://api.uexcorp.uk/2.0";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// --- token ------------------------------------------------------------------

function loadToken() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    console.error(
      `[fetch:reference] config.local.json not found at ${CONFIG_PATH}.\n` +
        `Copy config.example.json -> config.local.json and set a real uexToken.`,
    );
    process.exit(1);
  }
  const parsed = JSON.parse(raw);
  const token = parsed.uexToken;
  if (typeof token !== "string" || token.length === 0 || token === "REPLACE_ME") {
    console.error(
      "[fetch:reference] config.local.json has no valid uexToken. Aborting.",
    );
    process.exit(1);
  }
  return token;
}

// --- normalization (commodities mirror electron/uexClient.ts) ---------------

function asArray(resp) {
  if (Array.isArray(resp)) return resp;
  if (resp && typeof resp === "object" && Array.isArray(resp.data))
    return resp.data;
  return [];
}

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const truthyFlag = (v) => v === 1 || v === true || v === "1";

function numOrNull(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))
    return Number(v);
  return null;
}

function mapCommodities(resp) {
  return asArray(resp)
    .map((r) => ({ name: str(r.name), code: str(r.code), kind: str(r.kind) }))
    .filter((c) => c.name.length > 0);
}

// --- ships (cargo-capable vehicles) -----------------------------------------

/**
 * Map UEX /vehicles rows to the bundled ShipReference shape. Only vehicles with
 * a positive cargo grid (scu > 0) are kept — the picker is about HOLD CAPACITY,
 * so fighters/ground vehicles with no cargo are excluded. Sorted scu-descending
 * so the biggest haulers (Hull E/D/C, M2/A2/C2…) lead the dropdown.
 */
function mapShips(resp) {
  return asArray(resp)
    .map((r) => ({
      name: str(r.name),
      nameFull: str(r.name_full),
      company: str(r.company_name),
      slug: str(r.slug),
      scu: numOrNull(r.scu) ?? 0,
      gameVersion: str(r.game_version),
    }))
    .filter((s) => s.name.length > 0 && s.slug.length > 0 && s.scu > 0)
    .sort((a, b) => b.scu - a.scu);
}

// --- location union ---------------------------------------------------------

/**
 * Accumulates de-duplicated locations keyed by lowercased name. Cargo-center
 * truthiness is OR-merged (any source flagging a name as a cargo center wins),
 * and a meaningful `type` is kept (the first non-"terminal" type seen).
 */
class LocationSet {
  constructor() {
    this.byKey = new Map();
  }
  add(name, type, isCargoCenter, maxContainerSize = null) {
    const clean = str(name).trim();
    if (clean.length === 0) return;
    const key = clean.toLowerCase();
    const existing = this.byKey.get(key);
    if (!existing) {
      this.byKey.set(key, {
        name: clean,
        displayname: clean,
        nickname: clean,
        isCargoCenter: !!isCargoCenter,
        maxContainerSize,
        type: type || "terminal",
      });
      return;
    }
    if (isCargoCenter) existing.isCargoCenter = true;
    if (existing.type === "terminal" && type && type !== "terminal")
      existing.type = type;
    if (existing.maxContainerSize == null && maxContainerSize != null)
      existing.maxContainerSize = maxContainerSize;
  }
  values() {
    return [...this.byKey.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
}

/**
 * Parse a venue name out of a UEX terminal `name` like
 *   "New Deal - Teasa Spaceport - Lorville"  -> "Teasa Spaceport"
 * Returns the middle segment when the name is "Shop - Venue - City" shaped and
 * the venue looks like a real landing place (Spaceport / Port / Station / …).
 * Returns null otherwise (so we don't pollute the list with shop names).
 */
function venueFromTerminalName(name) {
  const parts = str(name)
    .split(" - ")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  const mid = parts[parts.length - 2];
  if (/spaceport|space port|landing|terminal|port\b/i.test(mid)) return mid;
  return null;
}

function looksLikeDistributionPoi(name) {
  return /distribution cent|logistics depot|cargo cent|S\dDC\d|S\dLD\d/i.test(
    str(name),
  );
}

// Curated supplement: real, current-patch hauling DELIVERY POINTS that the UEX
// 2.0 dataset does not (yet) catalog under a pickable name. These are the
// contested-zone / distribution-center drops players see in HaulCargo contracts
// (e.g. "HDPC-Cassillo"). Kept as a short, named list so a future regen still
// offers them; merged with cargo-center=true so they sort with the real drops.
// PURELY game data — no personal data.
const CURATED_LOCATIONS = [
  { name: "HDPC-Cassillo", type: "distribution" },
  { name: "HDPC-Farnesway", type: "distribution" },
  { name: "CRU-L4 Distribution Center", type: "distribution" },
  { name: "MIC-L1 Distribution Center", type: "distribution" },
];

function buildLocations({ stations, outposts, cities, terminals, pois }) {
  const set = new LocationSet();

  // Parent locations (clean canonical names).
  for (const s of asArray(stations))
    set.add(s.name, "station", truthyFlag(s.has_cargo_center));
  for (const o of asArray(outposts))
    set.add(o.name, "outpost", truthyFlag(o.has_cargo_center));
  for (const c of asArray(cities))
    set.add(c.name, "city", truthyFlag(c.has_cargo_center));

  // Terminals: prefer the resolved parent-location *_name fields (clean), tag a
  // cargo-center flag, and harvest named venues (Teasa Spaceport, …). We do NOT
  // dump the raw shop-prefixed terminal `name` — it's noisy ("Admin - X").
  for (const t of asArray(terminals)) {
    const cargo = truthyFlag(t.is_cargo_center);
    const mcs = numOrNull(t.max_container_size);
    if (str(t.space_station_name)) set.add(t.space_station_name, "station", cargo, mcs);
    if (str(t.outpost_name)) set.add(t.outpost_name, "outpost", cargo, mcs);
    if (str(t.city_name)) set.add(t.city_name, "city", cargo, mcs);
    const venue = venueFromTerminalName(t.name);
    if (venue) set.add(venue, "venue", cargo, mcs);
  }

  // Distribution / logistics depots — the new haul-cargo delivery points.
  for (const p of asArray(pois)) {
    if (looksLikeDistributionPoi(p.name)) set.add(p.name, "distribution", true);
  }

  // Curated drops UEX doesn't catalog by a pickable name (HDPC-*, etc.).
  for (const c of CURATED_LOCATIONS) set.add(c.name, c.type, true);

  return set.values();
}

// --- fetch ------------------------------------------------------------------

async function fetchResource(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`UEX ${path} HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function main() {
  const token = loadToken();
  console.log(
    "[fetch:reference] fetching /commodities, /terminals, /space_stations, /outposts, /cities, /poi, /vehicles …",
  );

  const [commRaw, termRaw, stationRaw, outpostRaw, cityRaw, poiRaw, vehicleRaw] =
    await Promise.all([
      fetchResource("/commodities", token),
      fetchResource("/terminals", token),
      fetchResource("/space_stations", token),
      fetchResource("/outposts", token),
      fetchResource("/cities", token),
      fetchResource("/poi", token),
      fetchResource("/vehicles", token),
    ]);

  const commodities = mapCommodities(commRaw);
  const terminals = buildLocations({
    stations: stationRaw,
    outposts: outpostRaw,
    cities: cityRaw,
    terminals: termRaw,
    pois: poiRaw,
  });
  const ships = mapShips(vehicleRaw);

  if (commodities.length === 0 || terminals.length === 0) {
    throw new Error(
      `[fetch:reference] refusing to write empty snapshot ` +
        `(commodities=${commodities.length}, locations=${terminals.length}).`,
    );
  }
  if (ships.length === 0) {
    throw new Error(
      `[fetch:reference] /vehicles returned no cargo ships (scu > 0). ` +
        `Refusing to write a snapshot with an empty ship picker.`,
    );
  }

  const snapshot = {
    fetchedAt: Date.now(),
    source: "uexcorp.space API 2.0",
    commodities,
    terminals,
    ships,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");

  const cargoCenters = terminals.filter((t) => t.isCargoCenter).length;
  const byType = terminals.reduce((acc, t) => {
    acc[t.type] = (acc[t.type] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `[fetch:reference] wrote ${OUT_PATH}\n` +
      `  commodities: ${commodities.length}\n` +
      `  locations:   ${terminals.length} (cargo centers: ${cargoCenters})\n` +
      `  by type:     ${JSON.stringify(byType)}\n` +
      `  ships:       ${ships.length} (top: ${ships
        .slice(0, 3)
        .map((s) => `${s.name} ${s.scu}SCU`)
        .join(", ")})`,
  );
}

main().catch((err) => {
  console.error("[fetch:reference] failed:", err.message);
  process.exit(1);
});
