// ============================================================================
// AutoOcrCapture — EXPERIMENTAL Auto OCR Capture host (Phase 3, REVIEW-FIRST)
// ----------------------------------------------------------------------------
// A headless host mounted in CargoApp (active in cargo mode) that listens for
// the OCR_AUTO_REQUEST push main broadcasts when a cargo contract is accepted
// while the feature is on. On a request it:
//   1. reads the OPTIONAL calibrated capture region (null is fine — calibration
//      only boosts accuracy, it is not required);
//   2. runs the shared runOcrPipeline() headless -> objectives[] (full-frame OCR
//      when no region is set); if zero objectives, silently discards (defensive —
//      never surface garbage);
//   3. enqueues a PendingApply and lets the pure ocrAutoCorrelate reducer decide
//      WHEN the capture is ready to SURFACE and WHETHER it can confidently pre-
//      target a mission (handling the leg-arrival race):
//        - surface once a confident (direct) mission correlation exists, or after
//          a settle debounce (un-id'd / log-suppressed missions still get a
//          review, with an empty target the user picks); drop after the TTL.
//   4. on "ready", calls onAutoReview() with the pre-filled OCR result so the
//      parent OPENS the OcrCaptureDialog in review state. NOTHING IS WRITTEN until
//      the user clicks Apply (the old silent applyOcr auto-path is GONE).
//
// DON'T CLOBBER AN OPEN REVIEW: when a review dialog is already open (`reviewOpen`,
// manual or a prior auto), we do NOT surface — the ready entry stays pending and
// a small "review waiting" badge shows; the next reconcile (after the open dialog
// closes) surfaces it. One review at a time; no elaborate queue UI.
//
// EVERYTHING is guarded: any throw is caught and ignored so the app never breaks.
// Session-transient only — no DB schema change.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import type { Mission, ReferenceData } from "@shared/types";
import { runOcrPipeline, type ReviewObjective } from "../lib/ocrPipeline";
import { reconcilePending, type PendingApply } from "../lib/ocrAutoCorrelate";
import type { OcrPrefill } from "./OcrCaptureDialog";

/** Map reviewed objectives to the applyOcr payload (drop blank locations). */
function toApplyObjectives(
  objectives: ReviewObjective[],
): PendingApply["objectives"] {
  return objectives.map((o) => ({
    kind: o.kind,
    commodity: o.commodity,
    scu: o.scu,
    location: o.location.length > 0 ? o.location : null,
  }));
}

/** How often the host re-runs the reconcile loop (settle/TTL progress) when no
 *  missions:changed event arrives. Cheap — the reducer is pure + O(pending). */
const TICK_MS = 1_000;

