// ============================================================================
// ocrAutoCorrelate.ts — PURE correlation reducer for Auto OCR Capture (Phase 3)
// ----------------------------------------------------------------------------
// The accept event that triggers an auto-capture fires BEFORE the mission's
// CreateMarker placeholder legs exist in the live list (the leg-arrival race).
// Applying the OCR result immediately could therefore either miss the mission
// entirely or, worse, race the markers and produce duplicate legs. This module
// owns the timing/correlation policy as a PURE function so it is fully unit-
// testable without Electron, the DOM, or the IPC bridge.
//
// MODEL: each auto-capture produces a `PendingApply` — the OCR'd objectives plus
// the accept identity (missionId/title/ts) and bookkeeping (when it arrived,
// whether it has been applied at least once). On every `missions:changed` tick
// (and on a timer), the host calls `reconcilePending(pending, missions, now)`,
// which returns:
//   - apply[]   : entries to (re)apply now, each resolved to a concrete
//                 missionId. applyOcr is idempotent, so re-applying within the
//                 TTL is safe and lets late-arriving markers get reconciled.
//   - keep[]    : entries to retain (updated bookkeeping) — still within TTL.
//   - expired[] : entries to drop (past TTL) — applied or not.
//
// RESOLUTION ORDER (per pending entry):
//   1. DIRECT — the pending missionId is present in the live list. This is the
//      common, authoritative case (the capture was triggered by that mission).
//   2. FALLBACK (time+name) — the missionId isn't present yet, but a mission
//      whose title equals the pending title accepted within a small window
//      exists. Picks the SOONEST such mission (closest accept time). Guards the
//      rare case where the id we were handed never lands (a parser hiccup) but
//      an equivalent mission clearly did.
//
// GATING (when do we actually apply a resolved entry?):
//   - If the resolved mission already HAS legs -> apply immediately (the markers
//     landed; we can fill placeholders in place).
//   - Else if the SETTLE debounce has elapsed since the entry arrived -> apply
//     anyway (the markers may have been log-suppressed; applyOcr will insert).
//   - Else -> keep waiting (avoid racing the markers into duplicate legs).
//   After the first apply, RE-APPLY on every subsequent tick within the TTL so
//   markers that arrive late still get reconciled (idempotent merge).
// ============================================================================

import type { Mission } from "@shared/types";
import type { OcrApplyObjective } from "@shared/types";

/** Default timing knobs (ms). Exposed so the host + tests share one source. */
export const AUTO_OCR_DEFAULTS = {
  /**
   * How long to wait for a resolved-but-legless mission before applying anyway
   * (the markers may be log-suppressed). Short — the markers usually arrive in
   * well under this once the mission appears.
   */
  settleMs: 3_000,
  /**
   * How long a pending entry lives. We re-apply (idempotent) on every tick
   * within this window so late markers get reconciled, then drop the entry.
   */
  ttlMs: 60_000,
  /**
   * The time+name fallback only matches a mission whose accept time is within
   * this window of the pending entry's accept ts (either direction). Keeps a
   * generic title (e.g. two "… Cargo Haul" accepts minutes apart) from cross-
   * matching the wrong mission.
   */
  fallbackWindowMs: 30_000,
} as const;

/** A queued auto-capture awaiting correlation + apply. */
export interface PendingApply {
  /** The accept event's missionId (the direct-correlation key). */
  missionId: string;
  /** The accept event's contract title (the fallback correlation key). */
  title: string;
  /** Epoch ms of the accept event. */
  ts: number;
  /** The OCR'd + reviewed objectives to merge via applyOcr. */
  objectives: OcrApplyObjective[];
  /** Epoch ms when this entry was enqueued (drives settle + TTL). */
  enqueuedAt: number;
  /** True once we've applied this entry at least once (enables re-apply). */
  appliedOnce: boolean;
  /**
   * Host-owned: true once the "review" cue has been surfaced for this entry, so
   * an idempotent re-apply (late markers) doesn't re-toast. The reducer carries
   * this field through untouched; it never reads or sets it.
   */
  cueShown?: boolean;
}

/** Tuning knobs for {@link reconcilePending} (defaults from AUTO_OCR_DEFAULTS). */
export interface ReconcileOptions {
  settleMs?: number;
  ttlMs?: number;
  fallbackWindowMs?: number;
}

