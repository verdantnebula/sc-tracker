// ============================================================================
// ocrAutoCorrelate.ts — PURE correlation reducer for Auto OCR Capture (Phase 3)
// ----------------------------------------------------------------------------
// REVIEW-FIRST (the Phase-3 rework): an auto-capture on cargo-accept NEVER writes
// to a mission. Its outcome is to SURFACE the OCR result for human review (the
// pre-filled OcrCaptureDialog), pre-targeting the correlated mission ONLY when we
// are confident — so the user reviews-and-Applies, never a silent write.
//
// The accept event that triggers an auto-capture fires BEFORE the mission's
// CreateMarker placeholder legs exist in the live list (the leg-arrival race).
// We still own that timing here, as a PURE function (no Electron/DOM/IPC), so it
// is fully unit-testable.
//
// MODEL: each auto-capture produces a `PendingApply` — the OCR'd objectives plus
// the accept identity (missionId/title/ts) and bookkeeping (when it arrived,
// whether it has been surfaced for review yet). On every `missions:changed` tick
// (and on a timer), the host calls `reconcilePending(pending, missions, now)`,
// which returns:
//   - review[]  : entries ready to OPEN for review now, each carrying a
//                 `preselectMissionId` (a CONFIDENT direct correlation) or null
//                 (uncertain / uncorrelated — the user picks the mission).
//   - keep[]    : entries to retain (updated bookkeeping) — still within TTL.
//   - expired[] : entries to drop (past TTL) — surfaced or not.
//
// CONFIDENT CORRELATION (drives preselect):
//   DIRECT — the pending missionId is present in the live list. This is the
//   authoritative case (the capture was triggered by that mission) and the ONLY
//   case we pre-target. A time+name FALLBACK match is good enough to know the
//   capture is "ready" but NOT confident enough to pre-select a target, so it
//   surfaces with an empty dropdown (never guess a target).
//
// READY-TO-SURFACE GATING (when do we open the review for an entry?):
//   - If a CONFIDENT (direct) correlation exists -> ready immediately (one-click
//     review-and-apply for the user).
//   - Else if the SETTLE debounce has elapsed since the entry arrived -> ready
//     anyway, surfaced with an empty target (markers may be log-suppressed, or
//     the id we were handed never landed — the user picks).
//   - Else -> keep waiting (give the mission a moment to appear so we can
//     pre-target it instead of surfacing an empty dropdown).
//   Each entry surfaces ONCE (reviewedOnce) — review is a one-shot human action,
//   not an idempotent re-apply. After surfacing we keep it (within TTL) only so a
//   duplicate live re-emit of the same accept doesn't re-open a second review.
// ============================================================================

import type { Mission } from "@shared/types";
import type { OcrApplyObjective } from "@shared/types";

