// ============================================================================
// ocrManualMission.ts — PURE OCR → manual-mission draft mapping (Phase F)
// ----------------------------------------------------------------------------
// EXPERIMENTAL. Supports the "OCR into a NEW manual mission" entry in the Manual
// Add flow: a contract the game never tracked is OCR'd, reviewed, and on Apply a
// brand-new manual mission is created from it.
//
// This module is the PURE part of that wiring: it maps the reviewed OCR result
// (its title) onto the {@link ManualMissionInput} shape the existing
// `addMission` action consumes. It deliberately produces a draft with EMPTY legs
// — the reviewed objectives are inserted AFTERWARD via the existing `applyOcr`
// merge/convergence path so they go through the same SCU/null hardening as every
// other OCR apply (on a legless mission every objective takes the fresh-insert
// branch, which is exactly what we want for a never-tracked contract).
//
// Kept PURE + dependency-free so the title-resolution + draft-shape rules are
// unit-testable without a renderer or a DB. The renderer just calls
// `buildManualMissionDraft` then `addMission(draft)` → `applyOcr(id, objectives)`.
// ============================================================================

import type { ManualMissionInput, MissionStatus } from "./types";

/** Default title when OCR read no usable contract title. */
export const DEFAULT_OCR_MISSION_TITLE = "OCR Captured Contract";

/**
 * Resolve the title for a manual mission created from an OCR capture. Trims the
 * OCR-read title; when it's null/blank, falls back to a clear default so the new
 * mission is never created with an empty (unsavable) title. PURE.
 */
export function resolveManualMissionTitle(ocrTitle: string | null): string {
  const trimmed = (ocrTitle ?? "").trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_OCR_MISSION_TITLE;
}

/**
 * Build the {@link ManualMissionInput} draft for a NEW manual mission created
 * from an OCR capture. Legs are intentionally EMPTY — the reviewed objectives
 * are applied via the existing `applyOcr` path after creation (so the SCU/null
 * hardening + convergence rules run unchanged). The reward is NOT part of this
 * draft (the manual-create payload has no reward field); the caller applies it
 * via `updateMission(id, { reward })`, mirroring the existing OCR apply flow.
 *
 * @param ocrTitle  The reviewed/OCR-read contract title (or null when none).
 * @param status    Initial status for the new mission (default "accepted").
 * @param giver     Optional giver/company string (default "" = none).
 */
export function buildManualMissionDraft(
  ocrTitle: string | null,
  status: MissionStatus = "accepted",
  giver = "",
): ManualMissionInput {
  return {
    title: resolveManualMissionTitle(ocrTitle),
    giver,
    status,
    legs: [],
  };
}
