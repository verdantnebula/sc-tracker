// ============================================================================
// routeOptimize.ts — pure route optimizer for the ROUTE tab (Phase C).
// ----------------------------------------------------------------------------
// A run is a capacitated pickup-and-delivery problem (NP-hard), so this is a
// DETERMINISTIC HEURISTIC, surfaced as a "suggested order" — never "optimal".
//
// Pipeline:
//   1. buildStops(missions)      -> flatten active legs into Stop[] (pickup/dropoff)
//   2. nearest-neighbor seed     -> from an optional start position (Euclidean)
//   3. 2-opt improvement         -> rejects any swap that breaks precedence/capacity
//
// Constraints enforced at every reorder:
//   (a) PRECEDENCE — a dropoff must come after the pickup(s) that supply its
//       commodity for the SAME mission.
//   (b) CAPACITY   — running load (picked-up-not-yet-delivered SCU) must never
//       exceed ship capacity, when a ship capacity is provided.
//
// Everything here is pure (no React, no IPC, no store). Distances are raw
// Euclidean units on Leg.position; the UI displays them relatively.
// ============================================================================

import type { Mission, Position } from "@shared/types";
import { isActive } from "./selectors";
import { isConfidentLocationMatch } from "@shared/location";

/** A single visit in the optimized order — one pickup or one dropoff leg. */
export interface Stop {
  /** Stable id: `${missionId}:${legId}`. */
  id: string;
  kind: "pickup" | "dropoff";
  /** Location label, or null when the log never reported one. */
  location: string | null;
  /** World position from the leg's marker; absent for game-suppressed legs. */
  position?: Position;
  commodity: string;
  /** SCU on this leg (drives the running-load capacity check). */
  scu: number;
  missionId: string;
  legId: string;
  /** True when this stop has no resolvable position (appended at the end). */
  missingPosition: boolean;
}

/** The optimizer result. `totalDistance` is in raw position units (display relative). */
export interface OptimizeResult {
  ordered: Stop[];
  totalDistance: number;
  /** True when one or more stops had no position and were appended unsequenced. */
  hasMissingPositions: boolean;
  /** True when no ordering can keep running load within capacity (ship set). */
  infeasibleCapacity: boolean;
}

