// RouteMapView.test.ts — unit tests for the pure node-height calc that drives
// dynamic drop-off card sizing. The component's SVG/interaction has no test
// harness; only the exported pure helper is covered here.
import { describe, it, expect } from "vitest";
import { mapNodeHeight } from "./RouteMapView";

// These mirror the constants in RouteMapView.tsx.
const HEADER_H = 44;
const BASE_H = 48;
const LINE_H = 15;
const PAD = 8;

describe("mapNodeHeight", () => {
  it("pure-source (not a sink) stays at base height regardless of count", () => {
    expect(mapNodeHeight(false, 0)).toBe(BASE_H);
    expect(mapNodeHeight(false, 5)).toBe(BASE_H);
  });

  it("a sink with zero incoming edges collapses to base height", () => {
    expect(mapNodeHeight(true, 0)).toBe(BASE_H);
  });

  it("a sink grows by one line per incoming edge", () => {
    expect(mapNodeHeight(true, 1)).toBe(HEADER_H + 1 * LINE_H + PAD);
    expect(mapNodeHeight(true, 3)).toBe(HEADER_H + 3 * LINE_H + PAD);
  });

  it("more incoming edges yield a taller card (monotonic)", () => {
    expect(mapNodeHeight(true, 2)).toBeGreaterThan(mapNodeHeight(true, 1));
  });
});
