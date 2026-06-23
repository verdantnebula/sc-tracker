// ============================================================================
// selectors.ts — pure derivations from the shared Mission model to view models.
// ----------------------------------------------------------------------------
// Mirrors the prototype's renderVals() math, but over the RICHER shared types
// (Leg has scuTotal/scuDelivered/completed, not a single `scu`+`done`). No
// component computes aggregation itself — they consume these.
// ============================================================================

import type {
  Mission,
  MissionStatus,
  PayoutConfidence,
  DropoffGroup,
  DropoffCommodity,
  Totals,
  MissionTotals,
  LogPathInfo,
  LogStatus,
} from "@shared/types";
import { isConfidentLocationMatch } from "@shared/location";

export const fmt = (n: number): string => (n || 0).toLocaleString("en-US");

/**
 * Placeholder location for dropoff legs the game log never gave a destination
 * (leg.location == null). Exported so the By-Dropoff UI can detect this bucket
 * via the `DropoffGroup.needsLocation` flag (preferred) or this constant, rather
 * than hard-coding the magic string in multiple places. The string still serves
 * as the group's `location` key (and visible fallback) inside dropoffGroups.
 */
export const UNKNOWN_DESTINATION = "Unknown destination";

// ---------------------------------------------------------------------------
// Log-missing banner predicate. The warning strip shows when the resolved
// Game.log can't be found, so a user with a non-standard install (or a mis-set
// custom folder) immediately understands why the app is empty and how to fix it.
//
// Truth source is `logPathInfo.gameLogExists` (the on-disk check). We also treat
// an explicitly `disconnected` watcher as "missing" so a log that vanished after
// startup surfaces too. While we're still resolving (logPathInfo === null, or the
// watcher is `searching`), we DON'T show the banner — that's the transient boot
// state, not a confirmed failure, and flashing the banner on every launch is jarring.
// ---------------------------------------------------------------------------
export function shouldShowLogBanner(
  logPathInfo: LogPathInfo | null,
  logStatus: LogStatus | null,
): boolean {
  // Not resolved yet -> stay quiet (boot/searching state).
  if (logPathInfo == null) return false;
  if (logPathInfo.gameLogExists === false) return true;
  // gameLogExists is true but the watcher reports a hard disconnect -> the file
  // we resolved is no longer being read; still worth surfacing.
  if (logStatus?.state === "disconnected") return true;
  return false;
}

// Active = still being worked. Terminal = complete/abandoned (History view).
export const ACTIVE_STATUSES: MissionStatus[] = ["accepted", "in_progress"];
export const TERMINAL_STATUSES: MissionStatus[] = ["complete", "abandoned"];

export const isActive = (m: Mission): boolean =>
  ACTIVE_STATUSES.includes(m.status);
export const isTerminal = (m: Mission): boolean =>
  TERMINAL_STATUSES.includes(m.status);

/**
 * A leg is "incomplete" (needs the user to fill it in) when the game's log
 * suppressed its objectiveDeclared line: no destination, or no SCU amount. Only
 * dropoff legs count — pickups don't feed the by-dropoff unload view, so a blank
 * pickup isn't actionable for this flow.
 */
export const isLegIncomplete = (l: Mission["legs"][number]): boolean =>
  l.kind === "dropoff" && (l.location == null || l.scuTotal === 0);

/**
 * A mission needs manual completion when it has any token-suppressed dropoff leg
 * (missing location or SCU). Drives the "⚠ Details missing" indicator on the
 * Mission List card + detail panel.
 */
export const isMissionIncomplete = (m: Mission): boolean =>
  m.legs.some(isLegIncomplete);

/**
 * Choose the apply-target mission to preselect in the OCR capture dialog. Honors
 * an explicit caller choice (`initialMissionId`) when it still exists; otherwise
 * auto-selects the mission that NEEDS OCR — the most-recent "details missing"
 * mission (a log-suppressed dropoff leg). `missions` is expected newest-first
 * (the active list is ordered created_seq DESC), so the first incomplete one is
 * the freshest. Falls back to the first mission; null only when the list empty.
 *
 * PURE — string/array in, id out — so the dialog can default the dropdown to the
 * mission the user most likely opened the dialog for, while still letting them
 * change it.
 */
