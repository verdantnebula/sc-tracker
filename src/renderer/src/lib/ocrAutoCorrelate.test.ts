// ============================================================================
// ocrAutoCorrelate.test.ts — the PURE Auto OCR Capture correlation reducer.
// ----------------------------------------------------------------------------
// REVIEW-FIRST policy (Phase-3 rework): the reducer's outcome is "surface this
// capture for human review", NOT "apply it". Coverage:
//   - direct missionId resolve -> ready now, with a CONFIDENT pre-target;
//   - fallback (time+name) match -> ready now, but NO pre-target (empty target);
//   - settle-debounce gating (un-correlated: wait, then surface with empty target);
//   - surface ONCE (reviewedOnce) — never re-open a second review for one entry;
//   - expiry after the TTL (surfaced or not);
//   - fallback NON-match when title differs / ts too far.
// All inputs are explicit (pending + missions + now), so timing is deterministic.
// ============================================================================

import { describe, it, expect } from "vitest";
import type { Mission, Leg, OcrApplyObjective } from "@shared/types";
import {
  reconcilePending,
  resolvePending,
  resolveConfident,
  AUTO_OCR_DEFAULTS,
  type PendingApply,
} from "./ocrAutoCorrelate";

// --- builders ---------------------------------------------------------------

function leg(id: string, missionId: string): Leg {
  return {
    id,
    missionId,
    kind: "dropoff",
    commodity: "Laranite",
    scuTotal: 10,
    scuDelivered: 0,
    location: "Somewhere",
    completed: false,
  };
}

function mission(over: Partial<Mission> & { id: string }): Mission {
  return {
    id: over.id,
    title: over.title ?? "Medium Cargo Haul",
    giver: over.giver ?? "Some_Hauling",
    variant: over.variant ?? "A_TO_B",
    grade: over.grade ?? "UNKNOWN",
    status: over.status ?? "accepted",
    payout: over.payout ?? null,
    payoutConfidence: over.payoutConfidence ?? "unknown",
    reward: over.reward ?? null,
    source: over.source ?? "log",
    acceptedAt: over.acceptedAt ?? 1_000,
    completedAt: over.completedAt ?? null,
    notes: over.notes ?? "",
    legs: over.legs ?? [],
  };
}

const OBJS: OcrApplyObjective[] = [
  { kind: "dropoff", commodity: "Laranite", scu: 10, location: "Port Olisar" },
];

function pending(over: Partial<PendingApply> = {}): PendingApply {
  return {
    missionId: over.missionId ?? "m1",
    title: over.title ?? "Medium Cargo Haul",
    ts: over.ts ?? 1_000,
    objectives: over.objectives ?? OBJS,
    enqueuedAt: over.enqueuedAt ?? 0,
    reviewedOnce: over.reviewedOnce ?? false,
  };
}

// --- resolveConfident (direct-only) -----------------------------------------

describe("resolveConfident", () => {
  it("resolves a DIRECT missionId match (confident)", () => {
    const missions = [mission({ id: "m1" }), mission({ id: "m2" })];
    expect(resolveConfident(pending({ missionId: "m2" }), missions)?.id).toBe(
      "m2",
    );
  });

  it("returns null when the missionId is absent (a fallback isn't confident)", () => {
    const missions = [
      mission({ id: "other", title: "Medium Cargo Haul", acceptedAt: 1_000 }),
    ];
    expect(
      resolveConfident(pending({ missionId: "missing" }), missions),
    ).toBeNull();
  });
});

// --- resolvePending (direct + fallback readiness) ---------------------------

