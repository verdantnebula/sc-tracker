// ============================================================================
// OcrCaptureDialog — EXPERIMENTAL OCR contract capture review modal (Phase F)
// ----------------------------------------------------------------------------
// Opt-in fallback for when the game suppressed the New Objective log line.
//
// CAPTURE via an OPTIONAL per-user CALIBRATED region:
//   The full-screen grab stays (we do NOT target the SC window). A region is
//   OPTIONAL — by default we OCR the whole frame; calibrating a region only
//   improves accuracy by EXCLUDING the right-hand DETAILS column so flavor text
//   can't bleed into parsed locations. Screen sizes/resolutions differ, so the
//   region is the USER's own, stored as PROPORTIONS (fractions 0..1).
//
//   UNCALIBRATED (region null = default) — full-screen, no drawing required:
//     capture FULL screen -> fullFrameRect (whole image) -> PREPROCESS in <canvas>
//       at 1× (fullFrameScale — NOT upscaled, memory guard) -> OCR -> parse ->
//       fuzzy-match -> REVIEW -> APPLY.
//
//   CALIBRATED (region set) — reads just the region, no drawing:
//     capture FULL screen -> cropRectFromRegion (proportions -> px, clamped)
//       -> normalizeScale (upscale the crop to ~a consistent height across
//          resolutions) -> PREPROCESS in <canvas> (grayscale, threshold+invert)
//       -> OCR (tesseract.js, MAIN) -> parse -> fuzzy-match -> REVIEW -> APPLY.
//
//   CONTROLS (optional accuracy tool): "Calibrate a region (optional)" (draw a
//   box) and "Reset region" (clear to null so the next capture is full-frame).
//
//   FALLBACK (never a dead end): if a CALIBRATED capture parses ZERO objectives,
//   we surface a clear message and offer to re-draw the region (manual crop) for
//   this capture — the screenshot is still in hand, so no recapture is needed.
//
// WHY CALIBRATE (OPTIONAL): OCR'ing the full busy frame can pick up scene noise
// and let DETAILS-column flavor text bleed into parsed locations. Cropping to just
// the contract text and feeding tesseract a high-contrast binarized image sharpens
// the read — so a region is offered as an accuracy booster, not a requirement.
//
// HARD RULES (defensive by construction):
//   - NEVER auto-applies. Apply is a deliberate button after review.
//   - OCR is unproven on the stylized mobiGlas font; every field is editable and
//     shows a match confidence so the user can fix mistakes before writing.
//   - Any capture/OCR failure shows a readable message; the app never crashes.
//   - No image is persisted (the data URL lives in memory for the OCR pass only).
//
// Theme-token driven so it renders in the cargo theme. Mounted from the Mission
// Detail panel (for a log-suppressed / "details missing" mission) and reused via
// a top-level entry; the target mission can be preselected by the caller.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import type { Mission, ReferenceData, OcrCaptureRegion } from "@shared/types";
import { resolvePreselectTarget } from "@shared/ocrMatch";
import {
  mapSelectionToSource,
  cropRectFromRegion,
  fullFrameRect,
  type Rect,
} from "@shared/ocrPreprocess";
import { recognizeContract } from "../lib/ocrRunner";
import {
  reviewObjectivesFrom,
  loadImage,
  preprocessCrop,
  type ReviewObjective,
} from "../lib/ocrPipeline";

/**
 * A pre-filled review handed to the dialog by the AUTO path (Phase 3). When set,
 * the dialog SKIPS its capture/OCR flow and opens straight in the review state
 * with these values — so an auto-capture on cargo-accept surfaces for human
 * review-and-Apply instead of writing silently. `preselectMissionId` pre-targets
 * the dropdown ONLY when correlation was confident (else null -> user picks).
 * Nothing is written until the user clicks Apply, exactly like a manual review.
 */
export interface OcrPrefill {
  objectives: ReviewObjective[];
  reward: number | null;
  /** The OCR'd contract title (cleaned), or null when none was read. */
  title: string | null;
  confidence: number;
  rawText: string;
  /** Confident correlated mission id, or null when correlation was uncertain. */
  preselectMissionId: string | null;
}

type Phase =
  | { kind: "idle" }
  | { kind: "capturing" }
  /**
   * Screenshot in hand; user drags a selection box over the scaled preview. This
   * is reached when UNCALIBRATED (first run / recalibrate) OR as the fallback when
   * a calibrated capture parsed zero objectives (`note` carries that message).
   */
  | {
      kind: "cropping";
      dataUrl: string;
      /** True source pixel dimensions of the captured frame. */
      sourceWidth: number;
      sourceHeight: number;
      /** Optional banner shown above the crop UI (e.g. the zero-objective fallback). */
      note?: string;
    }
  | { kind: "recognizing" }
  | { kind: "review"; confidence: number; rawText: string }
  | { kind: "applied" }
  | { kind: "error"; message: string };

/**
 * Resolve the dialog's initial/refreshed target id, honoring an explicit
 * pre-target first (the per-mission "OCR Capture" button or a confident auto
 * correlation), then falling back to a CONFIDENT title match, else null. Thin
 * wrapper over the PURE {@link resolvePreselectTarget} so the dialog just passes
 * its missions; precedence + the "preselect must be a real candidate" guard live
 * in the shared, unit-tested helper.
 */