export function AutoOcrCapture({
  enabled,
  missions,
  reference,
  reviewOpen,
  captureDelayMs,
  onAutoReview,
}: {
  /** Whether Auto OCR Capture is enabled (host is inert when false). */
  enabled: boolean;
  /** Live active missions, for correlation (passed from CargoApp). */
  missions: Mission[];
  /** Bundled reference (fuzzy-match candidates for the pipeline). */
  reference: ReferenceData;
  /** True when a review dialog is already open — defer surfacing if so. */
  reviewOpen: boolean;
  /**
   * SETTLE DELAY (ms) to wait AFTER an OCR_AUTO_REQUEST before running the OCR
   * pipeline, so the mobiGlas contract screen can finish rendering (the trigger
   * log line can land before the screen has painted). Applies to the AUTO path
   * only. 0 -> capture immediately. Clamped upstream in settings to [0, 3000].
   */
  captureDelayMs: number;
  /** Open the review dialog pre-filled with this auto-capture OCR result. */
  onAutoReview: (prefill: OcrPrefill) => void;
}): React.JSX.Element | null {
  // Pending auto-captures awaiting correlation/surfacing. A ref is the source of
  // truth (so async request handlers + the tick loop see the latest without stale
  // closures). The OCR result for each is held alongside so we can build the
  // prefill when the reducer says the entry is ready to surface.
  const pendingRef = useRef<PendingApply[]>([]);
  // missionId -> the full pipeline result, so a ready entry can be turned into an
  // OcrPrefill (objectives + reward + confidence + rawText) at surface time.
  const resultsRef = useRef<Map<string, OcrPrefill>>(new Map());
  // Latest props mirrored to refs so the interval callback (set up once) always
  // reconciles against the current values without re-subscribing.
  const missionsRef = useRef<Mission[]>(missions);
  missionsRef.current = missions;
  const referenceRef = useRef<ReferenceData>(reference);
  referenceRef.current = reference;
  const reviewOpenRef = useRef<boolean>(reviewOpen);
  reviewOpenRef.current = reviewOpen;
  const captureDelayMsRef = useRef<number>(captureDelayMs);
  captureDelayMsRef.current = captureDelayMs;
  const onAutoReviewRef = useRef(onAutoReview);
  onAutoReviewRef.current = onAutoReview;

  // Pending SETTLE timers keyed by missionId. A timer fires the actual capture
  // after captureDelayMs. Kept so we can (a) clear ALL on unmount/disable — no
  // capture-after-unmount; and (b) SUPERSEDE a same-mission re-emit (the accept
  // log line can repeat) by clearing+rescheduling, never double-capturing.
  const settleTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  // True when a capture is ready to review but a dialog is already open, so we
  // show a small "waiting" badge until the open dialog closes.
  const [deferred, setDeferred] = useState(false);

  // Run the pure reducer against the current pending + missions; surface AT MOST
  // ONE ready entry (only when no review is open), update bookkeeping, prune the
  // dropped/surfaced results. Guarded.
  const reconcileNow = (): void => {
    const pending = pendingRef.current;
    if (pending.length === 0) {
      if (deferred) setDeferred(false);
      return;
    }
    try {
      // Pass reviewOpen so the reducer is DEFER-AWARE: while a dialog is open it
      // holds ready entries UNSTAMPED in keep[] (and reports them in deferred[])
      // instead of stamping+routing them to review[] — which previously lost them
      // (stamped on defer, then short-circuited to keep on the next tick, never
      // surfacing). The entry surfaces on a later reconcile once reviewOpen flips
      // false (the [missions, reviewOpen, enabled] effect re-runs on close).
      const reviewOpenNow = reviewOpenRef.current;
      const {
        review,
        keep,
        expired,
        deferred: deferredEntries,
      } = reconcilePending(
        pending,
        missionsRef.current,
        Date.now(),
        reviewOpenNow,
      );
      // Replace pending FIRST so a re-entrant tick sees post-reconcile state.
      pendingRef.current = keep;
      // Drop OCR results for expired entries (free memory; they'll never surface).
      for (const e of expired) resultsRef.current.delete(e.missionId);

      // A review is already open -> the reducer deferred any ready entry (held
      // unstamped). Show the badge while something waits; surface after it closes.
      if (reviewOpenNow) {
        const want = deferredEntries.length > 0;
        if (want !== deferred) setDeferred(want);
        return;
      }

      if (review.length === 0) {
        if (deferred) setDeferred(false);
        return;
      }

      // Surface exactly ONE ready capture (one review at a time). Build its
      // prefill from the stored OCR result; carry the confident pre-target.
      const inst = review[0];
      const base = resultsRef.current.get(inst.pending.missionId);
      if (base) {
        resultsRef.current.delete(inst.pending.missionId);
        onAutoReviewRef.current({
          ...base,
          preselectMissionId: inst.preselectMissionId,
        });
        if (deferred) setDeferred(false);
      }
    } catch (err) {
      console.error("[auto-ocr] reconcile failed:", err);
    }
  };

  // Subscribe to the auto-capture signal once. Each request waits the SETTLE
  // DELAY (so the contract screen finishes rendering) and then runs the pipeline
  // and enqueues a pending entry. Fully guarded.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timers = settleTimersRef.current;

    // The actual capture, run AFTER the settle delay has elapsed (or immediately
    // when the delay is 0). Guards on `cancelled` after every await so a capture
    // can never land after unmount/disable.
    const runCapture = async (request: {
      missionId: string;
      title: string;
      ts: number;
    }): Promise<void> => {
      try {
        // 1. Read the OPTIONAL calibrated region. null is fine now — the pipeline
        // OCRs the full frame when there's no region (calibration only boosts
        // accuracy, it is no longer a prerequisite). No "calibrate first" gate.
        let region: Awaited<
          ReturnType<typeof window.api.getOcrCaptureRegion>
        > | null = null;
        try {
          region = await window.api.getOcrCaptureRegion();
        } catch {
          region = null;
        }
        if (cancelled) return;

        // 2. Run the shared pipeline headless (full-frame when region is null).
        const result = await runOcrPipeline(region, referenceRef.current);
        if (cancelled) return;
        const objectives = toApplyObjectives(result.objectives);
        // 3. Zero objectives -> silently discard (don't surface garbage).
        if (objectives.length === 0) return;

        // 4. Enqueue for correlated, race-safe SURFACING. Skip if an entry for
        // this missionId is already queued (a duplicate live re-emit of the same
        // accept) so we don't open two reviews for one mission.
        if (pendingRef.current.some((p) => p.missionId === request.missionId)) {
          return;
        }
        // Stash the full OCR result so we can build the prefill at surface time.
        resultsRef.current.set(request.missionId, {
          objectives: result.objectives,
          reward: result.reward,
          title: result.title,
          confidence: result.confidence,
          rawText: result.rawText,
          preselectMissionId: null, // filled from the reducer at surface time
        });
        const entry: PendingApply = {
          missionId: request.missionId,
          title: request.title,
          ts: request.ts,
          objectives,
          enqueuedAt: Date.now(),
          reviewedOnce: false,
        };
        pendingRef.current = [...pendingRef.current, entry];
        // Try to surface right away (it'll hold if not ready or a review is open).
        reconcileNow();
      } catch (err) {
        // Any failure in the auto path is swallowed — the manual dialog remains.
        console.error("[auto-ocr] auto request failed:", err);
      }
    };

    // On a request, SCHEDULE the capture after the settle delay. If a timer for
    // the same missionId is already pending (the accept log line re-emitted), we
    // SUPERSEDE it — clear and reschedule — so the clock restarts and we never
    // run two captures for one accept. A delay of 0 captures on the next tick.
    const handle = (request: {
      missionId: string;
      title: string;
      ts: number;
    }): void => {
      const existing = timers.get(request.missionId);
      if (existing !== undefined) clearTimeout(existing);
      const delay = captureDelayMsRef.current;
      const t = setTimeout(
        () => {
          timers.delete(request.missionId);
          if (cancelled) return;
          void runCapture(request);
        },
        delay > 0 ? delay : 0,
      );
      timers.set(request.missionId, t);
    };

    const unsub = window.api.onOcrAutoRequest((request) => handle(request));
    return () => {
      cancelled = true;
      unsub();
      // Clear any settle timers still pending so no capture fires post-unmount.
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Re-reconcile whenever the mission list changes (markers arriving) OR the open
  // review closes (reviewOpen flips false) — both can make a pending entry ready
  // to surface. Load-bearing for the leg-arrival race + the deferral release.
  useEffect(() => {
    if (!enabled) return;
    reconcileNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missions, reviewOpen, enabled]);

  // A slow tick advances settle/TTL even when no missions:changed arrives (e.g.
  // a log-suppressed mission whose markers never come — settle surfaces it, TTL
  // eventually drops it). Cleared on unmount / disable.
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(reconcileNow, TICK_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // When disabled, drop any queued work + transient UI so nothing lingers. The
  // subscription effect's cleanup (dep [enabled]) already clears settle timers
  // when enabled flips false; we clear here too for defense-in-depth so a
  // pending settle timer can never fire a capture after the feature is off.
  useEffect(() => {
    if (enabled) return;
    pendingRef.current = [];
    resultsRef.current.clear();
    const timers = settleTimersRef.current;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    setDeferred(false);
  }, [enabled]);

  if (!enabled) return null;
  if (!deferred) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 18,
        right: 18,
        zIndex: 35,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 380,
      }}
    >
      {deferred && (
        <div
          role="status"
          style={{
            padding: "12px 14px",
            background: "rgba(9,16,28,0.98)",
            border: "1px solid rgba(0,200,220,0.45)",
            color: "var(--primary)",
            fontFamily: "var(--font-display)",
            fontSize: 12,
            lineHeight: 1.5,
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
          }}
        >
          An auto-captured contract is waiting to review — close the open dialog
          and it’ll pop up for you to check and apply.
        </div>
      )}
    </div>
  );
}
