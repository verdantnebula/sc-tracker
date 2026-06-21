// theme.test.ts — the mode -> theme-attribute mapping that drives the Drake
// (salvage) vs cyan (cargo) token swap. Pure logic + the single dataset side
// effect, both exercised without a real DOM (applyTheme takes an injectable root).
import { describe, it, expect } from "vitest";
import type { AppMode } from "@shared/types";
import { themeForMode, applyTheme } from "./theme";

describe("themeForMode", () => {
  it("maps cargo -> cargo", () => {
    expect(themeForMode("cargo")).toBe("cargo");
  });

  it("maps salvage -> salvage", () => {
    expect(themeForMode("salvage")).toBe("salvage");
  });

  it("defaults any unknown/corrupt value to cargo (never a missing theme)", () => {
    expect(themeForMode("wormhole" as AppMode)).toBe("cargo");
    expect(themeForMode(null)).toBe("cargo");
    expect(themeForMode(undefined)).toBe("cargo");
  });
});

describe("applyTheme", () => {
  it("writes data-mode=salvage on the injected root", () => {
    const root = { dataset: {} as { mode?: string } };
    const written = applyTheme("salvage", root);
    expect(written).toBe("salvage");
    expect(root.dataset.mode).toBe("salvage");
  });

  it("writes data-mode=cargo for cargo mode", () => {
    const root = { dataset: {} as { mode?: string } };
    applyTheme("cargo", root);
    expect(root.dataset.mode).toBe("cargo");
  });

  it("overwrites a previous mode attribute (switching back and forth)", () => {
    const root = { dataset: {} as { mode?: string } };
    applyTheme("salvage", root);
    applyTheme("cargo", root);
    expect(root.dataset.mode).toBe("cargo");
  });

  it("is a no-op (no throw) when there is no root element", () => {
    expect(() => applyTheme("salvage", null)).not.toThrow();
    expect(applyTheme("salvage", null)).toBe("salvage");
  });
});
