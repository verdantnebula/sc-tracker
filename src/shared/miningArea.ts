// ============================================================================
// miningArea.ts — location-aware "minerals in your area" resolution (shared).
// ----------------------------------------------------------------------------
// Pure helpers (no DOM, no IPC) that map the player's last-known current
// location — the SAME humanized id the cargo top bar shows, derived from the
// last terminal/inventory event — onto the Stanton/Pyro body it sits at, then
// onto the set of mining-deposit "FoundAt" regions that count as "near you".
//
// WHY a curated keyword map and not a data field: the bundled reference
// terminals (electron/data/reference-data.json) carry NO body/planet/system
// field (only name/displayname/nickname/type), so there is nothing to match
// against directly. We instead match the current-location string against a
// defensive set of body-specific keywords/codes (station prefixes, city names,
// outpost codes), erring toward "no match" (show everything) over a wrong body.
//
// Consumed by the Mining mode views; lives in @shared so a later main-process
// feature can reuse the exact same rule.
// ============================================================================

import type { MiningDeposit } from "./types";

/** The four Stanton anchor bodies we resolve to (plus the Pyro system). */
export type Body = "Hurston" | "Crusader" | "microTech" | "ArcCorp" | "Pyro";

/** The four Stanton planets — used to know when to add the Stanton-wide regions. */
const STANTON_BODIES: ReadonlySet<Body> = new Set([
  "Hurston",
  "Crusader",
  "microTech",
  "ArcCorp",
]);

/**
 * Per-body keyword table. A current-location string resolves to a body if it
 * (case-insensitively) CONTAINS any of that body's keywords. Order matters:
 * Pyro is checked first so a Pyro station that happens to share a generic
 * substring can't be miscategorised as Stanton. Keywords are intentionally
 * specific (station prefixes like "HUR-", city names, distinctive outpost
 * codes) to avoid false positives.
 */
const BODY_KEYWORDS: { body: Body; keywords: string[] }[] = [
  {
    // Pyro first — its stations use distinctive prefixes/names. A Pyro-side
    // gateway ("Pyro Gateway (Stanton)") still means the player is heading to
    // Pyro, so the "pyro" keyword covers the gateways too.
    body: "Pyro",
    keywords: [
      "pyro",
      "pyam-",
      "ruin station",
      "checkmate",
      "starlight",
      "rod's fuel",
      "rat's nest",
      "dudley",
      "patch city",
      "ashland",
      "gaslight",
      "rappel",
      "shepherd's rest",
      "bueno ravine",
      "canard view",
      "last landings",
      "orbituary",
      "endgame",
      "feo canyon",
      "seer's canyon",
      "refinery ",
    ],
  },
  {
    body: "Hurston",
    keywords: [
      "hur-",
      "hurston",
      "lorville",
      "everus",
      "teasa",
      "hdms-",
      "hdpc-",
      "edmond",
      "stanhope",
    ],
  },
  {
    body: "microTech",
    keywords: [
      "mic-",
      "microtech",
      "new babbage",
      "babbage",
      "port tressler",
      "tressler",
      "rayari",
      "shubin mining facility sm",
      "the necropolis",
      "outpost 54",
      "ghost hollow",
      "shady glen",
      "bountiful harvest",
      "dunboro",
      "frostbite",
      "frigid knot",
      "clio",
      "calliope",
      "euterpe",
    ],
  },
  {
    body: "ArcCorp",
    keywords: [
      "arc-",
      "arccorp",
      "area 18",
      "area18",
      "baijini",
      "lyria",
      "wala",
      "humboldt",
      "shubin mining facility sal",
      "shubin mining facility scd",
      "shubin mining facility smca",
      "loveridge",
      "shady",
      "the orphanage",
      "wikelo",
    ],
  },
  {
    body: "Crusader",
    keywords: [
      "cru-",
      "crusader",
      "orison",
      "seraphim",
      "port olisar",
      "olisar",
      "cellin",
      "yela",
      "daymar",
      "gallete",
      "kudre",
      "bountiful",
      "brio's breaker",
      "dinger's",
      "nuen",
      "shubin mining facility smo",
      "tram & myers",
      "benson",
      "the golden riviera",
      "raven's roost",
    ],
  },
];

