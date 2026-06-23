// ============================================================================
// nextStop.ts — pure "next stop" derivation for the always-on-top overlay (Phase D).
// ----------------------------------------------------------------------------
// The overlay floats over the game and answers ONE question: "where do I go next
// and what do I unload there?". This module derives that view-model from the
// ACTIVE missions, reusing the EXACT same primitives the main UI uses so the two
// windows can never disagree:
//
//   - dropoffGroups(...)  -> the per-location cargo lines (Commodity · SCU)
//   - optimizeRoute(...)  -> the suggested visit ORDER (so "next" follows the
//                            same route the ROUTE tab suggests)
//
// Strategy for ordering the stops shown in the overlay:
//   1. Take dropoffGroups -> the set of stops that still have undelivered cargo
//      (an `allDone` group is a CLEARED stop and is excluded).
//   2. Order those stops by the optimizer's location visit order when available
//      (optimizeRoute -> locationVisitOrder). Stops the optimizer didn't sequence
//      (no position) keep dropoffGroups' own order (active-first, remaining desc),
//      appended after the sequenced ones — mirroring how the ROUTE tab degrades.
//   3. The FIRST stop in that order is the "next stop".
//
// Everything here is pure (no React, no IPC). Fully unit-tested (nextStop.test.ts).
// ============================================================================

import type { Mission, ShipReference } from "@shared/types";
import { dropoffGroups } from "./selectors";
import { optimizeRoute, locationVisitOrder } from "./routeOptimize";

/** One commodity line to unload at a stop — mirrors the main UI's CommodityLine. */
export interface NextStopLine {
  commodity: string;
  /** Remaining SCU still to unload for this commodity at this stop. */
  scuRemaining: number;
}

/** A single overlay stop: a location plus the cargo still to unload there. */
export interface NextStop {
  /** Destination label (already humanized by the upstream selectors). */
  location: string;
  /** Cargo lines still owed at this stop (Commodity · SCU), remaining desc. */
  lines: NextStopLine[];
  /** Total remaining SCU across this stop's lines. */
  scuRemaining: number;
  /** True when this stop matches the tracked current location (YOU ARE HERE). */
  isCurrentLocation: boolean;
  /** True when the log never gave this stop a destination ("Set destination"). */
  needsLocation: boolean;
}

export interface NextStopResult {
  /** Ordered, not-yet-cleared dropoff stops (first = the next stop). */
  stops: NextStop[];
}

export interface NextStopOptions {
  /** Selected ship (drives the optimizer's capacity constraint). */
  ship?: ShipReference | null;
}

/**
 * Build the overlay's ordered list of remaining dropoff stops.
 *
 * Pure + total: with no active missions (or none with undelivered dropoffs) it
 * returns an empty `stops` array, which the overlay renders as a muted placeholder.
 */
export function nextStops(
  missions: Mission[],
  currentLocation: string | null,
  options: NextStopOptions = {},
): NextStopResult {
  // The cargo lines per location — the SAME aggregation the By-Dropoff view uses.
  // `allDone` groups (CLEARED) carry no remaining cargo, so we drop them: the
  // overlay only ever shows places you still have to drive to.
  const groups = dropoffGroups(missions, currentLocation).filter(
    (g) => !g.allDone,
  );
  if (groups.length === 0) return { stops: [] };

  // Suggested visit order (same heuristic as the ROUTE tab). Capacity comes from
  // the selected ship when present; absent -> unconstrained. A stop the optimizer
  // couldn't sequence (no position) simply won't appear in this map.
  const capacity = options.ship?.scu ?? null;
  const { ordered } = optimizeRoute(missions, { capacity });
  const visitOrder = locationVisitOrder(ordered);

  // Map dropoffGroups -> overlay stops, then order by the optimizer's visit
  // number. Stops with no visit number (position-less, never sequenced) sort to
  // the end while preserving dropoffGroups' own relative order (active-first,
  // remaining desc). The sort is STABLE in V8 for the in-order ties, so the
  // upstream ordering is preserved within each tier.
  const stops: NextStop[] = groups.map((g) => ({
    location: g.location,
    lines: g.todo
      .map((c) => ({ commodity: c.commodity, scuRemaining: c.scuRemaining }))
      .sort((a, b) => b.scuRemaining - a.scuRemaining),
    scuRemaining: g.scuRemaining,
    isCurrentLocation: g.isCurrentLocation,
    needsLocation: g.needsLocation,
  }));

  const orderKey = (s: NextStop): number =>
    visitOrder.get(s.location) ?? Number.POSITIVE_INFINITY;

  // Decorate with original index so the fallback (un-sequenced) tier is stable.
  return {
    stops: stops
      .map((s, i) => ({ s, i }))
      .sort((a, b) => orderKey(a.s) - orderKey(b.s) || a.i - b.i)
      .map(({ s }) => s),
  };
}