export function pickDefaultTarget(
  missions: Mission[],
  initialMissionId: string | null | undefined,
): string | null {
  if (initialMissionId && missions.some((m) => m.id === initialMissionId)) {
    return initialMissionId;
  }
  const incomplete = missions.find(isMissionIncomplete);
  if (incomplete) return incomplete.id;
  return missions[0]?.id ?? null;
}

/** Remaining SCU for a leg (0 when completed). */
const legRemaining = (
  scuTotal: number,
  scuDelivered: number,
  completed: boolean,
): number => (completed ? 0 : Math.max(0, scuTotal - scuDelivered));

/** Per-mission totals (dropoff legs only — pickups are not "remaining to unload"). */
export function missionTotals(m: Mission): MissionTotals {
  const drops = m.legs.filter((l) => l.kind === "dropoff");
  const legsTotal = drops.length;
  const legsDone = drops.filter((l) => l.completed).length;
  const scuTotal = drops.reduce((a, l) => a + l.scuTotal, 0);
  const scuRemaining = drops.reduce(
    (a, l) => a + legRemaining(l.scuTotal, l.scuDelivered, l.completed),
    0,
  );
  const pctDelivered = legsTotal ? Math.round((legsDone / legsTotal) * 100) : 0;
  return {
    missionId: m.id,
    scuRemaining,
    scuTotal,
    legsDone,
    legsTotal,
    pctDelivered,
  };
}

/**
 * By-Dropoff aggregation across ACTIVE missions only. Groups dropoff legs by
 * location, sums each distinct commodity (todo + delivered), computes remaining/
 * % delivered, flags all-done + current location. Sorted: active first, then by
 * remaining SCU desc; cleared stops sink to the end.
 */
export function dropoffGroups(
  missions: Mission[],
  currentLocation: string | null,
): DropoffGroup[] {
  type Acc = {
    location: string;
    todo: Map<
      string,
      { scu: number; refs: { missionId: string; legId: string }[] }
    >;
    delivered: Map<string, number>;
    scuRemaining: number;
    scuDelivered: number;
  };
  const groups = new Map<string, Acc>();

  for (const m of missions) {
    if (!isActive(m)) continue;
    for (const l of m.legs) {
      if (l.kind !== "dropoff") continue;
      const loc = l.location ?? UNKNOWN_DESTINATION;
      let g = groups.get(loc);
      if (!g) {
        g = {
          location: loc,
          todo: new Map(),
          delivered: new Map(),
          scuRemaining: 0,
          scuDelivered: 0,
        };
        groups.set(loc, g);
      }
      if (l.completed) {
        g.delivered.set(
          l.commodity,
          (g.delivered.get(l.commodity) ?? 0) + l.scuTotal,
        );
        g.scuDelivered += l.scuTotal;
      } else {
        const rem = legRemaining(l.scuTotal, l.scuDelivered, l.completed);
        const cur = g.todo.get(l.commodity) ?? { scu: 0, refs: [] };
        cur.scu += rem;
        cur.refs.push({ missionId: m.id, legId: l.id });
        g.todo.set(l.commodity, cur);
        g.scuRemaining += rem;
        g.scuDelivered += l.scuDelivered;
      }
    }
  }

  const out: DropoffGroup[] = Array.from(groups.values()).map((g) => {
    const todo: DropoffCommodity[] = Array.from(g.todo.entries()).map(
      ([commodity, v]) => ({
        commodity,
        scuRemaining: v.scu,
        scuDelivered: 0,
        legRefs: v.refs,
      }),
    );
    const delivered: DropoffCommodity[] = Array.from(g.delivered.entries()).map(
      ([commodity, scu]) => ({
        commodity,
        scuRemaining: 0,
        scuDelivered: scu,
        legRefs: [],
      }),
    );
    const scuTotal = g.scuRemaining + g.scuDelivered;
    const pctDelivered = scuTotal
      ? Math.round((g.scuDelivered / scuTotal) * 100)
      : 0;
    const needsLocation = g.location === UNKNOWN_DESTINATION;
    const allDone = todo.length === 0;
    return {
      location: g.location,
      todo,
      delivered,
      scuRemaining: g.scuRemaining,
      scuTotal,
      pctDelivered,
      allDone,
      // Only highlight on a CONFIDENT match (exact or strong substring). The
      // humanized terminal id frequently won't match a dropoff display name —
      // that's fine; we simply don't highlight rather than false-positive.
      isCurrentLocation: isConfidentLocationMatch(currentLocation, g.location),
      needsLocation,
    };
  });

  // The needs-location ("Set destination") bucket is an ACTION prompt — it must
  // only exist when there is at least one UNDELIVERED dropoff leg that actually
  // needs a destination. A completed null-location leg (a suppressed delivery the
  // user checked off without ever assigning a destination) leaves its bucket with
  // an empty `todo` while `allDone`+`needsLocation` are both true, which would
  // render as a nonsensical already-CLEARED "Set destination" card. Drop that
  // bucket here. Real, named stops that are fully delivered are unaffected (only
  // the needs-location group with empty todo is dropped) and still show as
  // "CLEARED" when delivered-shown is on.
  const filtered = out.filter((g) => !(g.needsLocation && g.todo.length === 0));

  filtered.sort(
    (a, b) =>
      // Cleared stops sink to the bottom; otherwise the "needs a destination"
      // action bucket floats to the very top (its SCU is usually suppressed to
      // 0, so it would otherwise sink — but it's the most actionable group),
      // then the rest by remaining SCU desc.
      Number(a.allDone) - Number(b.allDone) ||
      Number(b.needsLocation) - Number(a.needsLocation) ||
      b.scuRemaining - a.scuRemaining,
  );
  return filtered;
}