function preselectTarget(
  preselectId: string | null | undefined,
  ocrTitle: string | null,
  missions: Mission[],
): string | null {
  return resolvePreselectTarget(
    preselectId,
    ocrTitle,
    missions.map((m) => m.id),
    missions.map((m) => m.title ?? ""),
  );
}

export function OcrCaptureDialog({
  missions,
  reference,
  prefill,
  preselectMissionId,
  onClose,
}: {
  /** Active missions the result can be applied to. */
  missions: Mission[];
  /** Bundled reference (fuzzy-match candidates for commodity/location). */
  reference: ReferenceData;
  /**
   * AUTO path (Phase 3): when set, open straight into review pre-filled with this
   * OCR result instead of running the capture flow. Undefined = the manual path
   * (capture on mount). See {@link OcrPrefill}.
   */
  prefill?: OcrPrefill;
  /**
   * MANUAL pre-target (per-mission capture): the mission whose detail panel
   * launched this capture. Pre-selects the "APPLY TO" dropdown to THIS mission so
   * the reviewed contract applies here in one click — the manual counterpart to
   * auto-capture's `preselectMissionId`. The user can still change the target in
   * the dropdown (escape hatch). NEVER auto-applies; review-before-apply stands.
   * For the auto path the prefill's own `preselectMissionId` is used instead.
   */
  preselectMissionId?: string | null;
  onClose: () => void;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>(
    // Auto (prefilled): land directly in review. Manual: start idle -> capture.
    prefill
      ? {
          kind: "review",
          confidence: prefill.confidence,
          rawText: prefill.rawText,
        }
      : { kind: "idle" },
  );
  const [objectives, setObjectives] = useState<ReviewObjective[]>(
    prefill?.objectives ?? [],
  );
  const [reward, setReward] = useState<number | null>(prefill?.reward ?? null);
  // The OCR'd contract title (cleaned), shown to the user and used to pre-select
  // the target mission on a CONFIDENT match. Null until a capture reads one (or
  // from the auto prefill).
  const [ocrTitle, setOcrTitle] = useState<string | null>(
    prefill?.title ?? null,
  );
  // Apply target. MANUAL opens with NO default (empty placeholder) so the APPLY
  // button stays disabled until the user deliberately picks a mission. The AUTO
  // path may pre-target a CONFIDENT correlated mission so it's a one-click apply;
  // an uncertain auto correlation also starts empty (never guess a target).
  //
  // TITLE PRESELECT: when there is no confident DIRECT pre-target (manual path,
  // or an uncertain auto correlation -> preselectMissionId null), we try to
  // pre-select by matching the OCR title against the candidate mission titles —
  // but ONLY on a CONFIDENT title match (clears threshold AND beats the runner-up
  // by a margin, so two near-duplicates don't get a false pick). An unconfident
  // or ambiguous match leaves the dropdown EMPTY (Apply greyed until chosen).
  // The explicit pre-target: the AUTO path supplies it via the prefill (confident
  // correlation), the MANUAL per-mission button supplies it via the prop. They're
  // mutually exclusive in practice (prefill ⇒ auto, preselectMissionId ⇒ manual);
  // coalesce so one resolver path handles both.
  const explicitPreselect =
    prefill?.preselectMissionId ?? preselectMissionId ?? null;
  const [targetId, setTargetId] = useState<string | null>(() =>
    preselectTarget(explicitPreselect, prefill?.title ?? null, missions),
  );
  const [showRaw, setShowRaw] = useState(false);
  // The user's calibrated capture region (proportions 0..1), or null until the
  // first capture draws one. Held in component state so a recalibrate / reset
  // within this session takes effect immediately (and is also persisted).
  const [region, setRegion] = useState<OcrCaptureRegion | null>(null);
  // Gates the very first capture until the persisted region has been read, so we
  // don't flash the draw UI for a user who is already calibrated.
  const [regionLoaded, setRegionLoaded] = useState(false);

  // The full-resolution screenshot, held in memory only (an offscreen <img> used
  // as the canvas crop source). Cleared on unmount; never persisted.
  const sourceImgRef = useRef<HTMLImageElement | null>(null);

  // On mount: read the persisted calibrated region, THEN kick off the first
  // capture. The user already opted in by opening the dialog. (No auto-apply;
  // this only READS the screen.) We pass the freshly-read region directly into
  // the first capture so it branches correctly without waiting for a re-render.
  //
  // AUTO path (prefill set): the OCR pass already ran headless, so we do NOT
  // capture again — we open straight in review with the prefilled values. We
  // still read the region so the Recapture/Re-draw controls work if the user
  // wants to re-OCR from the dialog.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let initialRegion: OcrCaptureRegion | null = null;
      try {
        initialRegion = await window.api.getOcrCaptureRegion();
      } catch {
        initialRegion = null; // defensive: a read failure -> uncalibrated.
      }
      if (cancelled) return;
      setRegion(initialRegion);
      setRegionLoaded(true);
      // Prefilled (auto): stay in the review phase set at init; don't re-capture.
      if (prefill) return;
      await runCapture(initialRegion);
    })();
    return () => {
      cancelled = true;
      sourceImgRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * STEP 1: grab the full screen at native resolution. We decode the PNG into an
   * offscreen <img> so the crop canvas has a pixel source, and read its true
   * dimensions. Then we BRANCH:
   *   - `forceDraw` true: always show the draw-a-box step (the explicit
   *     "Re-draw capture region" / Reset controls — the OPTIONAL calibration tool).
   *   - CALIBRATED (region set): auto-crop to the region + recognize (one-button).
   *   - UNCALIBRATED (region null): OCR the FULL frame. Region is OPTIONAL now —
   *     the default capture works full-screen without forcing the user to draw a
   *     box; calibration only improves accuracy.
   *
   * `activeRegion` is passed explicitly (defaulting to current state) so the
   * mount flow can use the freshly-read region before a re-render. `forceDraw`
   * lets the calibration buttons open the draw UI on demand.
   */
  async function runCapture(
    activeRegion: OcrCaptureRegion | null = region,
    forceDraw = false,
  ): Promise<void> {
    setPhase({ kind: "capturing" });
    try {
      const cap = await window.api.captureScreenForOcr();
      if (cap.outcome !== "ok" || !cap.dataUrl) {
        setPhase({
          kind: "error",
          message: cap.error ?? "Could not capture the screen.",
        });
        return;
      }
      const img = await loadImage(cap.dataUrl);
      sourceImgRef.current = img;

      if (forceDraw) {
        // Explicit calibrate/re-draw: show the draw-a-box step regardless of region.
        setPhase({
          kind: "cropping",
          dataUrl: cap.dataUrl,
          sourceWidth: img.naturalWidth,
          sourceHeight: img.naturalHeight,
        });
        return;
      }
      if (activeRegion) {
        // Calibrated: auto-crop to the saved proportional region and recognize.
        await recognizeRegion(img, activeRegion);
        return;
      }
      // Uncalibrated: OCR the whole frame (region is optional). No draw forced.
      await recognizeFullFrame(img);
    } catch (err) {
      setPhase({
        kind: "error",
        message:
          "Screen capture failed. " +
          String(err instanceof Error ? err.message : err),
      });
    }
  }

  /**
   * CALIBRATED path: convert the saved proportional region into a pixel crop for
   * THIS screenshot (cropRectFromRegion clamps to bounds), preprocess + OCR, then
   * parse/match into the review step. FALLBACK: if zero objectives are parsed, we
   * don't dead-end — we drop back to the crop UI (screenshot still in hand) with a
   * message so the user can re-draw the region for this capture.
   */
  async function recognizeRegion(
    img: HTMLImageElement,
    activeRegion: OcrCaptureRegion,
  ): Promise<void> {
    const srcRect = cropRectFromRegion(
      activeRegion,
      img.naturalWidth,
      img.naturalHeight,
    );
    if (srcRect.width <= 0 || srcRect.height <= 0) {
      // A degenerate region (shouldn't happen post-normalize) -> re-draw.
      setPhase({
        kind: "cropping",
        dataUrl: img.src,
        sourceWidth: img.naturalWidth,
        sourceHeight: img.naturalHeight,
        note: "The saved capture region was empty. Draw it again below.",
      });
      return;
    }

    setPhase({ kind: "recognizing" });
    try {
      const result = await runOcrOnRect(img, srcRect, "6");
      const reviewed = reviewObjectivesFrom(
        result.contract.objectives,
        reference,
      );
      if (reviewed.length === 0) {
        // FALLBACK — never a dead end: offer a manual re-draw for this capture.
        setPhase({
          kind: "cropping",
          dataUrl: img.src,
          sourceWidth: img.naturalWidth,
          sourceHeight: img.naturalHeight,
          note:
            "No objectives were recognized from the saved region. Try re-drawing " +
            "the capture region around the “Deliver … SCU …” lines (this also " +
            "re-calibrates it for next time).",
        });
        return;
      }
      setObjectives(reviewed);
      setReward(result.contract.reward);
      applyTitlePreselect(result.contract.title);
      setPhase({
        kind: "review",
        confidence: result.confidence,
        rawText: result.rawText,
      });
    } catch (err) {
      setPhase({
        kind: "error",
        message:
          "OCR failed. " + String(err instanceof Error ? err.message : err),
      });
    }
  }

  /**
   * UNCALIBRATED / re-draw path: given the user's drawn selection (displayed/CSS
   * pixels) and the displayed image size, map it to source pixels, SAVE it as a
   * proportional capture region (so every future capture is one-button), then OCR
   * + parse + review. PSM defaults to "6" (uniform block).
   */
  async function recognizeSelection(
    selection: Rect,
    displayWidth: number,
    displayHeight: number,
    psm: "6" | "11" = "6",
  ): Promise<void> {
    const img = sourceImgRef.current;
    if (!img) {
      setPhase({ kind: "error", message: "No captured image to read." });
      return;
    }
    const srcRect = mapSelectionToSource(
      selection,
      displayWidth,
      displayHeight,
      img.naturalWidth,
      img.naturalHeight,
    );
    if (srcRect.width <= 0 || srcRect.height <= 0) {
      setPhase({
        kind: "error",
        message: "Selection was empty. Drag a box around the objectives.",
      });
      return;
    }

    // CALIBRATE: persist this selection as proportions of the source frame so the
    // next capture auto-crops to it. Best-effort — a save failure must not block
    // this capture, so we still proceed with the in-hand rect.
    const proportional: OcrCaptureRegion = {
      x: srcRect.x / img.naturalWidth,
      y: srcRect.y / img.naturalHeight,
      w: srcRect.width / img.naturalWidth,
      h: srcRect.height / img.naturalHeight,
    };
    try {
      const saved = await window.api.setOcrCaptureRegion(proportional);
      setRegion(saved);
    } catch {
      // Keep the in-memory region so the session is still calibrated.
      setRegion(proportional);
    }

    setPhase({ kind: "recognizing" });
    try {
      const result = await runOcrOnRect(img, srcRect, psm);
      setObjectives(
        reviewObjectivesFrom(result.contract.objectives, reference),
      );
      setReward(result.contract.reward);
      applyTitlePreselect(result.contract.title);
      setPhase({
        kind: "review",
        confidence: result.confidence,
        rawText: result.rawText,
      });
    } catch (err) {
      setPhase({
        kind: "error",
        message:
          "OCR failed. " + String(err instanceof Error ? err.message : err),
      });
    }
  }

  /**
   * Crop + preprocess `srcRect` from `img` and OCR it. Shared by the calibrated,
   * manual-draw, and full-frame paths so all use the SAME preprocessing pipeline.
   * `isFullFrame` caps the scale at 1× for a whole-frame rect (memory guard); the
   * cropped paths leave it false so the crop upscales toward the target height.
   */
  async function runOcrOnRect(
    img: HTMLImageElement,
    srcRect: Rect,
    psm: "6" | "11",
    isFullFrame = false,
  ): ReturnType<typeof recognizeContract> {
    const processed = preprocessCrop(img, srcRect, isFullFrame);
    return recognizeContract(processed, psm, isFullFrame);
  }

  /**
   * FULL-FRAME path (no calibrated region): OCR the entire captured frame. This is
   * the default when the user hasn't drawn a region — calibration is optional and
   * only improves accuracy. If zero objectives parse we don't dead-end; we surface
   * the draw UI so the user can OPT IN to a region for this (and future) captures.
   */
  async function recognizeFullFrame(img: HTMLImageElement): Promise<void> {
    const srcRect = fullFrameRect(img.naturalWidth, img.naturalHeight);
    if (srcRect.width <= 0 || srcRect.height <= 0) {
      setPhase({ kind: "error", message: "The captured screen was empty." });
      return;
    }
    setPhase({ kind: "recognizing" });
    try {
      const result = await runOcrOnRect(img, srcRect, "6", true);
      const reviewed = reviewObjectivesFrom(
        result.contract.objectives,
        reference,
      );
      if (reviewed.length === 0) {
        // Not a dead end: offer the OPTIONAL region tool to sharpen this read.
        setPhase({
          kind: "cropping",
          dataUrl: img.src,
          sourceWidth: img.naturalWidth,
          sourceHeight: img.naturalHeight,
          note:
            "No objectives were recognized from the full screen. For better " +
            "accuracy you can draw a box around the “Deliver … SCU …” lines " +
            "(optional — this also calibrates the region for next time).",
        });
        return;
      }
      setObjectives(reviewed);
      setReward(result.contract.reward);
      applyTitlePreselect(result.contract.title);
      setPhase({
        kind: "review",
        confidence: result.confidence,
        rawText: result.rawText,
      });
    } catch (err) {
      setPhase({
        kind: "error",
        message:
          "OCR failed. " + String(err instanceof Error ? err.message : err),
      });
    }
  }

  /**
   * Reset the calibration to null. The next capture falls back to the new DEFAULT
   * (full-frame OCR), not the draw UI — region is optional. Best-effort persist.
   */
  async function resetRegion(): Promise<void> {
    try {
      await window.api.setOcrCaptureRegion(null);
    } catch {
      /* ignore — clearing in-memory below still un-calibrates this session */
    }
    setRegion(null);
    // Recapture immediately so the user sees the (now full-frame) default effect.
    await runCapture(null);
  }

  function updateObjective(
    index: number,
    patch: Partial<ReviewObjective>,
  ): void {
    setObjectives((prev) =>
      prev.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    );
  }

  function removeObjective(index: number): void {
    setObjectives((prev) => prev.filter((_, i) => i !== index));
  }

  /**
   * Record the OCR'd title and, when the user hasn't already picked a target,
   * pre-select the target — honoring an explicit pre-target first (the per-mission
   * capture button), then a CONFIDENT title match, else leaving the dropdown empty.
   * Called by every manual capture path once OCR completes. Never overrides a
   * target the user has already chosen this session.
   */
  function applyTitlePreselect(title: string | null): void {
    setOcrTitle(title);
    setTargetId(
      (cur) => cur ?? preselectTarget(explicitPreselect, title, missions),
    );
  }

  // Busy = an in-flight capture/OCR pass; disables the footer controls so the
  // user can't kick off a second capture mid-recognition.
  const busy = phase.kind === "capturing" || phase.kind === "recognizing";

  const target = missions.find((m) => m.id === targetId) ?? null;
  const canApply =
    target !== null &&
    (objectives.length > 0 || reward !== null) &&
    phase.kind === "review";

  // Apply the reviewed objectives via the semantic-MERGE path (applyOcr): it
  // FILLS the mission's suppressed placeholder legs in place (preserving their
  // game objectiveId so future ObjectiveComplete log events still key correctly)
  // and prunes leftover unmatched placeholders — instead of appending duplicate
  // legs (the old addLegs path, Bug 1a). Any non-leg field (reward) still flows
  // through the existing audited updateMission path.
  function apply(): void {
    if (!target) return;
    const run = async (): Promise<void> => {
      if (objectives.length > 0) {
        await window.api.applyOcr(
          target.id,
          objectives.map((o) => ({
            kind: o.kind,
            commodity: o.commodity,
            scu: o.scu,
            location: o.location.length > 0 ? o.location : null,
          })),
        );
      }
      if (reward !== null) {
        await window.api.updateMission(target.id, { reward });
      }
    };
    void run()
      .then(() => setPhase({ kind: "applied" }))
      .catch((err: unknown) =>
        setPhase({
          kind: "error",
          message:
            "Could not apply to the mission. " +
            String(err instanceof Error ? err.message : err),
        }),
      );
  }

  return (
    <>
      <div
        onClick={
          phase.kind === "review" ||
          phase.kind === "error" ||
          phase.kind === "applied"
            ? onClose
            : undefined
        }
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 50,
          background: "rgba(0,0,0,0.55)",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Experimental OCR contract capture"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 51,
          // Wider during the crop step so the screenshot preview is large enough
          // to drag an accurate selection box.
          width: phase.kind === "cropping" ? 900 : 600,
          maxWidth: "calc(100vw - 48px)",
          maxHeight: "calc(100vh - 64px)",
          overflowY: "auto",
          padding: 22,
          background: "var(--surface, rgba(9,16,21,0.99))",
          border: "1px solid var(--border-strong)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.7)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 13,
              letterSpacing: 1.5,
              color: "var(--text-bright)",
            }}
          >
            OCR CONTRACT CAPTURE
          </span>
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 9,
              letterSpacing: 1,
              color: "var(--bg, #04181a)",
              background: "var(--primary)",
              padding: "2px 6px",
            }}
          >
            EXPERIMENTAL
          </span>
        </div>
        <p
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--text-2)",
            margin: "0 0 16px",
          }}
        >
          Reads your mobiGlas contract screen to recover details the game didn’t
          write to the log.{" "}
          {region
            ? "Your capture region is calibrated, so it reads just that area — " +
              "use the controls below to re-draw or reset it."
            : "It reads the full screen by default. For better accuracy you can " +
              "optionally calibrate a capture region around the “Deliver … SCU …” " +
              "objectives using the controls below."}{" "}
          OCR can misread the stylized font — check every field before applying.
          Nothing is changed until you press Apply.
        </p>

        {(phase.kind === "capturing" || phase.kind === "recognizing") && (
          <div
            style={{
              padding: "24px 0",
              textAlign: "center",
              fontFamily: "var(--font-display)",
              fontSize: 13,
              color: "var(--primary)",
            }}
          >
            {phase.kind === "capturing"
              ? "Capturing the screen…"
              : "Preprocessing + reading the selection (OCR)…"}
          </div>
        )}

        {phase.kind === "cropping" && (
          <CropStep
            dataUrl={phase.dataUrl}
            sourceWidth={phase.sourceWidth}
            sourceHeight={phase.sourceHeight}
            note={phase.note}
            onConfirm={(sel, dispW, dispH) =>
              void recognizeSelection(sel, dispW, dispH)
            }
          />
        )}

        {phase.kind === "error" && (
          <ResultBanner ok={false} text={phase.message} />
        )}

        {phase.kind === "applied" && (
          <ResultBanner
            ok
            text="Applied to the mission. Review the legs in the detail panel."
          />
        )}

        {phase.kind === "review" && (
          <ReviewBody
            objectives={objectives}
            reward={reward}
            setReward={setReward}
            ocrTitle={ocrTitle}
            confidence={phase.confidence}
            rawText={phase.rawText}
            showRaw={showRaw}
            setShowRaw={setShowRaw}
            missions={missions}
            targetId={targetId}
            setTargetId={setTargetId}
            preTargeted={
              explicitPreselect !== null && targetId === explicitPreselect
            }
            onUpdateObjective={updateObjective}
            onRemoveObjective={removeObjective}
          />
        )}

        {/* footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            marginTop: 18,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="sc-ghost-btn"
              onClick={() => void runCapture()}
              disabled={busy}
              style={ghostBtn(!busy)}
            >
              ⟳ Recapture
            </button>
            {/* Recalibrate: force the draw-a-box step on a fresh capture so the
                user can re-draw (and re-save) the region. Available once loaded. */}
            {regionLoaded && (
              <button
                className="sc-ghost-btn"
                onClick={() => void runCapture(region, true)}
                disabled={busy}
                style={ghostBtn(!busy)}
                title="Capture again and draw a region to improve accuracy (optional)"
              >
                ✎ Calibrate a region (optional)
              </button>
            )}
            {/* Reset: clear the saved region to null so the NEXT capture
                re-calibrates. Only meaningful when a region is set. */}
            {region !== null && (
              <button
                className="sc-ghost-btn"
                onClick={() => void resetRegion()}
                disabled={busy}
                style={ghostBtn(!busy)}
                title="Clear the saved capture region (next capture re-calibrates)"
              >
                ⌫ Reset region
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              className="sc-ghost-btn"
              onClick={onClose}
              style={ghostBtn(true)}
            >
              {phase.kind === "applied" ? "Close" : "Cancel"}
            </button>
            {phase.kind === "review" && (
              // The single mission selector lives in ReviewBody (after the
              // objectives). The footer keeps only the APPLY button, which stays
              // disabled until a mission is chosen there.
              <button
                className="sc-primary-btn"
                onClick={apply}
                disabled={!canApply}
                style={primaryBtn(canApply)}
                title={
                  canApply
                    ? "Apply the reviewed objectives to the selected mission"
                    : "Select a mission first"
                }
              >
                APPLY TO MISSION
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Crop step — scaled screenshot preview + drag-to-select rectangle overlay
// ---------------------------------------------------------------------------

function CropStep({
  dataUrl,
  sourceWidth,
  sourceHeight,
  note,
  onConfirm,
}: {
  dataUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  /** Optional banner shown above the crop UI (e.g. the zero-objective fallback). */
  note?: string;
  /** Called with the selection (CSS px) + the displayed image size (CSS px). */
  onConfirm: (sel: Rect, displayWidth: number, displayHeight: number) => void;
}): React.JSX.Element {
  const imgWrapRef = useRef<HTMLDivElement | null>(null);
  // Selection rect in DISPLAYED (CSS-pixel) coordinates relative to the image.
  const [sel, setSel] = useState<Rect | null>(null);
  const dragging = useRef<{ startX: number; startY: number } | null>(null);

  // The displayed image scales to fit a max width; height follows aspect ratio.
  // We read the actual rendered size at confirm time from the element rect, so
  // the selection -> source mapping uses the true on-screen dimensions.
  function localPoint(e: React.MouseEvent): { x: number; y: number } {
    const el = imgWrapRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: clampNum(e.clientX - r.left, 0, r.width),
      y: clampNum(e.clientY - r.top, 0, r.height),
    };
  }

  function onMouseDown(e: React.MouseEvent): void {
    e.preventDefault();
    const p = localPoint(e);
    dragging.current = { startX: p.x, startY: p.y };
    setSel({ x: p.x, y: p.y, width: 0, height: 0 });
  }
  function onMouseMove(e: React.MouseEvent): void {
    if (!dragging.current) return;
    const p = localPoint(e);
    const { startX, startY } = dragging.current;
    setSel({
      x: Math.min(startX, p.x),
      y: Math.min(startY, p.y),
      width: Math.abs(p.x - startX),
      height: Math.abs(p.y - startY),
    });
  }
  function endDrag(): void {
    dragging.current = null;
  }

  const hasSelection = sel !== null && sel.width > 4 && sel.height > 4;

  function confirm(): void {
    const el = imgWrapRef.current;
    if (!el || !sel) return;
    const r = el.getBoundingClientRect();
    onConfirm(sel, r.width, r.height);
  }

  return (
    <div style={{ margin: "4px 0 2px" }}>
      {note && (
        <div
          style={{
            padding: "10px 12px",
            marginBottom: 10,
            border: "1px solid rgba(255,107,107,0.4)",
            background: "rgba(255,107,107,0.06)",
            color: "var(--danger, #ff6b6b)",
            fontFamily: "var(--font-display)",
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          {note}
        </div>
      )}
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 11,
          letterSpacing: 0.5,
          color: "var(--text-2)",
          marginBottom: 8,
        }}
      >
        Drag a box around the objectives + reward (exclude the right-hand
        DETAILS column), then “Read selection”. This calibrates the region for
        next time. Captured at {sourceWidth}×{sourceHeight}px.
      </div>
      <div
        ref={imgWrapRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        style={{
          position: "relative",
          display: "block",
          width: "100%",
          maxHeight: "55vh",
          overflow: "hidden",
          border: "1px solid var(--border-strong)",
          cursor: "crosshair",
          userSelect: "none",
          lineHeight: 0,
        }}
      >
        <img
          src={dataUrl}
          alt="Captured screen — drag to select the contract region"
          draggable={false}
          style={{
            display: "block",
            width: "100%",
            height: "auto",
            pointerEvents: "none",
          }}
        />
        {sel && (sel.width > 0 || sel.height > 0) && (
          <div
            style={{
              position: "absolute",
              left: sel.x,
              top: sel.y,
              width: sel.width,
              height: sel.height,
              border: "2px solid var(--primary)",
              background: "rgba(0, 200, 220, 0.12)",
              pointerEvents: "none",
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
            }}
          />
        )}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          marginTop: 12,
        }}
      >
        <button
          className="sc-ghost-btn"
          onClick={() => setSel(null)}
          disabled={!hasSelection}
          style={ghostBtn(hasSelection)}
        >
          Clear selection
        </button>
        <button
          className="sc-primary-btn"
          onClick={confirm}
          disabled={!hasSelection}
          style={primaryBtn(hasSelection)}
        >
          READ SELECTION
        </button>
      </div>
    </div>
  );
}

/** Clamp `n` into [lo, hi] (local mouse-coordinate helper). */
function clampNum(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

// ---------------------------------------------------------------------------
// Review body — editable fields + target selector + raw-text disclosure
// ---------------------------------------------------------------------------

function ReviewBody({
  objectives,
  reward,
  setReward,
  ocrTitle,
  confidence,
  rawText,
  showRaw,
  setShowRaw,
  missions,
  targetId,
  setTargetId,
  preTargeted,
  onUpdateObjective,
  onRemoveObjective,
}: {
  objectives: ReviewObjective[];
  reward: number | null;
  setReward: (n: number | null) => void;
  /** The OCR'd contract title (cleaned), or null when none was read. */
  ocrTitle: string | null;
  confidence: number;
  rawText: string;
  showRaw: boolean;
  setShowRaw: (b: boolean) => void;
  missions: Mission[];
  targetId: string | null;
  setTargetId: (id: string | null) => void;
  /**
   * True when the dropdown was PRE-TARGETED to a specific mission by the caller
   * (the per-mission "OCR Capture" button or a confident auto correlation) and
   * the user hasn't changed it. Drives a small "pre-targeted" hint so the chosen
   * mission is obvious; the dropdown stays fully changeable.
   */
  preTargeted: boolean;
  onUpdateObjective: (i: number, p: Partial<ReviewObjective>) => void;
  onRemoveObjective: (i: number) => void;
}): React.JSX.Element {
  // Count objectives whose SCU came back unreadable (parser's fillable
  // placeholder: scu === null). We surface this as a banner so the user fills the
  // amount BEFORE applying instead of writing a misleading 0. Each such row also
  // highlights its empty SCU field (see ObjectiveRow).
  const unreadableScuCount = objectives.filter((o) => o.scu == null).length;

  return (
    <>
      {/* OCR-read contract title — shown read-only so the user can see what was
          read (and why a mission may have been pre-selected below). When no
          title was read we show a muted note instead of an empty field. */}
      <label style={fieldLabel}>CONTRACT TITLE (read by OCR)</label>
      <div
        style={{
          padding: "8px 10px",
          marginBottom: 4,
          border: "1px solid var(--border-strong)",
          background: "var(--bg, rgba(0,0,0,0.3))",
          color: ocrTitle ? "var(--text-bright)" : "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.4,
          wordBreak: "break-word",
        }}
      >
        {ocrTitle || "no title detected"}
      </div>

      {/* reward — moved to the TOP (was below the objectives) */}
      <label style={fieldLabel}>REWARD (aUEC)</label>
      <input
        type="number"
        value={reward ?? ""}
        placeholder="not detected"
        onChange={(e) =>
          setReward(e.target.value === "" ? null : Number(e.target.value))
        }
        style={inputStyle}
      />

      <div style={{ ...metaRow, marginTop: 12 }}>
        <span>OCR confidence (overall)</span>
        <ConfidenceChip score={confidence} />
      </div>

      {unreadableScuCount > 0 && (
        <div
          role="status"
          style={{
            padding: "10px 12px",
            margin: "12px 0 0",
            border: "1px solid rgba(224,160,52,0.5)",
            background: "rgba(224,160,52,0.08)",
            color: "var(--warning, #e0a034)",
            fontFamily: "var(--font-display)",
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          {unreadableScuCount === 1
            ? "1 objective’s SCU couldn’t be read"
            : `${unreadableScuCount} objectives’ SCU couldn’t be read`}{" "}
          — fill the highlighted amount before applying so it isn’t saved as 0.
        </div>
      )}

      {objectives.length === 0 ? (
        <div
          style={{
            padding: "14px 12px",
            margin: "12px 0",
            border: "1px solid var(--border-strong)",
            color: "var(--text-2)",
            fontFamily: "var(--font-display)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          No objectives recognized. Make sure the contract screen is fully
          visible and try Recapture, or enter the legs manually in the detail
          panel.
        </div>
      ) : (
        <div style={{ margin: "12px 0", display: "grid", gap: 10 }}>
          {objectives.map((o, i) => (
            <ObjectiveRow
              key={i}
              objective={o}
              onChange={(p) => onUpdateObjective(i, p)}
              onRemove={() => onRemoveObjective(i)}
            />
          ))}
        </div>
      )}

      {/* target mission selector — the SINGLE dropdown, after the objectives.
          Defaults to an empty placeholder so the APPLY button stays disabled
          until the user deliberately picks a mission (or an auto pre-target).
          When PRE-TARGETED (per-mission capture button / confident auto), the
          dropdown is seeded to that mission and a hint makes it obvious — but it
          stays fully changeable (escape hatch); it does NOT auto-apply. */}
      <label style={fieldLabel}>APPLY TO</label>
      {preTargeted && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            margin: "0 0 6px",
            fontFamily: "var(--font-display)",
            fontSize: 11,
            lineHeight: 1.4,
            color: "var(--primary)",
          }}
        >
          <span aria-hidden="true">📌</span>
          <span>
            Pre-targeted to this mission. You can change it below before
            applying.
          </span>
        </div>
      )}
      <select
        value={targetId ?? ""}
        onChange={(e) => setTargetId(e.target.value || null)}
        aria-label="Apply to mission"
        style={{
          ...selectStyle,
          ...(preTargeted ? { borderColor: "var(--primary)" } : null),
        }}
      >
        {missions.length === 0 ? (
          <option value="">No active missions</option>
        ) : (
          <option value="">Select a mission…</option>
        )}
        {missions.map((m) => (
          <option key={m.id} value={m.id}>
            {m.title || m.id}
          </option>
        ))}
      </select>

      {/* raw-text disclosure */}
      <button
        className="sc-ghost-btn"
        onClick={() => setShowRaw(!showRaw)}
        style={{
          ...ghostBtn(true),
          marginTop: 14,
          fontSize: 11,
          padding: "6px 10px",
        }}
      >
        {showRaw ? "Hide" : "Show"} raw OCR text
      </button>
      {showRaw && (
        <pre
          style={{
            marginTop: 8,
            padding: 10,
            maxHeight: 140,
            overflow: "auto",
            background: "var(--bg, rgba(0,0,0,0.35))",
            border: "1px solid var(--border)",
            color: "var(--text-2)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            lineHeight: 1.4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {rawText || "(empty)"}
        </pre>
      )}
    </>
  );
}

function ObjectiveRow({
  objective,
  onChange,
  onRemove,
}: {
  objective: ReviewObjective;
  onChange: (p: Partial<ReviewObjective>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        border: "1px solid var(--border-strong)",
        padding: 10,
        display: "grid",
        gap: 8,
        background: "var(--bg, rgba(0,0,0,0.25))",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <select
          value={objective.kind}
          onChange={(e) =>
            onChange({ kind: e.target.value as "pickup" | "dropoff" })
          }
          style={{ ...selectStyle, width: 120, marginBottom: 0 }}
        >
          <option value="dropoff">Deliver</option>
          <option value="pickup">Collect</option>
        </select>
        {/* SCU. When unreadable (parser placeholder: scu === null) we show an
            EMPTY, highlighted field — never a misleading 0 — so the user fills
            the real amount before applying. */}
        <input
          type="number"
          value={objective.scu ?? ""}
          placeholder={objective.scu == null ? "SCU?" : "SCU"}
          onChange={(e) =>
            onChange({
              scu: e.target.value === "" ? null : Number(e.target.value),
            })
          }
          aria-invalid={objective.scu == null}
          title={
            objective.scu == null
              ? "SCU couldn’t be read — enter the amount before applying"
              : undefined
          }
          style={{
            ...inputStyle,
            width: 90,
            marginBottom: 0,
            ...(objective.scu == null
              ? {
                  borderColor: "var(--warning, #e0a034)",
                  background: "rgba(224,160,52,0.1)",
                }
              : null),
          }}
        />
        <span style={{ flex: 1 }} />
        <button
          className="sc-ghost-btn"
          onClick={onRemove}
          title="Remove this objective"
          style={{ ...ghostBtn(true), padding: "4px 8px", fontSize: 14 }}
        >
          ✕
        </button>
      </div>
      <FieldWithScore
        label="Commodity"
        value={objective.commodity}
        score={objective.commodityScore}
        onChange={(v) => onChange({ commodity: v, commodityScore: 0 })}
      />
      <FieldWithScore
        label={objective.kind === "pickup" ? "From" : "To"}
        value={objective.location}
        score={objective.locationScore}
        onChange={(v) => onChange({ location: v, locationScore: 0 })}
      />
    </div>
  );
}

function FieldWithScore({
  label,
  value,
  score,
  onChange,
}: {
  label: string;
  value: string;
  score: number;
  onChange: (v: string) => void;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          width: 78,
          flex: "none",
          fontFamily: "var(--font-display)",
          fontSize: 10,
          letterSpacing: 1,
          color: "var(--muted)",
        }}
      >
        {label.toUpperCase()}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, marginBottom: 0, flex: 1 }}
      />
      {score > 0 && <ConfidenceChip score={score} />}
    </div>
  );
}

function ConfidenceChip({ score }: { score: number }): React.JSX.Element {
  // 3 bands: high (>=0.85), medium (>=0.6), low — color-coded so a weak match
  // visually nudges the user to double-check before applying.
  const pct = Math.round(score * 100);
  const color =
    score >= 0.85
      ? "var(--success, #54e08a)"
      : score >= 0.6
        ? "var(--primary)"
        : "var(--danger, #ff6b6b)";
  return (
    <span
      title="Match confidence"
      style={{
        flex: "none",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color,
        border: `1px solid ${color}`,
        padding: "1px 5px",
      }}
    >
      {pct}%
    </span>
  );
}

function ResultBanner({
  ok,
  text,
}: {
  ok: boolean;
  text: string;
}): React.JSX.Element {
  return (
    <div
      style={{
        padding: "12px 14px",
        border: `1px solid ${
          ok ? "rgba(84,224,138,0.35)" : "rgba(255,107,107,0.4)"
        }`,
        background: ok ? "rgba(84,224,138,0.06)" : "rgba(255,107,107,0.06)",
        color: ok ? "var(--success)" : "var(--danger)",
        fontFamily: "var(--font-display)",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      {ok ? "✓ " : "✗ "}
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared inline styles (token-driven)
// ---------------------------------------------------------------------------

const fieldLabel: React.CSSProperties = {
  display: "block",
  fontFamily: "var(--font-display)",
  fontSize: 10,
  letterSpacing: 1.5,
  color: "var(--muted)",
  margin: "10px 0 5px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  background: "var(--bg, rgba(0,0,0,0.3))",
  border: "1px solid var(--border-strong)",
  color: "var(--text-bright)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  outline: "none",
  marginBottom: 4,
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
};

const metaRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontFamily: "var(--font-display)",
  fontSize: 11,
  color: "var(--text-2)",
};

function ghostBtn(enabled: boolean): React.CSSProperties {
  return {
    padding: "9px 16px",
    background: "transparent",
    border: "1px solid var(--border-strong)",
    color: enabled ? "var(--text-2)" : "var(--muted)",
    fontFamily: "var(--font-display)",
    fontWeight: 600,
    fontSize: 12,
    cursor: enabled ? "pointer" : "not-allowed",
  };
}

function primaryBtn(enabled: boolean): React.CSSProperties {
  return {
    padding: "9px 18px",
    background: enabled ? "var(--primary)" : "var(--border)",
    border: `1px solid ${enabled ? "var(--primary)" : "var(--border-strong)"}`,
    color: enabled ? "#04181a" : "var(--muted)",
    fontFamily: "var(--font-display)",
    fontWeight: 700,
    fontSize: 12,
    letterSpacing: 1,
    cursor: enabled ? "pointer" : "not-allowed",
  };
}