export interface OptimizeOptions {
  /** Ship hold capacity in SCU. When > 0, the capacity constraint is enforced. */
  capacity?: number | null;
  /** Optional start position (e.g. resolved from currentLocation). */
  start?: Position | null;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Euclidean distance between two world positions (raw units). */
export function distance(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Total path distance over a sequence of positioned stops, optionally including
 * the leg from `start` to the first stop. Stops without a position contribute
 * nothing (they're unsequenced) and don't break the chain — the distance is
 * measured between consecutive POSITIONED stops only.
 */
export function pathDistance(stops: Stop[], start?: Position | null): number {
  let total = 0;
  let prev: Position | null = start ?? null;
  for (const s of stops) {
    if (!s.position) continue;
    if (prev) total += distance(prev, s.position);
    prev = s.position;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Stop construction
// ---------------------------------------------------------------------------

/**
 * Flatten the ACTIVE missions into a flat Stop list — one stop per leg. Order
 * is deterministic: missions in input order, then legs in input order. Each
 * stop records whether it has a usable position so the optimizer can keep
 * position-less stops out of the geometric ordering.
 *
 * Already-completed legs are EXCLUDED: a picked-up/delivered leg is no longer a
 * pending stop to route to, and including it would distort precedence/capacity.
 */
export function buildStops(missions: Mission[]): Stop[] {
  const stops: Stop[] = [];
  for (const m of missions) {
    if (!isActive(m)) continue;
    for (const l of m.legs) {
      if (l.completed) continue;
      stops.push({
        id: `${m.id}:${l.id}`,
        kind: l.kind,
        location: l.location,
        position: l.position,
        commodity: l.commodity,
        scu: l.scuTotal,
        missionId: m.id,
        legId: l.id,
        missingPosition: l.position == null,
      });
    }
  }
  return stops;
}

/**
 * Best-effort resolve a START position from the tracked `currentLocation` string
 * by finding a pending leg AT that location that carries a position. Returns null
 * when there's no confident location match or no positioned leg there — the
 * optimizer then simply seeds from the first stop instead. Deterministic: scans
 * legs in stop order and takes the first confident, positioned match.
 */
export function resolveStartPosition(
  missions: Mission[],
  currentLocation: string | null,
): Position | null {
  if (!currentLocation) return null;
  for (const s of buildStops(missions)) {
    if (!s.position || !s.location) continue;
    if (isConfidentLocationMatch(currentLocation, s.location))
      return s.position;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

/**
 * Precedence map: for each dropoff stop, the set of pickup stop-ids (same
 * mission, same commodity) that must precede it. If a mission has a dropoff for
 * a commodity but NO matching pickup (the pickup was suppressed/already done),
 * that dropoff simply has no predecessor — it's unconstrained, not infeasible.
 */
export function buildPrecedence(stops: Stop[]): Map<string, Set<string>> {
  const prec = new Map<string, Set<string>>();
  for (const d of stops) {
    if (d.kind !== "dropoff") continue;
    const preds = new Set<string>();
    for (const p of stops) {
      if (p.kind !== "pickup") continue;
      if (p.missionId !== d.missionId) continue;
      // Commodity match when both name a commodity; if either is blank we treat
      // the pickup as a generic source for the mission (still must precede).
      if (p.commodity && d.commodity && p.commodity !== d.commodity) continue;
      preds.add(p.id);
    }
    if (preds.size > 0) prec.set(d.id, preds);
  }
  return prec;
}

/**
 * Precedence check: every dropoff appears after all of its required pickups in
 * the given order. Stops not present in the order (shouldn't happen) are ignored.
 */
export function precedenceOk(
  order: Stop[],
  prec: Map<string, Set<string>>,
): boolean {
  const indexById = new Map<string, number>();
  order.forEach((s, i) => indexById.set(s.id, i));
  for (const [dropId, preds] of prec) {
    const di = indexById.get(dropId);
    if (di == null) continue;
    for (const pid of preds) {
      const pi = indexById.get(pid);
      if (pi == null) continue; // pickup not in this run -> no constraint
      if (pi >= di) return false; // pickup at/after its dropoff -> violation
    }
  }
  return true;
}

/**
 * Capacity check: simulate the run, adding SCU on pickup and removing it on
 * dropoff. Returns false if running load ever exceeds capacity. Capacity <= 0
 * (no ship) always passes. The simulation removes a dropoff's SCU regardless of
 * which pickup supplied it — load is a single fungible pool of carried SCU.
 */
export function capacityOk(order: Stop[], capacity: number): boolean {
  if (!(capacity > 0)) return true;
  let load = 0;
  for (const s of order) {
    if (s.kind === "pickup") {
      load += s.scu;
      if (load > capacity) return false;
    } else {
      load -= s.scu;
      if (load < 0) load = 0; // guard against orphan dropoffs (no matching pickup)
    }
  }
  return true;
}

/**
 * Is even a SINGLE pickup too large for the hold? If so the run is capacity-
 * infeasible no matter the order (it needs multiple trips). Used to set
 * `infeasibleCapacity` honestly rather than silently emitting an order that
 * violates the constraint.
 */
function anyPickupExceedsCapacity(stops: Stop[], capacity: number): boolean {
  if (!(capacity > 0)) return false;
  return stops.some((s) => s.kind === "pickup" && s.scu > capacity);
}

// ---------------------------------------------------------------------------
// Heuristic: nearest-neighbor seed
// ---------------------------------------------------------------------------

/**
 * Nearest-neighbor over the POSITIONED stops, honoring precedence + capacity at
 * each pick. From the current point, choose the closest stop whose insertion
 * keeps the partial order feasible; ties broken by stop id (deterministic).
 * If no feasible-by-constraints stop is reachable, fall back to the closest
 * stop overall (so we always make progress; final feasibility is reported
 * separately via infeasibleCapacity).
 */
function nearestNeighbor(
  positioned: Stop[],
  prec: Map<string, Set<string>>,
  capacity: number,
  start?: Position | null,
): Stop[] {
  const remaining = [...positioned];
  const order: Stop[] = [];
  let cur: Position | null = start ?? null;
  let load = 0;

  // A pickup whose predecessors-of-its-dropoffs... precedence only constrains
  // dropoffs (a dropoff needs its pickups first). So a dropoff is placeable only
  // when all its required pickups are already in `order`.
  const placed = new Set<string>();

  const dropoffReady = (s: Stop): boolean => {
    if (s.kind !== "dropoff") return true;
    const preds = prec.get(s.id);
    if (!preds) return true;
    for (const pid of preds) {
      // only enforce predecessors that actually exist in this run's stop set
      if (positioned.some((p) => p.id === pid) && !placed.has(pid))
        return false;
    }
    return true;
  };

  const capacityReady = (s: Stop): boolean => {
    if (!(capacity > 0)) return true;
    if (s.kind !== "pickup") return true;
    return load + s.scu <= capacity;
  };

  while (remaining.length > 0) {
    // Candidate ordering: prefer fully-feasible (precedence + capacity), then
    // precedence-only, then anything — within each tier by distance, then id.
    const score = (s: Stop): [number, number, string] => {
      const tier = dropoffReady(s) ? (capacityReady(s) ? 0 : 1) : 2;
      const d = cur && s.position ? distance(cur, s.position) : 0;
      return [tier, d, s.id];
    };
    remaining.sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      return sa[0] - sb[0] || sa[1] - sb[1] || (sa[2] < sb[2] ? -1 : 1);
    });
    const next = remaining.shift()!;
    order.push(next);
    placed.add(next.id);
    if (next.kind === "pickup") load += next.scu;
    else load = Math.max(0, load - next.scu);
    if (next.position) cur = next.position;
  }
  return order;
}

// ---------------------------------------------------------------------------
// Heuristic: 2-opt improvement (constraint-respecting)
// ---------------------------------------------------------------------------

/**
 * Standard 2-opt: repeatedly reverse a sub-segment if it shortens the path AND
 * the reversed order still satisfies precedence + capacity. Deterministic
 * (fixed i<j scan order, strict improvement threshold). Operates only on the
 * positioned stops; converges when a full pass makes no improving reversal.
 */
function twoOpt(
  order: Stop[],
  prec: Map<string, Set<string>>,
  capacity: number,
  start?: Position | null,
): Stop[] {
  let best = [...order];
  let bestDist = pathDistance(best, start);
  let improved = true;
  // Guard against pathological loops on large inputs; routes here are small.
  let guard = 0;
  const maxPasses = best.length * best.length + 1;

  while (improved && guard++ < maxPasses) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = best
          .slice(0, i)
          .concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        if (!precedenceOk(candidate, prec)) continue;
        if (!capacityOk(candidate, capacity)) continue;
        const d = pathDistance(candidate, start);
        if (d < bestDist - 1e-9) {
          best = candidate;
          bestDist = d;
          improved = true;
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute a suggested visit order for the active run.
 *
 * Steps: build stops -> split positioned / position-less -> NN seed -> 2-opt.
 * Position-less stops are appended at the end in a STABLE order (sorted by id)
 * and flagged via `missingPosition`; they never perturb the geometric ordering.
 *
 * `infeasibleCapacity` is true when a ship capacity is set and either (a) a
 * single pickup is larger than the hold, or (b) no feasible capacity ordering of
 * the positioned stops could be produced. In that case `ordered` is still the
 * best-effort heuristic order (so the UI has something to show) — the flag tells
 * the UI to warn "needs multiple trips / reorder".
 */
export function optimizeRoute(
  missions: Mission[],
  options: OptimizeOptions = {},
): OptimizeResult {
  const capacity = options.capacity ?? 0;
  const start = options.start ?? null;

  const stops = buildStops(missions);

  // Empty / single-stop fast paths (no geometry to do).
  if (stops.length === 0) {
    return {
      ordered: [],
      totalDistance: 0,
      hasMissingPositions: false,
      infeasibleCapacity: false,
    };
  }

  const positioned = stops.filter((s) => !s.missingPosition);
  const missing = stops
    .filter((s) => s.missingPosition)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const prec = buildPrecedence(stops);

  let orderedPositioned: Stop[];
  if (positioned.length <= 1) {
    orderedPositioned = positioned;
  } else {
    const seed = nearestNeighbor(positioned, prec, capacity, start);
    orderedPositioned = twoOpt(seed, prec, capacity, start);
  }

  const ordered = orderedPositioned.concat(missing);
  const totalDistance = pathDistance(orderedPositioned, start);

  const infeasibleCapacity =
    anyPickupExceedsCapacity(stops, capacity) ||
    !capacityOk(orderedPositioned, capacity);

  return {
    ordered,
    totalDistance,
    hasMissingPositions: missing.length > 0,
    infeasibleCapacity,
  };
}

/**
 * Map each LOCATION label to its 1-based visit number, derived from the ordered
 * stops: a location is numbered the first time it appears in the order. Lets the
 * MAP view (which is keyed by location, not leg) badge its nodes by visit order.
 * Stops with no location are skipped. Unsequenced (position-less) stops are
 * skipped too — only sequenced stops get a number.
 */
export function locationVisitOrder(ordered: Stop[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const s of ordered) {
    if (s.missingPosition) continue;
    if (!s.location) continue;
    if (out.has(s.location)) continue;
    out.set(s.location, ++n);
  }
  return out;
}