// ---------------------------------------------------------------------------
// Route view selectors (cargo only). The ROUTE tab presents the SAME active-
// mission data two ways: a pickup/dropoff LIST and a node+arrow MAP. Both are
// pure derivations over the active set — no new persisted state.
// ---------------------------------------------------------------------------

/**
 * Placeholder location for legs the game log never gave a source/destination
 * (leg.location == null) — the pickup mirror of UNKNOWN_DESTINATION. Used as the
 * group key + visible fallback for pickup legs in pickupGroups.
 */
export const UNKNOWN_PICKUP = "Unknown pickup";

/**
 * By-Pickup aggregation across ACTIVE missions only — the exact mirror of
 * dropoffGroups but for `kind === 'pickup'` legs. Groups pickup legs by source
 * location, sums each distinct commodity (todo + collected), computes remaining/
 * % collected, flags all-done + current location. Returns the same DropoffGroup
 * shape so the route LIST column can reuse the dropoff card rendering verbatim.
 *
 * The "completed" notion for a pickup is "collected" (cargo loaded). Same as
 * dropoffGroups, the synthetic needs-location bucket is dropped when its todo is
 * empty (a collected null-location pickup must not render an empty action card).
 */
export function pickupGroups(
  missions: Mission[],
  currentLocation: string | null,
): DropoffGroup[] {
  type Acc = {
    location: string;
    todo: Map<
      string,
      { scu: number; refs: { missionId: string; legId: string }[] }
    >;
    delivered: Map<string, number>;
    scuRemaining: number;
    scuDelivered: number;
  };
  const groups = new Map<string, Acc>();

  for (const m of missions) {
    if (!isActive(m)) continue;
    for (const l of m.legs) {
      if (l.kind !== "pickup") continue;
      const loc = l.location ?? UNKNOWN_PICKUP;
      let g = groups.get(loc);
      if (!g) {
        g = {
          location: loc,
          todo: new Map(),
          delivered: new Map(),
          scuRemaining: 0,
          scuDelivered: 0,
        };
        groups.set(loc, g);
      }
      if (l.completed) {
        g.delivered.set(
          l.commodity,
          (g.delivered.get(l.commodity) ?? 0) + l.scuTotal,
        );
        g.scuDelivered += l.scuTotal;
      } else {
        const rem = legRemaining(l.scuTotal, l.scuDelivered, l.completed);
        const cur = g.todo.get(l.commodity) ?? { scu: 0, refs: [] };
        cur.scu += rem;
        cur.refs.push({ missionId: m.id, legId: l.id });
        g.todo.set(l.commodity, cur);
        g.scuRemaining += rem;
        g.scuDelivered += l.scuDelivered;
      }
    }
  }

  const out: DropoffGroup[] = Array.from(groups.values()).map((g) => {
    const todo: DropoffCommodity[] = Array.from(g.todo.entries()).map(
      ([commodity, v]) => ({
        commodity,
        scuRemaining: v.scu,
        scuDelivered: 0,
        legRefs: v.refs,
      }),
    );
    const delivered: DropoffCommodity[] = Array.from(g.delivered.entries()).map(
      ([commodity, scu]) => ({
        commodity,
        scuRemaining: 0,
        scuDelivered: scu,
        legRefs: [],
      }),
    );
    const scuTotal = g.scuRemaining + g.scuDelivered;
    const pctDelivered = scuTotal
      ? Math.round((g.scuDelivered / scuTotal) * 100)
      : 0;
    const needsLocation = g.location === UNKNOWN_PICKUP;
    const allDone = todo.length === 0;
    return {
      location: g.location,
      todo,
      delivered,
      scuRemaining: g.scuRemaining,
      scuTotal,
      pctDelivered,
      allDone,
      isCurrentLocation: isConfidentLocationMatch(currentLocation, g.location),
      needsLocation,
    };
  });

  // Mirror dropoffGroups: drop the empty needs-location bucket (a collected
  // null-location pickup would otherwise render as a nonsensical CLEARED card).
  const filtered = out.filter((g) => !(g.needsLocation && g.todo.length === 0));

  filtered.sort(
    (a, b) =>
      Number(a.allDone) - Number(b.allDone) ||
      Number(b.needsLocation) - Number(a.needsLocation) ||
      b.scuRemaining - a.scuRemaining,
  );
  return filtered;
}

