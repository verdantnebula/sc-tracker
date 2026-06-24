import { describe, it, expect } from "vitest";
import { shouldRunAutoUpdate, clampPercent, versionFrom } from "./autoUpdate";

// Pure helpers for the NON-FORCED auto-updater. The electron-updater wiring
// itself (events, quitAndInstall) needs a real packaged Electron app + a release
// feed, so it is out of scope for a unit test; these lock down the gating + the
// data coercion the renderer banner depends on.

describe("shouldRunAutoUpdate", () => {
  it("runs only when packaged AND the user left checks enabled", () => {
    expect(shouldRunAutoUpdate(true, true)).toBe(true);
  });

  it("never runs in dev / unpackaged, even with checks enabled", () => {
    // The decisive guard: a dev run has no release feed/installer, so we no-op.
    expect(shouldRunAutoUpdate(false, true)).toBe(false);
  });

  it("never runs when the user disabled update checks", () => {
    expect(shouldRunAutoUpdate(true, false)).toBe(false);
  });

  it("is false when both are off", () => {
    expect(shouldRunAutoUpdate(false, false)).toBe(false);
  });
});

describe("clampPercent", () => {
  it("rounds a fractional percent to an integer", () => {
    expect(clampPercent(42.7)).toBe(43);
  });

  it("clamps below 0 and above 100", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
  });

  it("collapses non-finite / garbage to 0", () => {
    // Number.isFinite(Infinity) is false, so Infinity is treated as garbage -> 0
    // (we never trust a raw percent; only a finite number passes through).
    expect(clampPercent(NaN)).toBe(0);
    expect(clampPercent(Infinity)).toBe(0);
    expect(clampPercent(-Infinity)).toBe(0);
    expect(clampPercent("nope")).toBe(0);
    expect(clampPercent(undefined)).toBe(0);
    expect(clampPercent(null)).toBe(0);
  });

  it("passes through clean boundary values", () => {
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(100)).toBe(100);
  });
});

describe("versionFrom", () => {
  it("extracts a string version from an UpdateInfo-ish object", () => {
    expect(versionFrom({ version: "2.3.0" })).toBe("2.3.0");
  });

  it("returns '' for a missing / non-string version", () => {
    expect(versionFrom({})).toBe("");
    expect(versionFrom({ version: 23 })).toBe("");
    expect(versionFrom(null)).toBe("");
    expect(versionFrom(undefined)).toBe("");
    expect(versionFrom("2.3.0")).toBe("");
  });
});
