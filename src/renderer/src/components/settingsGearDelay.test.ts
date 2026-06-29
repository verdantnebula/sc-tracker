// ============================================================================
// settingsGearDelay.test.ts — pure value<->option mapping for the Auto-OCR
// settle-delay dropdown (SettingsGear). Covers only the PURE helpers exported
// from SettingsGear.tsx (no rendering): the preset list and the snap function
// that picks the closest valid option for an arbitrary saved value. The timer
// behavior itself lives in the AutoOcrCapture React component (no jsdom test
// harness here), so this file deliberately tests only the deterministic mapping.
// ============================================================================

import { describe, expect, it } from "vitest";

import {
  AUTO_OCR_DELAY_OPTIONS,
  snapAutoOcrDelayToOption,
} from "./SettingsGear";

describe("AUTO_OCR_DELAY_OPTIONS", () => {
  it("offers exactly None/0.5s/1s/1.5s mapped to 0/500/1000/1500", () => {
    expect(AUTO_OCR_DELAY_OPTIONS.map((o) => o.ms)).toEqual([
      0, 500, 1000, 1500,
    ]);
  });

  it("every option has a non-empty label", () => {
    for (const opt of AUTO_OCR_DELAY_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });
});

describe("snapAutoOcrDelayToOption", () => {
  it("returns an exact preset value unchanged", () => {
    expect(snapAutoOcrDelayToOption(0)).toBe(0);
    expect(snapAutoOcrDelayToOption(500)).toBe(500);
    expect(snapAutoOcrDelayToOption(1000)).toBe(1000);
    expect(snapAutoOcrDelayToOption(1500)).toBe(1500);
  });

  it("snaps an out-of-band saved value to the closest preset", () => {
    // Hand-edited settings.json could persist a non-preset (still clamped) value.
    expect(snapAutoOcrDelayToOption(300)).toBe(500); // closer to 500 than 0
    expect(snapAutoOcrDelayToOption(200)).toBe(0); // closer to 0 than 500
    expect(snapAutoOcrDelayToOption(800)).toBe(1000); // closer to 1000 than 500
    expect(snapAutoOcrDelayToOption(1400)).toBe(1500);
    expect(snapAutoOcrDelayToOption(3000)).toBe(1500); // clamps to the max preset
  });

  it("the dropdown's selected value is always one of the offered options", () => {
    const valid = new Set(AUTO_OCR_DELAY_OPTIONS.map((o) => o.ms));
    for (const ms of [0, 137, 250, 500, 999, 1499, 99999, -10]) {
      expect(valid.has(snapAutoOcrDelayToOption(ms))).toBe(true);
    }
  });
});
