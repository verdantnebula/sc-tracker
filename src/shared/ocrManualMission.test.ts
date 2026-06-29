// ============================================================================
// ocrManualMission.test.ts — pure OCR → manual-mission draft mapping (Phase F)
// ----------------------------------------------------------------------------
// Sanitized synthetic strings only — no personal data, no real reference dump.
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  DEFAULT_OCR_MISSION_TITLE,
  buildManualMissionDraft,
  resolveManualMissionTitle,
} from "./ocrManualMission";

describe("resolveManualMissionTitle", () => {
  it("uses the OCR title when present", () => {
    expect(resolveManualMissionTitle("Bulk Cargo Haul")).toBe(
      "Bulk Cargo Haul",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(resolveManualMissionTitle("  Senior Rank Run  ")).toBe(
      "Senior Rank Run",
    );
  });

  it("falls back to the default when null", () => {
    expect(resolveManualMissionTitle(null)).toBe(DEFAULT_OCR_MISSION_TITLE);
  });

  it("falls back to the default when blank/whitespace", () => {
    expect(resolveManualMissionTitle("   ")).toBe(DEFAULT_OCR_MISSION_TITLE);
    expect(resolveManualMissionTitle("")).toBe(DEFAULT_OCR_MISSION_TITLE);
  });
});

describe("buildManualMissionDraft", () => {
  it("produces a draft with the resolved title and EMPTY legs", () => {
    const draft = buildManualMissionDraft("Deliver Run");
    expect(draft).toEqual({
      title: "Deliver Run",
      giver: "",
      status: "accepted",
      legs: [],
    });
  });

  it("always starts with empty legs (objectives applied later via applyOcr)", () => {
    expect(buildManualMissionDraft("anything").legs).toEqual([]);
  });

  it("uses the default title for a null OCR title", () => {
    expect(buildManualMissionDraft(null).title).toBe(DEFAULT_OCR_MISSION_TITLE);
  });

  it("honors an explicit status and giver", () => {
    const draft = buildManualMissionDraft("X", "in_progress", "ACME Hauling");
    expect(draft.status).toBe("in_progress");
    expect(draft.giver).toBe("ACME Hauling");
    expect(draft.legs).toEqual([]);
  });
});
