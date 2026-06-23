// ============================================================================
// OcrCaptureDialog — EXPERIMENTAL OCR contract capture review modal (Phase F)
// ----------------------------------------------------------------------------
// Opt-in fallback for when the game suppressed the New Objective log line. Flow:
//
//   capture FULL screen at native res (main desktopCapturer)
//     -> CROP: user drags a box around the objectives + reward on a scaled
//        preview, confirms "Read selection"
//     -> PREPROCESS the crop in a <canvas>: upscale ~3x, grayscale, threshold +
//        invert (dark text on light, which tesseract prefers)
//     -> OCR the processed crop (tesseract.js, MAIN process; PSM 6 + whitelist)
//     -> parse (pure parseContractOcr) -> fuzzy-match commodity/location
//     -> REVIEW: user confirms/corrects every field + picks the target mission
//     -> APPLY via window.api.updateMission (the existing, audited path)
//
// WHY MANUAL CROP + PREPROCESS: OCR'ing the full busy frame returned gibberish —
// the small stylized mobiGlas text was lost in the scene. Cropping to just the
// contract text and feeding tesseract a large, high-contrast binarized image is
// the difference between noise and a usable read.
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

import { useEffect, useMemo, useRef, useState } from "react";
import type { Mission, ReferenceData, MissionPatch } from "@shared/types";
import { fuzzyMatch } from "@shared/ocrMatch";
import {
  mapSelectionToSource,
  luminance,
  thresholdInvert,
  OCR_PREPROCESS_DEFAULTS,
  type Rect,
} from "@shared/ocrPreprocess";
import { pickDefaultTarget } from "../lib/selectors";
import { recognizeContract } from "../lib/ocrRunner";

/** A reviewable objective row: the OCR'd + fuzzy-matched values, all editable. */
interface ReviewObjective {
  kind: "pickup" | "dropoff";
  scu: number | null;
  commodity: string;
  /** 0..1 confidence of the commodity fuzzy match (0 when user-edited/no match). */
  commodityScore: number;
  location: string;
  locationScore: number;
}

type Phase =
  | { kind: "idle" }
  | { kind: "capturing" }
  /** Screenshot in hand; user drags a selection box over the scaled preview. */
  | {
      kind: "cropping";
      dataUrl: string;
      /** True source pixel dimensions of the captured frame. */
      sourceWidth: number;
      sourceHeight: number;
    }
  | { kind: "recognizing" }
  | { kind: "review"; confidence: number; rawText: string }
  | { kind: "applied" }
  | { kind: "error"; message: string };