/** A single haul movement (pickup location -> dropoff location) for the map. */
export interface RouteEdge {
  /** Stable id: `${missionId}:${pickupLegId}->${dropoffLegId}`. */
  id: string;
  /** Source (pickup) location label — sentinel "Unknown" when not known. */
  fromLocation: string;
  /** Destination (dropoff) location label — sentinel "Unknown" when not known. */
  toLocation: string;
  /** Commodity moving along this edge (best-effort match). */
  commodity: string;
  /** SCU on this edge (the dropoff leg's total). */
  scu: number;
  /** True when the pickup location is known (not null). */
  fromKnown: boolean;
  /** True when the dropoff location is known (not null). */
  toKnown: boolean;
  /** True when both legs are complete -> the map can de-emphasize the edge. */
  done: boolean;
}

/** Sentinel label for a leg whose location the log never reported. */
export const UNKNOWN_ROUTE_NODE = "Unknown";

/**
 * Build directed haul edges (pickup -> dropoff) for every ACTIVE mission.
 *
 * Pairing strategy per mission:
 *  - A_TO_B (1 pickup + 1 dropoff): one edge.
 *  - SINGLE_TO_MULTI (1 pickup + N dropoffs): N edges sharing the pickup, SCU
 *    taken from each dropoff.
 *  - MULTI_TO_SINGLE (N pickups + 1 dropoff): N edges sharing the dropoff.
 *  - General N×M: match each dropoff to a pickup by commodity first (consuming
 *    the matched pickup), else fall back to the next pickup in order, else reuse
 *    the first pickup (so the dropoff still has a source node). The driving side
 *    is the dropoff set (that's the SCU + destination that matters for hauling).
 *
 * Null locations become the UNKNOWN_ROUTE_NODE sentinel with fromKnown/toKnown
 * = false (the node is still drawn, labeled "Unknown"). Fully-delivered edges
 * are flagged `done` (included, not skipped — the map dims them).
 */
export function routeEdges(missions: Mission[]): RouteEdge[] {
  const edges: RouteEdge[] = [];

  for (const m of missions) {
    if (!isActive(m)) continue;
    const pickups = m.legs.filter((l) => l.kind === "pickup");
    const dropoffs = m.legs.filter((l) => l.kind === "dropoff");
    if (dropoffs.length === 0) continue;

    // Track which pickups have been consumed by a commodity match so a multi-
    // pickup mission distributes its sources rather than always reusing #0.
    const used = new Set<string>();
    let orderCursor = 0;

    for (const d of dropoffs) {
      let pk = null as (typeof pickups)[number] | null;

      if (pickups.length > 0) {
        // 1) commodity match (prefer an unused pickup of the same commodity).
        pk =
          pickups.find(
            (p) =>
              !used.has(p.id) && p.commodity && p.commodity === d.commodity,
          ) ?? null;
        // 2) next unused pickup in order.
        if (!pk) {
          while (
            orderCursor < pickups.length &&
            used.has(pickups[orderCursor].id)
          )
            orderCursor++;
          pk = orderCursor < pickups.length ? pickups[orderCursor] : null;
        }
        // 3) fall back to the first pickup (shared source) if all consumed.
        if (!pk) pk = pickups[0];
        if (pk) {
          used.add(pk.id);
          if (pk.id === pickups[orderCursor]?.id) orderCursor++;
        }
      }

      const fromKnown = pk?.location != null;
      const toKnown = d.location != null;
      edges.push({
        id: `${m.id}:${pk?.id ?? "none"}->${d.id}`,
        fromLocation: pk?.location ?? UNKNOWN_ROUTE_NODE,
        toLocation: d.location ?? UNKNOWN_ROUTE_NODE,
        commodity: d.commodity || pk?.commodity || "",
        scu: d.scuTotal,
        fromKnown,
        toKnown,
        done: (pk ? pk.completed : true) && d.completed,
      });
    }
  }

  return edges;
}