/** Default timing knobs (ms). Exposed so the host + tests share one source. */
export const AUTO_OCR_DEFAULTS = {
  /**
   * How long to wait for a mission to appear (so we can pre-target it) before
   * surfacing the review anyway with an empty target. Short — the mission/markers
   * usually arrive in well under this once the accept lands.
   */
  settleMs: 3_000,
  /**
   * How long a pending entry lives. Once surfaced we keep it within this window
   * (so a duplicate live re-emit of the same accept doesn't re-open a review),
   * then drop the entry.
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

/** A queued auto-capture awaiting correlation + review. */
export interface PendingApply {
  /** The accept event's missionId (the direct-correlation key). */
  missionId: string;
  /** The accept event's contract title (the fallback correlation key). */
  title: string;
  /** Epoch ms of the accept event. */
  ts: number;
  /** The OCR'd + reviewed objectives to merge via applyOcr (after human review). */
  objectives: OcrApplyObjective[];
  /** Epoch ms when this entry was enqueued (drives settle + TTL). */
  enqueuedAt: number;
  /** True once we've surfaced this entry for review (prevents re-opening). */
  reviewedOnce: boolean;
}

/** Tuning knobs for {@link reconcilePending} (defaults from AUTO_OCR_DEFAULTS). */
export interface ReconcileOptions {
  settleMs?: number;
  ttlMs?: number;
  fallbackWindowMs?: number;
}

/** One resolved review instruction: which capture to surface, pre-targeting where confident. */
export interface ReviewInstruction {
  /**
   * The mission id to PRE-SELECT in the review dropdown — only set on a CONFIDENT
   * direct correlation. null when the correlation was a (less-certain) time+name
   * fallback or absent: the review opens with an empty target for the user.
   */
  preselectMissionId: string | null;
  /** The objectives to surface for review (then merged via applyOcr on Apply). */
  objectives: OcrApplyObjective[];
  /** The original pending entry (so the host can mark reviewedOnce + keep it). */
  pending: PendingApply;
}

/** The reducer result for one reconcile tick. */
export interface ReconcileResult {
  /** Entries to OPEN for review now (each with an optional confident pre-target). */
  review: ReviewInstruction[];
  /** Entries to retain for the next tick (bookkeeping already updated). */
  keep: PendingApply[];
  /** Entries to drop — past TTL. */
  expired: PendingApply[];
  /**
   * Entries that were READY this tick but held back because a review dialog is
   * already open (`reviewOpen`). They remain unstamped in `keep` and will surface
   * on a later reconcile after the dialog closes. The host uses this to show the
   * "review waiting" badge. Empty when `reviewOpen` is false.
   */
  deferred: PendingApply[];
}

/**
 * Resolve a pending entry to a CONFIDENT (direct) mission match, or null. Only a
 * direct missionId match counts as confident enough to pre-target the review.
 */
export function resolveConfident(
  pending: PendingApply,
  missions: Mission[],
): Mission | null {
  return missions.find((m) => m.id === pending.missionId) ?? null;
}

/**
 * Resolve a pending entry to a concrete mission, or null if none matches yet.
 * Direct missionId match wins (confident); otherwise the time+name fallback picks
 * the soonest mission with an equal title whose accept ts is within the window.
 * Used to decide READINESS (a fallback match still means the mission exists, so we
 * can surface); the CONFIDENT pre-target is computed separately via
 * {@link resolveConfident}. Title comparison is case-insensitive + trimmed.
 */
export function resolvePending(
  pending: PendingApply,
  missions: Mission[],
  fallbackWindowMs: number,
): Mission | null {
  // 1. DIRECT — the authoritative, confident case.
  const direct = resolveConfident(pending, missions);
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
 * Pure + total — no side effects, no Electron.
 *
 * DEFER-AWARE: `reviewOpen` tells the reducer a review dialog is already open. The
 * host shows ONE review at a time, so when `reviewOpen` is true we must NOT surface
 * a ready entry — and, critically, must NOT stamp it `reviewedOnce`. A ready entry
 * is instead kept UNSTAMPED in `keep[]` (TTL/settle still advance) so a later
 * reconcile with `reviewOpen=false` (after the open dialog closes) surfaces it
 * exactly once. Only entries actually returned in `review[]` get `reviewedOnce`
 * stamped. (Previously the host stamped on the deferred tick, so the next tick
 * routed the entry straight to keep via the reviewedOnce short-circuit and it was
 * never surfaced — a lost entry.)
 *
 * The host opens a review for each returned instruction (when none is open), then
 * replaces its pending state with the returned `keep` list (each surfaced
 * instruction's `pending` is included in `keep`, with reviewedOnce stamped true).
 */
export function reconcilePending(
  pending: PendingApply[],
  missions: Mission[],
  now: number,
  reviewOpen = false,
  options: ReconcileOptions = {},
): ReconcileResult {
  const settleMs = options.settleMs ?? AUTO_OCR_DEFAULTS.settleMs;
  const ttlMs = options.ttlMs ?? AUTO_OCR_DEFAULTS.ttlMs;
  const fallbackWindowMs =
    options.fallbackWindowMs ?? AUTO_OCR_DEFAULTS.fallbackWindowMs;

  const review: ReviewInstruction[] = [];
  const keep: PendingApply[] = [];
  const expired: PendingApply[] = [];
  const deferred: PendingApply[] = [];

  for (const entry of pending) {
    // TTL — drop once the window has fully elapsed (surfaced or not).
    if (now - entry.enqueuedAt >= ttlMs) {
      expired.push(entry);
      continue;
    }

    // Already surfaced: keep it within TTL so a duplicate live re-emit of the same
    // accept doesn't re-open a second review. Never surface twice.
    if (entry.reviewedOnce) {
      keep.push(entry);
      continue;
    }

    // CONFIDENT direct correlation drives the pre-target (and makes us ready now).
    const confident = resolveConfident(entry, missions);
    // Any correlation (direct OR fallback) tells us the mission exists -> ready.
    const correlated =
      confident ?? resolvePending(entry, missions, fallbackWindowMs);
    const settled = now - entry.enqueuedAt >= settleMs;

    // Ready when correlated (we can pre-target where confident) OR the settle
    // debounce elapsed (surface anyway so a log-suppressed / un-id'd mission
    // still gets a review — the user picks the target).
    const ready = correlated !== null || settled;

    if (ready && reviewOpen) {
      // DEFER: a dialog is already open, so we can't surface now. Keep the entry
      // READY but UNSTAMPED so a later reconcile (after the dialog closes) surfaces
      // it exactly once — never stamp reviewedOnce on the deferred branch (that's
      // what lost the entry before). Report it so the host can show the badge.
      keep.push(entry);
      deferred.push(entry);
    } else if (ready) {
      const stamped: PendingApply = { ...entry, reviewedOnce: true };
      review.push({
        // Pre-target ONLY on a confident direct match; otherwise empty.
        preselectMissionId: confident ? confident.id : null,
        objectives: entry.objectives,
        pending: stamped,
      });
      keep.push(stamped);
    } else {
      // Not correlated yet and pre-settle — wait, so we can pre-target the
      // mission once it appears instead of surfacing an empty dropdown.
      keep.push(entry);
    }
  }

  return { review, keep, expired, deferred };
}