/** One resolved apply instruction: which mission gets which objectives. */
export interface ApplyInstruction {
  /** The CONCRETE mission id to apply to (resolved direct or via fallback). */
  missionId: string;
  /** The objectives to merge (idempotent applyOcr). */
  objectives: OcrApplyObjective[];
  /** The original pending entry (so the host can mark appliedOnce + keep it). */
  pending: PendingApply;
}

/** The reducer result for one reconcile tick. */
export interface ReconcileResult {
  /** Entries to (re)apply now, each resolved to a concrete missionId. */
  apply: ApplyInstruction[];
  /** Entries to retain for the next tick (bookkeeping already updated). */
  keep: PendingApply[];
  /** Entries to drop — past TTL. */
  expired: PendingApply[];
}

/** True when a mission has at least one leg (the markers have landed). */
function hasLegs(mission: Mission): boolean {
  return Array.isArray(mission.legs) && mission.legs.length > 0;
}

/**
 * Resolve a pending entry to a concrete mission id, or null if no mission
 * matches yet. Direct missionId match wins; otherwise the time+name fallback
 * picks the soonest mission with an equal title whose accept ts is within the
 * window. Title comparison is case-insensitive + trimmed (OCR/log whitespace).
 */
export function resolvePending(
  pending: PendingApply,
  missions: Mission[],
  fallbackWindowMs: number,
): Mission | null {
  // 1. DIRECT — the authoritative case.
  const direct = missions.find((m) => m.id === pending.missionId);
  if (direct) return direct;

  // 2. FALLBACK — time + name. Same (normalized) title, accept ts within window.
  const wantTitle = normalizeTitle(pending.title);
  if (wantTitle.length === 0) return null;

  let best: Mission | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const m of missions) {
    if (normalizeTitle(m.title) !== wantTitle) continue;
    if (m.acceptedAt == null) continue;
    const delta = Math.abs(m.acceptedAt - pending.ts);
    if (delta > fallbackWindowMs) continue;
    if (delta < bestDelta) {
      best = m;
      bestDelta = delta;
    }
  }
  return best;
}

/** Lower-case + collapse-whitespace a title for tolerant comparison. */
function normalizeTitle(title: unknown): string {
  if (typeof title !== "string") return "";
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Reduce the pending queue against the current mission list at time `now`.
 * Pure + total — no side effects, no Electron. The host applies the returned
 * instructions (via window.api.applyOcr), then replaces its pending state with
 * the returned `keep` list (each apply instruction's `pending` is already
 * included in `keep`, with appliedOnce stamped true).
 */
export function reconcilePending(
  pending: PendingApply[],
  missions: Mission[],
  now: number,
  options: ReconcileOptions = {},
): ReconcileResult {
  const settleMs = options.settleMs ?? AUTO_OCR_DEFAULTS.settleMs;
  const ttlMs = options.ttlMs ?? AUTO_OCR_DEFAULTS.ttlMs;
  const fallbackWindowMs =
    options.fallbackWindowMs ?? AUTO_OCR_DEFAULTS.fallbackWindowMs;

  const apply: ApplyInstruction[] = [];
  const keep: PendingApply[] = [];
  const expired: PendingApply[] = [];

  for (const entry of pending) {
    // TTL — drop once the window has fully elapsed (applied or not).
    if (now - entry.enqueuedAt >= ttlMs) {
      expired.push(entry);
      continue;
    }

    const mission = resolvePending(entry, missions, fallbackWindowMs);
    if (!mission) {
      // Not correlatable yet (mission not in the list). Wait — still in TTL.
      keep.push(entry);
      continue;
    }

    // Gate: apply when the mission has legs, OR the settle debounce has elapsed,
    // OR we've already applied once (re-apply to reconcile late markers).
    const settled = now - entry.enqueuedAt >= settleMs;
    const shouldApply = entry.appliedOnce || hasLegs(mission) || settled;

    if (shouldApply) {
      const stamped: PendingApply = { ...entry, appliedOnce: true };
      apply.push({
        missionId: mission.id,
        objectives: entry.objectives,
        pending: stamped,
      });
      keep.push(stamped);
    } else {
      // Correlated but not yet settled and legless — hold to avoid racing the
      // markers into duplicate legs.
      keep.push(entry);
    }
  }

  return { apply, keep, expired };
}