/** Distinct stop count across edges (union of from + to locations). */
export const routeStopCount = (edges: RouteEdge[]): number => {
  const stops = new Set<string>();
  for (const e of edges) {
    stops.add(e.fromLocation);
    stops.add(e.toLocation);
  }
  return stops.size;
};

export const grandTotalRemaining = (groups: DropoffGroup[]): number =>
  groups.reduce((a, g) => a + (g.allDone ? 0 : g.scuRemaining), 0);

export const activeStopCount = (groups: DropoffGroup[]): number =>
  groups.filter((g) => !g.allDone).length;

/** Lifetime totals for the History header (completed missions; log-reported/approx). */
export function lifetimeTotals(missions: Mission[]): Totals {
  const completed = missions.filter((m) => m.status === "complete");
  const missionsCompleted = completed.length;
  const scuHauled = completed.reduce(
    (a, m) =>
      a +
      m.legs
        .filter((l) => l.kind === "dropoff")
        .reduce((s, l) => s + l.scuTotal, 0),
    0,
  );
  const creditsEarned = completed.reduce((a, m) => a + (m.payout ?? 0), 0);
  return { missionsCompleted, scuHauled, creditsEarned, finesTotal: 0 };
}

// ---------------------------------------------------------------------------
// Status badge metadata (incl. the SPEC §10 4th state Abandoned).
// ---------------------------------------------------------------------------
export interface StatusMeta {
  label: string;
  color: string;
  bg: string;
}
export const STATUS_META: Record<MissionStatus, StatusMeta> = {
  accepted: {
    label: "ACCEPTED",
    color: "var(--status-accepted)",
    bg: "var(--status-accepted-bg)",
  },
  in_progress: {
    label: "IN PROGRESS",
    color: "var(--status-progress)",
    bg: "var(--status-progress-bg)",
  },
  complete: {
    label: "COMPLETE",
    color: "var(--status-complete)",
    bg: "var(--status-complete-bg)",
  },
  abandoned: {
    label: "ABANDONED",
    color: "var(--status-abandoned)",
    bg: "var(--status-abandoned-bg)",
  },
};

// ---------------------------------------------------------------------------
// Payout confidence cue (SPEC §10 delta 3): exact when confirmed, ~ when
// approximate, — when unknown. Currency label is aUEC (not the prototype's ¤).
// ---------------------------------------------------------------------------
export function payoutDisplay(
  payout: number | null,
  confidence: PayoutConfidence,
): string {
  if (payout == null || confidence === "unknown") return "—";
  const value = fmt(payout);
  return confidence === "approximate" ? `~${value} aUEC` : `${value} aUEC`;
}

// Human-readable variant/grade for cards (shared enums -> prototype-style labels).
const VARIANT_LABEL: Record<string, string> = {
  A_TO_B: "A → B",
  MULTI_TO_SINGLE: "Multi → Single",
  SINGLE_TO_MULTI: "Single → Multi",
  MANUAL: "Manual Entry",
};
const GRADE_LABEL: Record<string, string> = {
  SMALL: "Small",
  SUPPLY: "Supply Grade",
  BULK: "Bulk",
  UNKNOWN: "—",
};
export const variantLabel = (v: string): string => VARIANT_LABEL[v] ?? v;
export const gradeLabel = (g: string): string => GRADE_LABEL[g] ?? g;