export function OcrCaptureDialog({
  missions,
  reference,
  initialMissionId,
  onClose,
}: {
  /** Active missions the result can be applied to. */
  missions: Mission[];
  /** Bundled reference (fuzzy-match candidates for commodity/location). */
  reference: ReferenceData;
  /** Preselect this mission as the apply target (e.g. the suppressed one). */
  initialMissionId?: string | null;
  onClose: () => void;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [objectives, setObjectives] = useState<ReviewObjective[]>([]);
  const [reward, setReward] = useState<number | null>(null);
  // Auto-select the mission that needs OCR (most-recent "details missing"),
  // unless the caller preselected one. The user can still change it.
  const [targetId, setTargetId] = useState<string | null>(() =>
    pickDefaultTarget(missions, initialMissionId),
  );
  const [showRaw, setShowRaw] = useState(false);

  // Candidate name lists for fuzzy matching (computed once per reference).
  const commodityNames = useMemo(
    () => reference.commodities.map((c) => c.name),
    [reference.commodities],
  );
  const locationNames = useMemo(
    () =>
      reference.terminals.map((t) => t.displayname || t.name).filter(Boolean),
    [reference.terminals],
  );

  // The full-resolution screenshot, held in memory only (an offscreen <img> used
  // as the canvas crop source). Cleared on unmount; never persisted.
  const sourceImgRef = useRef<HTMLImageElement | null>(null);

  // Kick off capture immediately on mount — the user already opted in by opening
  // the dialog. (No auto-apply; this only READS the screen.)
  useEffect(() => {
    void runCapture();
    return () => {
      sourceImgRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * STEP 1: grab the full screen at native resolution and move to the crop step.
   * We decode the PNG into an offscreen <img> so the crop canvas has a pixel
   * source, and read its true dimensions for the selection -> source mapping.
   */
  async function runCapture(): Promise<void> {
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
      setPhase({
        kind: "cropping",
        dataUrl: cap.dataUrl,
        sourceWidth: img.naturalWidth,
        sourceHeight: img.naturalHeight,
      });
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
   * STEP 2-4: given the user's selection (in displayed/CSS-pixel space) and the
   * displayed image size, map it to source pixels, crop + preprocess via canvas
   * (upscale, grayscale, threshold+invert), then OCR the processed crop and run
   * the pure parser + fuzzy matcher. PSM defaults to "6" (uniform block).
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

    setPhase({ kind: "recognizing" });
    try {
      const processed = preprocessCrop(img, srcRect);
      const result = await recognizeContract(processed, psm);

      // Fuzzy-match each OCR'd objective against the bundled reference. The raw
      // span is the fallback when no candidate clears the threshold, so the user
      // still sees what OCR read and can correct it.
      const reviewed: ReviewObjective[] = result.contract.objectives.map(
        (o) => {
          const cm = fuzzyMatch(o.commodity, commodityNames);
          const lm = fuzzyMatch(o.location, locationNames);
          return {
            kind: o.kind,
            scu: o.scu,
            commodity: cm.value ?? o.commodity,
            commodityScore: cm.value ? cm.score : 0,
            location: lm.value ?? o.location,
            locationScore: lm.value ? lm.score : 0,
          };
        },
      );
      setObjectives(reviewed);
      setReward(result.contract.reward);
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

  const target = missions.find((m) => m.id === targetId) ?? null;
  const canApply =
    target !== null &&
    (objectives.length > 0 || reward !== null) &&
    phase.kind === "review";

  // Build the MissionPatch and apply via the EXISTING audited update path. We add
  // the reviewed objectives as new legs (addLegs) — the common case is a
  // suppressed mission missing its legs entirely — and set the reward if read.
  // The store stamps manual_override on these, protecting them from log replay.
  function apply(): void {
    if (!target) return;
    const patch: MissionPatch = {};
    if (objectives.length > 0) {
      patch.addLegs = objectives.map((o) => ({
        kind: o.kind,
        commodity: o.commodity,
        scuTotal: o.scu ?? 0,
        location: o.location.length > 0 ? o.location : null,
      }));
    }
    if (reward !== null) patch.reward = reward;
    void window.api
      .updateMission(target.id, patch)
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
          write to the log. Drag a box around the “Deliver … SCU …” objectives
          and the aUEC reward, then read the selection. OCR can misread the
          stylized font — check every field before applying. Nothing is changed
          until you press Apply.
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
            confidence={phase.confidence}
            rawText={phase.rawText}
            showRaw={showRaw}
            setShowRaw={setShowRaw}
            missions={missions}
            targetId={targetId}
            setTargetId={setTargetId}
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
          }}
        >
          <button
            className="sc-ghost-btn"
            onClick={() => void runCapture()}
            disabled={
              phase.kind === "capturing" || phase.kind === "recognizing"
            }
            style={ghostBtn(
              phase.kind !== "capturing" && phase.kind !== "recognizing",
            )}
          >
            ⟳ Recapture
          </button>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              className="sc-ghost-btn"
              onClick={onClose}
              style={ghostBtn(true)}
            >
              {phase.kind === "applied" ? "Close" : "Cancel"}
            </button>
            {phase.kind === "review" && (
              <button
                className="sc-primary-btn"
                onClick={apply}
                disabled={!canApply}
                style={primaryBtn(canApply)}
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
// Image helpers — capture decode + canvas crop/preprocess (renderer-only)
// ---------------------------------------------------------------------------

/** Decode a PNG data URL into an <img> (resolves once it has real dimensions). */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode the screenshot."));
    img.src = dataUrl;
  });
}

/**
 * Crop `srcRect` (in source pixels) from `img` and preprocess it for OCR:
 *   1. draw the crop upscaled ~3x (small glyphs -> large, readable),
 *   2. grayscale via perceptual luminance,
 *   3. threshold + invert -> dark text on light (what tesseract reads best).
 * Returns a PNG data URL. The only non-pure step (canvas getImageData) lives
 * here; the per-pixel math is the pure {@link luminance}/{@link thresholdInvert}.
 *
 * Defensive: throws a readable error if a 2D context can't be obtained, which the
 * caller turns into an on-screen message (the app never crashes).
 */
function preprocessCrop(img: HTMLImageElement, srcRect: Rect): string {
  const { scale, threshold } = OCR_PREPROCESS_DEFAULTS;
  const outW = Math.max(1, Math.round(srcRect.width * scale));
  const outH = Math.max(1, Math.round(srcRect.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D context unavailable for preprocessing.");

  // Draw the cropped source region scaled up to the full canvas.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    img,
    srcRect.x,
    srcRect.y,
    srcRect.width,
    srcRect.height,
    0,
    0,
    outW,
    outH,
  );

  // Grayscale + threshold + invert, in place.
  const image = ctx.getImageData(0, 0, outW, outH);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum = luminance(px[i], px[i + 1], px[i + 2]);
    const v = thresholdInvert(lum, threshold);
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// Crop step — scaled screenshot preview + drag-to-select rectangle overlay
// ---------------------------------------------------------------------------

function CropStep({
  dataUrl,
  sourceWidth,
  sourceHeight,
  onConfirm,
}: {
  dataUrl: string;
  sourceWidth: number;
  sourceHeight: number;
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
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 11,
          letterSpacing: 0.5,
          color: "var(--text-2)",
          marginBottom: 8,
        }}
      >
        Drag a box around the objectives + reward, then “Read selection”.
        Captured at {sourceWidth}×{sourceHeight}px.
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
  confidence,
  rawText,
  showRaw,
  setShowRaw,
  missions,
  targetId,
  setTargetId,
  onUpdateObjective,
  onRemoveObjective,
}: {
  objectives: ReviewObjective[];
  reward: number | null;
  setReward: (n: number | null) => void;
  confidence: number;
  rawText: string;
  showRaw: boolean;
  setShowRaw: (b: boolean) => void;
  missions: Mission[];
  targetId: string | null;
  setTargetId: (id: string | null) => void;
  onUpdateObjective: (i: number, p: Partial<ReviewObjective>) => void;
  onRemoveObjective: (i: number) => void;
}): React.JSX.Element {
  return (
    <>
      {/* target mission selector */}
      <label style={fieldLabel}>APPLY TO</label>
      <select
        value={targetId ?? ""}
        onChange={(e) => setTargetId(e.target.value || null)}
        style={selectStyle}
      >
        {missions.length === 0 && <option value="">No active missions</option>}
        {missions.map((m) => (
          <option key={m.id} value={m.id}>
            {m.title || m.id}
          </option>
        ))}
      </select>

      <div style={{ ...metaRow, marginTop: 12 }}>
        <span>OCR confidence (overall)</span>
        <ConfidenceChip score={confidence} />
      </div>

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

      {/* reward */}
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
        <input
          type="number"
          value={objective.scu ?? ""}
          placeholder="SCU"
          onChange={(e) =>
            onChange({
              scu: e.target.value === "" ? null : Number(e.target.value),
            })
          }
          style={{ ...inputStyle, width: 90, marginBottom: 0 }}
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
