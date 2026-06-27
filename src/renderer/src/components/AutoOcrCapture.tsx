// ============================================================================
// AutoOcrCapture — EXPERIMENTAL Auto OCR Capture host (Phase 3)
// ----------------------------------------------------------------------------
// A headless host mounted in CargoApp (active in cargo mode) that listens for
// the OCR_AUTO_REQUEST push main broadcasts when a cargo contract is accepted
// while the feature is on. On a request it:
//   1. reads the calibrated capture region — if NULL (uncalibrated), shows a
//      one-time non-blocking notice and STOPS (auto-capture needs a region);
//   2. else runs the shared runOcrPipeline() headless -> objectives[]; if zero
//      objectives, silently discards (defensive — never write garbage);
//   3. enqueues a PendingApply and lets the pure ocrAutoCorrelate reducer decide
//      WHEN (and to WHICH mission) to apply — handling the leg-arrival race:
//        - apply once the mission exists AND has legs, or after a settle debounce;
//        - re-apply (idempotent) on later missions:changed within the TTL so
//          late-arriving markers still get reconciled; drop after the TTL.
//   4. on apply, calls window.api.applyOcr() and surfaces a transient, non-
//      blocking "review the legs" banner.
//
// EVERYTHING is guarded: any throw is caught and ignored so the app never breaks.
// Session-transient only — no DB schema change. The auto path NEVER opens the
// review modal; it fills tentatively and nudges the user to review.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import type { Mission, ReferenceData } from "@shared/types";
import { runOcrPipeline, type ReviewObjective } from "../lib/ocrPipeline";
import { reconcilePending, type PendingApply } from "../lib/ocrAutoCorrelate";

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

/** A transient review cue shown after an auto-fill (auto-dismisses). */
interface ReviewCue {
  id: number;
  title: string;
}

/** How often the host re-runs the reconcile loop (settle/TTL progress) when no
 *  missions:changed event arrives. Cheap — the reducer is pure + O(pending). */
const TICK_MS = 1_000;

/** How long a review cue stays on screen before auto-dismissing. */
const CUE_LINGER_MS = 9_000;