describe("resolvePending", () => {
  const win = AUTO_OCR_DEFAULTS.fallbackWindowMs;

  it("resolves DIRECTLY by missionId when present", () => {
    const missions = [mission({ id: "m1" }), mission({ id: "m2" })];
    const r = resolvePending(pending({ missionId: "m2" }), missions, win);
    expect(r?.id).toBe("m2");
  });

  it("falls back to time+name when the missionId is absent", () => {
    const missions = [
      mission({ id: "other", title: "Medium Cargo Haul", acceptedAt: 1_200 }),
    ];
    const r = resolvePending(
      pending({ missionId: "missing", title: "Medium Cargo Haul", ts: 1_000 }),
      missions,
      win,
    );
    expect(r?.id).toBe("other");
  });

  it("fallback is case/whitespace-insensitive on title", () => {
    const missions = [
      mission({ id: "x", title: "  medium   CARGO haul ", acceptedAt: 1_000 }),
    ];
    const r = resolvePending(
      pending({ missionId: "missing", title: "Medium Cargo Haul", ts: 1_000 }),
      missions,
      win,
    );
    expect(r?.id).toBe("x");
  });

  it("fallback picks the SOONEST matching mission by accept time", () => {
    const missions = [
      mission({ id: "far", title: "Cargo Haul", acceptedAt: 1_000 + 8_000 }),
      mission({ id: "near", title: "Cargo Haul", acceptedAt: 1_000 + 500 }),
    ];
    const r = resolvePending(
      pending({ missionId: "missing", title: "Cargo Haul", ts: 1_000 }),
      missions,
      win,
    );
    expect(r?.id).toBe("near");
  });

  it("does NOT fallback-match when the title differs", () => {
    const missions = [
      mission({ id: "x", title: "A Different Haul", acceptedAt: 1_000 }),
    ];
    const r = resolvePending(
      pending({ missionId: "missing", title: "Medium Cargo Haul", ts: 1_000 }),
      missions,
      win,
    );
    expect(r).toBeNull();
  });

  it("does NOT fallback-match when the accept ts is outside the window", () => {
    const missions = [
      mission({
        id: "x",
        title: "Cargo Haul",
        acceptedAt: 1_000 + win + 1, // just past the window
      }),
    ];
    const r = resolvePending(
      pending({ missionId: "missing", title: "Cargo Haul", ts: 1_000 }),
      missions,
      win,
    );
    expect(r).toBeNull();
  });
});

// --- reconcilePending (surface gating, pre-target, once-only, expiry) --------