/** Stanton-wide deposit regions added for ANY Stanton body. */
const STANTON_SYSTEM_REGIONS: string[] = [
  "Aaron Halo",
  "Stanton Lagrange Points",
  "HUR-L",
  "CRU-L",
  "ARC-L",
  "MIC-L",
  "Found in All Deposits",
  "All Moons/Planets",
  "All Moons/Planets/Caves",
  "All Moons/Planets (Caves)",
];

/** Pyro-wide deposit regions added when the body is Pyro. */
const PYRO_SYSTEM_REGIONS: string[] = [
  "Pyro",
  "Found in All Pyro Deposits",
  "Inner Pyro Asteroids",
  "Outer Pyro Asteroids",
  "Pyro Asteroid Clusters",
  "Bloom",
  "Monox",
  "Ignis",
  "Vatra",
  "Vuur",
  "Fairo",
  "Fuego",
  "Adir",
  "Terminus",
];

/** Body -> its own name + moons (the body-local deposit regions). */
const BODY_LOCAL_REGIONS: Record<Body, string[]> = {
  Hurston: ["Hurston", "Aberdeen", "Arial", "Magda", "Ita"],
  Crusader: ["Crusader", "Cellin", "Yela", "Daymar"],
  microTech: ["microTech", "Calliope", "Clio", "Euterpe"],
  ArcCorp: ["ArcCorp", "Lyria", "Wala"],
  Pyro: ["Pyro"],
};

/**
 * Resolve the player's humanized current location to a Stanton/Pyro body.
 * Returns null when the location is empty or doesn't confidently match any body
 * (the caller degrades gracefully by showing everything). Case-insensitive
 * "contains" match against the curated per-body keyword table; Pyro is tested
 * first so its distinctive stations win over generic Stanton substrings.
 *
 *   resolveBody("Everus Harbor")        -> "Hurston"
 *   resolveBody("Port Tressler")        -> "microTech"
 *   resolveBody("HUR-L3 ...")           -> "Hurston"
 *   resolveBody("Ruin Station")         -> "Pyro"
 *   resolveBody(null) / resolveBody("") -> null
 */
export function resolveBody(
  currentLocation: string | null | undefined,
): Body | null {
  if (!currentLocation) return null;
  const s = currentLocation.trim().toLowerCase();
  if (s.length === 0) return null;
  for (const { body, keywords } of BODY_KEYWORDS) {
    if (keywords.some((k) => s.includes(k))) return body;
  }
  return null;
}

/**
 * The set of deposit "FoundAt" regions that count as "in your area" for a body:
 * the body itself + its moons, plus the system-wide regions (belts, Lagrange
 * points, "Found in All Deposits", "All Moons/Planets" phrases). Stanton bodies
 * get the Stanton-wide set; Pyro gets the Pyro-wide set. Returns a de-duplicated
 * array. Pure.
 */
export function areaRegionsForBody(body: Body | null): string[] {
  if (!body) return [];
  const out = [...BODY_LOCAL_REGIONS[body]];
  if (STANTON_BODIES.has(body)) out.push(...STANTON_SYSTEM_REGIONS);
  if (body === "Pyro") out.push(...PYRO_SYSTEM_REGIONS);
  return Array.from(new Set(out));
}

/**
 * True when a deposit is minable in the given area: ANY of its FoundAt entries
 * (case-insensitively) CONTAINS one of the area regions, OR a region contains
 * the FoundAt entry. The two-way contains handles both directions, e.g. region
 * "HUR-L" matching FoundAt "HUR-L3", and FoundAt "Found in All Deposits (Rare)"
 * matching region "Found in All Deposits". With an empty region set (no body
 * resolved) nothing is "in area" — callers should not filter in that case.
 * Pure.
 */
export function depositInArea(
  deposit: MiningDeposit,
  regions: string[],
): boolean {
  if (regions.length === 0) return false;
  const found = deposit.foundAt.map((f) => f.trim().toLowerCase());
  const regs = regions.map((r) => r.trim().toLowerCase());
  return found.some((f) =>
    regs.some((r) => r.length > 0 && (f.includes(r) || r.includes(f))),
  );
}