export function AutoOcrCapture({
  enabled,
  missions,
  reference,
}: {
  /** Whether Auto OCR Capture is enabled (host is inert when false). */
  enabled: boolean;
  /** Live active missions, for correlation (passed from CargoApp). */
  missions: Mission[];
  /** Bundled reference (fuzzy-match candidates for the pipeline). */
  reference: ReferenceData;
}): React.JSX.Element | null {
  // Pending auto-applies awaiting correlation. A ref is the source of truth (so
  // async request handlers + the tick loop see the latest without stale closures);
  // a state mirror is unused for render but the ref drives everything.
  const pendingRef = useRef<PendingApply[]>([]);
  // Latest missions, mirrored to a ref so the interval callback (set up once)
  // always reconciles against the current list without re-subscribing.
  const missionsRef = useRef<Mission[]>(missions);
  missionsRef.current = missions;
  const referenceRef = useRef<ReferenceData>(reference);
  referenceRef.current = reference;

  // One-time "calibrate first" notice (shown once per session when an auto
  // request arrives with no calibrated region). Dismissible.
  const [showCalibrateNotice, setShowCalibrateNotice] = useState(false);
  const calibrateNoticeShownRef = useRef(false);
  // Transient review cues (one per successful auto-fill).
  const [cues, setCues] = useState<ReviewCue[]>([]);
  const cueSeqRef = useRef(0);

  const pushCue = (title: string): void => {
    const id = ++cueSeqRef.current;
    setCues((prev) => [...prev, { id, title }]);
    window.setTimeout(() => {
      setCues((prev) => prev.filter((c) => c.id !== id));
    }, CUE_LINGER_MS);
  };

  // Run the pure reducer against the current pending + missions, apply what it
  // says, and replace the pending list with what it says to keep. Guarded.
  const reconcileNow = (): void => {
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    try {
      const { apply, keep } = reconcilePending(
        pending,
        missionsRef.current,
        Date.now(),
      );
      // Replace pending FIRST so a re-entrant tick sees the post-apply state.
      pendingRef.current = keep;
      for (const inst of apply) {
        void window.api
          .applyOcr(inst.missionId, inst.objectives)
          .then(() => {
            // Surface the review cue only on the FIRST apply for this entry, so
            // an idempotent re-apply for late markers doesn't re-toast.
            if (!inst.pending.cueShown) {
              inst.pending.cueShown = true;
              pushCue(inst.pending.title);
            }
          })
          .catch((err: unknown) => {
            // A failed apply is non-fatal: the entry stays pending (within TTL)
            // and a later tick retries. Never throw into the app.
            console.error("[auto-ocr] applyOcr failed:", err);
          });
      }
    } catch (err) {
      console.error("[auto-ocr] reconcile failed:", err);
    }
  };

  // Subscribe to the auto-capture signal once. Each request runs the pipeline
  // and enqueues a pending entry (or shows the calibrate notice). Fully guarded.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const handle = async (request: {
      missionId: string;
      title: string;
      ts: number;
    }): Promise<void> => {
      try {
        // 1. Region gate — auto-capture needs a calibrated region.
        let region = null;
        try {
          region = await window.api.getOcrCaptureRegion();
        } catch {
          region = null;
        }
        if (cancelled) return;
        if (!region) {
          if (!calibrateNoticeShownRef.current) {
            calibrateNoticeShownRef.current = true;
            setShowCalibrateNotice(true);
          }
          return;
        }

        // 2. Run the shared pipeline headless.
        const result = await runOcrPipeline(region, referenceRef.current);
        if (cancelled) return;
        const objectives = toApplyObjectives(result.objectives);
        // 3. Zero objectives -> silently discard (don't write garbage).
        if (objectives.length === 0) return;

        // 4. Enqueue for correlated, race-safe apply. Skip if an entry for this
        // missionId is already queued (a duplicate live re-emit of the same
        // accept) — applyOcr is idempotent, but this avoids a second review cue.
        if (pendingRef.current.some((p) => p.missionId === request.missionId)) {
          return;
        }
        const entry: PendingApply = {
          missionId: request.missionId,
          title: request.title,
          ts: request.ts,
          objectives,
          enqueuedAt: Date.now(),
          appliedOnce: false,
        };
        pendingRef.current = [...pendingRef.current, entry];
        // Try to apply right away (it'll hold if the mission isn't ready yet).
        reconcileNow();
      } catch (err) {
        // Any failure in the auto path is swallowed — the manual dialog remains.
        console.error("[auto-ocr] auto request failed:", err);
      }
    };

    const unsub = window.api.onOcrAutoRequest(
      (request) => void handle(request),
    );
    return () => {
      cancelled = true;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Re-reconcile whenever the mission list changes (markers arriving) — this is
  // the load-bearing hook for the leg-arrival race (re-apply within TTL).
  useEffect(() => {
    if (!enabled) return;
    reconcileNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missions, enabled]);

  // A slow tick advances settle/TTL even when no missions:changed arrives (e.g.
  // a log-suppressed mission whose markers never come — settle debounce applies,
  // TTL eventually drops it). Cleared on unmount / disable.
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(reconcileNow, TICK_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // When disabled, drop any queued work + transient UI so nothing lingers.
  useEffect(() => {
    if (enabled) return;
    pendingRef.current = [];
    setCues([]);
    setShowCalibrateNotice(false);
  }, [enabled]);

  if (!enabled) return null;
  if (!showCalibrateNotice && cues.length === 0) return null;

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
      {showCalibrateNotice && (
        <div
          role="status"
          onClick={() => setShowCalibrateNotice(false)}
          style={{
            padding: "12px 14px",
            background: "rgba(28,22,10,0.98)",
            border: "1px solid rgba(224,160,52,0.5)",
            color: "var(--warning, #e0a034)",
            fontFamily: "var(--font-display)",
            fontSize: 12,
            lineHeight: 1.5,
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            cursor: "pointer",
          }}
        >
          Auto-capture is on, but the OCR capture region isn’t calibrated yet.
          Calibrate it first (open Contract Capture once), then accepting a
          cargo haul will auto-fill its details. (Click to dismiss.)
        </div>
      )}
      {cues.map((cue) => (
        <div
          key={cue.id}
          role="status"
          onClick={() => setCues((prev) => prev.filter((c) => c.id !== cue.id))}
          style={{
            padding: "12px 14px",
            background: "rgba(9,20,16,0.98)",
            border: "1px solid rgba(84,224,138,0.45)",
            color: "var(--success, #54e08a)",
            fontFamily: "var(--font-display)",
            fontSize: 12,
            lineHeight: 1.5,
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            cursor: "pointer",
          }}
        >
          ✓ Auto-filled contract details for “{cue.title}” from the contract
          screen — review the legs. (Click to dismiss.)
        </div>
      ))}
    </div>
  );
}