describe("reconcilePending", () => {
  it("surfaces immediately with a CONFIDENT pre-target on a direct match", () => {
    const p = pending({ missionId: "m1", enqueuedAt: 0 });
    const missions = [mission({ id: "m1", legs: [leg("L1", "m1")] })];
    const res = reconcilePending([p], missions, 10);
    expect(res.review).toHaveLength(1);
    expect(res.review[0].preselectMissionId).toBe("m1");
    expect(res.review[0].objectives).toEqual(OBJS);
    expect(res.review[0].pending.reviewedOnce).toBe(true);
    expect(res.keep).toHaveLength(1);
    expect(res.expired).toHaveLength(0);
  });

  it("surfaces immediately even when the direct mission has NO legs yet", () => {
    // Review-first doesn't need legs — the human reviews; applyOcr (on Apply)
    // fills placeholders or inserts. A confident id is enough to surface + target.
    const p = pending({ missionId: "m1", enqueuedAt: 0 });
    const legless = [mission({ id: "m1", legs: [] })];
    const res = reconcilePending([p], legless, 10);
    expect(res.review).toHaveLength(1);
    expect(res.review[0].preselectMissionId).toBe("m1");
  });

  it("surfaces a fallback-correlated entry but with NO pre-target (empty)", () => {
    const p = pending({
      missionId: "missing",
      title: "Cargo Haul",
      ts: 1_000,
      enqueuedAt: 0,
    });
    const missions = [
      mission({ id: "real", title: "Cargo Haul", acceptedAt: 1_100 }),
    ];
    const res = reconcilePending([p], missions, 10);
    expect(res.review).toHaveLength(1);
    // Ready (the mission exists) but a fallback isn't confident -> empty target.
    expect(res.review[0].preselectMissionId).toBeNull();
  });

  it("holds an un-correlated entry until the settle debounce, then surfaces empty", () => {
    // No mission matches by id or title -> can't pre-target. Wait for settle so
    // the mission can appear; if it never does, surface anyway (user picks).
    const p = pending({ missionId: "m1", title: "No Match", enqueuedAt: 0 });
    const missions = [mission({ id: "zzz", title: "Other" })];

    const early = reconcilePending(
      [p],
      missions,
      AUTO_OCR_DEFAULTS.settleMs - 1,
    );
    expect(early.review).toHaveLength(0);
    expect(early.keep).toHaveLength(1);
    expect(early.keep[0].reviewedOnce).toBe(false);

    const late = reconcilePending([p], missions, AUTO_OCR_DEFAULTS.settleMs);
    expect(late.review).toHaveLength(1);
    expect(late.review[0].preselectMissionId).toBeNull();
    expect(late.keep[0].reviewedOnce).toBe(true);
  });

  it("surfaces an entry ONCE — a later tick does not re-open a review", () => {
    const surfaced = pending({
      missionId: "m1",
      enqueuedAt: 0,
      reviewedOnce: true,
    });
    const missions = [mission({ id: "m1", legs: [leg("L1", "m1")] })];
    const res = reconcilePending([surfaced], missions, 500);
    expect(res.review).toHaveLength(0); // never re-surface
    expect(res.keep).toHaveLength(1); // kept within TTL (dedupe re-emits)
    expect(res.expired).toHaveLength(0);
  });

  it("expires an entry once the TTL elapses (and does not surface it)", () => {
    const p = pending({ missionId: "m1", enqueuedAt: 0, reviewedOnce: true });
    const missions = [mission({ id: "m1", legs: [leg("L1", "m1")] })];
    const res = reconcilePending([p], missions, AUTO_OCR_DEFAULTS.ttlMs);
    expect(res.review).toHaveLength(0);
    expect(res.keep).toHaveLength(0);
    expect(res.expired).toHaveLength(1);
    expect(res.expired[0].missionId).toBe("m1");
  });

  it("DEFERS a ready entry while a review is open, then surfaces it once after close", () => {
    // Regression: a confident entry becomes ready while a dialog is already open.
    // It must NOT be consumed/stamped/lost on the deferred tick — it stays ready in
    // keep[] — and a later reconcile with reviewOpen=false MUST surface it exactly
    // once (not silently routed to keep by a premature reviewedOnce stamp).
    const p = pending({ missionId: "m1", enqueuedAt: 0 });
    const missions = [mission({ id: "m1", legs: [leg("L1", "m1")] })];

    // Review open -> defer: nothing surfaces, entry retained UNSTAMPED + un-lost.
    const deferred = reconcilePending([p], missions, 10, true);
    expect(deferred.review).toHaveLength(0);
    expect(deferred.keep).toHaveLength(1);
    expect(deferred.keep[0].reviewedOnce).toBe(false);
    expect(deferred.expired).toHaveLength(0);

    // Dialog closed -> the deferred entry surfaces exactly once, with its pre-target.
    const after = reconcilePending(deferred.keep, missions, 20, false);
    expect(after.review).toHaveLength(1);
    expect(after.review[0].pending.missionId).toBe("m1");
    expect(after.review[0].preselectMissionId).toBe("m1");
    expect(after.keep).toHaveLength(1);
    expect(after.keep[0].reviewedOnce).toBe(true);

    // And it never re-surfaces on a subsequent tick.
    const next = reconcilePending(after.keep, missions, 30, false);
    expect(next.review).toHaveLength(0);
  });

  it("processes a mixed queue: surface one, hold one, expire one", () => {
    const surfaceMe = pending({ missionId: "a", enqueuedAt: 100 }); // direct match
    const expireMe = pending({ missionId: "c", enqueuedAt: 0 }); // past TTL
    const nowExpire = AUTO_OCR_DEFAULTS.ttlMs + 50;
    // holdMe: no id/title match AND just enqueued (pre-settle) -> held.
    const holdMe = pending({
      missionId: "b",
      title: "No Match",
      enqueuedAt: nowExpire - 1,
    });
    const missions = [
      mission({ id: "a", legs: [leg("L1", "a")] }),
      mission({ id: "zzz", title: "Other" }),
      mission({ id: "c", legs: [leg("L1", "c")] }),
    ];
    const res = reconcilePending(
      [surfaceMe, holdMe, expireMe],
      missions,
      nowExpire,
    );
    expect(res.review.map((r) => r.pending.missionId)).toEqual(["a"]);
    expect(res.review[0].preselectMissionId).toBe("a");
    expect(res.keep.map((k) => k.missionId).sort()).toEqual(["a", "b"]);
    expect(res.expired.map((e) => e.missionId)).toEqual(["c"]);
  });
});
