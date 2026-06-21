// ============================================================================
// diagnosticsReport.test.ts — pure builders for the "Collect Logs" export
// ----------------------------------------------------------------------------
// Covers the report's PURE pieces:
//   - isMissionEventLine / extractMissionEventLines: keep only mission-lifecycle
//     lines, apply the injected redactor, and cap to the last N.
//   - buildCapturedStateText: the "what the app captured" side, including the
//     status counts that surface an "N accepted, M stored" drop, and defensive
//     handling of malformed input.
//   - buildReportHeader: includes the user's description + environment.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  isMissionEventLine,
  extractMissionEventLines,
  buildCapturedStateText,
  buildSalvageStateText,
  buildReportHeader,
} from "./diagnosticsReport";
import type { Mission } from "@shared/types";

const identity = (s: string): string => s; // a no-op redactor for plumbing tests

describe("isMissionEventLine", () => {
  it("keeps mission-lifecycle lines", () => {
    expect(isMissionEventLine('"Contract Accepted: x" MissionId:[a]')).toBe(
      true,
    );
    expect(
      isMissionEventLine("<CLocalMissionPhaseMarker::CreateMarker> ..."),
    ).toBe(true);
    expect(isMissionEventLine("New Objective: Deliver 0/5 SCU ...")).toBe(true);
    expect(isMissionEventLine("<EndMission> CompletionType[Complete]")).toBe(
      true,
    );
    expect(isMissionEventLine("Awarded 12345 aUEC")).toBe(true);
  });

  it("drops unrelated chatter", () => {
    expect(isMissionEventLine("<2026> [Notice] some combat log line")).toBe(
      false,
    );
    expect(isMissionEventLine("")).toBe(false);
    // @ts-expect-error defensive
    expect(isMissionEventLine(null)).toBe(false);
  });
});

describe("extractMissionEventLines", () => {
  const log = [
    "noise line one",
    '"Contract Accepted:  Haul A" MissionId:[m1]',
    "more noise",
    "New Objective: Deliver 0/13 SCU of Ice to OutpostX ObjectiveId:[dropoff_1]",
    "<EndMission> MissionId[m1] CompletionType[Complete]",
    "trailing noise",
  ].join("\n");

  it("returns only the mission-event lines", () => {
    const out = extractMissionEventLines(log, identity);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("Contract Accepted");
    expect(out[1]).toContain("New Objective");
    expect(out[2]).toContain("EndMission");
  });

  it("applies the injected redactor to each kept line", () => {
    const redact = (s: string): string => s.replace(/m1/g, "<M>");
    const out = extractMissionEventLines(log, redact);
    expect(out.join("\n")).not.toContain("m1");
    expect(out.join("\n")).toContain("<M>");
  });

  it("caps to the last N lines", () => {
    const many = Array.from({ length: 10 }, (_, i) => `Awarded ${i} aUEC`).join(
      "\n",
    );
    const out = extractMissionEventLines(many, identity, 3);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("Awarded 7");
    expect(out[2]).toContain("Awarded 9");
  });

  it("returns [] for empty/garbage input", () => {
    expect(extractMissionEventLines("", identity)).toEqual([]);
    // @ts-expect-error defensive
    expect(extractMissionEventLines(null, identity)).toEqual([]);
  });
});

function mkMission(over: Partial<Mission>): Mission {
  return {
    id: over.id ?? "m",
    title: over.title ?? "",
    giver: over.giver ?? "",
    variant: over.variant ?? "A_TO_B",
    grade: over.grade ?? "SUPPLY",
    status: over.status ?? "accepted",
    payout: over.payout ?? null,
    payoutConfidence: over.payoutConfidence ?? "unknown",
    source: over.source ?? "log",
    acceptedAt: over.acceptedAt ?? null,
    completedAt: over.completedAt ?? null,
    notes: over.notes ?? "",
    legs: over.legs ?? [],
  };
}

describe("buildCapturedStateText", () => {
  it("reports the total count and per-status breakdown", () => {
    const text = buildCapturedStateText([
      mkMission({ id: "a", status: "accepted" }),
      mkMission({ id: "b", status: "complete" }),
      mkMission({ id: "c", status: "accepted" }),
    ]);
    expect(text).toContain("Total missions stored: 3");
    expect(text).toContain("accepted=2");
    expect(text).toContain("complete=1");
  });

  it("lists each mission with its id and leg summary", () => {
    const text = buildCapturedStateText([
      mkMission({
        id: "mission-xyz",
        title: "Big Haul",
        legs: [
          {
            id: "dropoff_1",
            missionId: "mission-xyz",
            kind: "dropoff",
            commodity: "Ice",
            scuTotal: 13,
            scuDelivered: 0,
            location: "OutpostX",
            completed: false,
          },
        ],
      }),
    ]);
    expect(text).toContain("mission mission-xyz");
    expect(text).toContain("Big Haul");
    expect(text).toContain("Ice");
    expect(text).toContain("0/13 SCU");
    expect(text).toContain("OutpostX");
    expect(text).toContain("dropoff_1");
  });

  it("handles an empty store and malformed input defensively", () => {
    expect(buildCapturedStateText([])).toContain("(no missions in the store)");
    // @ts-expect-error defensive
    expect(() => buildCapturedStateText(null)).not.toThrow();
    // @ts-expect-error defensive
    expect(() => buildCapturedStateText([{}, undefined])).not.toThrow();
  });
});

describe("buildSalvageStateText", () => {
  it("is empty when there are no runs, and summarizes when present", () => {
    expect(buildSalvageStateText([])).toBe("");
    const text = buildSalvageStateText([
      {
        id: "run1",
        startedAt: 0,
        completedAt: null,
        status: "active",
        crewSize: 2,
        notes: "",
        rmcScu: 40,
        cmatScu: 10,
        constructionScu: 0,
        stripped: [],
        wrecks: [],
      },
    ]);
    expect(text).toContain("Total salvage runs stored: 1");
    expect(text).toContain("run run1");
    expect(text).toContain("rmc=40");
  });
});

describe("buildReportHeader", () => {
  it("includes the description and environment", () => {
    const text = buildReportHeader({
      description: "accepted 5, only 1 showed up",
      generatedAt: "2026-06-20T12:00:00.000Z",
      appVersion: "1.2.3",
      electron: "33.4.11",
      platform: "win32",
      arch: "x64",
      mode: "cargo",
    });
    expect(text).toContain("accepted 5, only 1 showed up");
    expect(text).toContain("1.2.3");
    expect(text).toContain("33.4.11");
    expect(text).toContain("win32/x64");
    expect(text).toContain("Mode      : cargo");
  });

  it("falls back gracefully for a missing description", () => {
    // @ts-expect-error defensive
    const text = buildReportHeader({});
    expect(text).toContain("(no description provided)");
  });
});
