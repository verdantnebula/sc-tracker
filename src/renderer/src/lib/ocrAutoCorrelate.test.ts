// ============================================================================
// ocrAutoCorrelate.test.ts — the PURE Auto OCR Capture correlation reducer.
// ----------------------------------------------------------------------------
// Covers the leg-arrival race policy end to end:
//   - direct missionId resolve (with legs -> apply immediately);
//   - settle-debounce gating (correlated but legless: wait, then apply);
//   - idempotent re-apply within the TTL on later ticks;
//   - expiry after the TTL (applied or not);
//   - time+name fallback match (and NON-match when title differs / ts too far).
// All inputs are explicit (pending + missions + now), so timing is deterministic.
// ============================================================================

import { describe, it, expect } from "vitest";
import type { Mission, Leg, OcrApplyObjective } from "@shared/types";
import {
  reconcilePending,
  resolvePending,
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
    appliedOnce: over.appliedOnce ?? false,
    cueShown: over.cueShown,
  };
}

// --- resolvePending (direct + fallback) -------------------------------------

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

// --- reconcilePending (gating, re-apply, expiry) ----------------------------

describe("reconcilePending", () => {
  it("applies immediately when the direct mission already has legs", () => {
    const p = pending({ missionId: "m1", enqueuedAt: 0 });
    const missions = [mission({ id: "m1", legs: [leg("L1", "m1")] })];
    const res = reconcilePending([p], missions, 10);
    expect(res.apply).toHaveLength(1);
    expect(res.apply[0].missionId).toBe("m1");
    expect(res.apply[0].objectives).toEqual(OBJS);
    expect(res.apply[0].pending.appliedOnce).toBe(true);
    expect(res.keep).toHaveLength(1);
    expect(res.expired).toHaveLength(0);
  });

  it("holds a correlated-but-legless mission until the settle debounce", () => {
    const p = pending({ missionId: "m1", enqueuedAt: 0 });
    const legless = [mission({ id: "m1", legs: [] })];

    // Before settle: correlated but legless -> keep, no apply.
    const early = reconcilePending(
      [p],
      legless,
      AUTO_OCR_DEFAULTS.settleMs - 1,
    );
    expect(early.apply).toHaveLength(0);
    expect(early.keep).toHaveLength(1);
    expect(early.keep[0].appliedOnce).toBe(false);

    // At/after settle: apply even though still legless (markers suppressed).
    const late = reconcilePending([p], legless, AUTO_OCR_DEFAULTS.settleMs);
    expect(late.apply).toHaveLength(1);
    expect(late.apply[0].missionId).toBe("m1");
    expect(late.keep[0].appliedOnce).toBe(true);
  });

  it("keeps (no apply) while the mission is not correlatable yet", () => {
    const p = pending({ missionId: "m1", title: "No Match", enqueuedAt: 0 });
    // A mission exists but neither id nor title matches.
    const missions = [mission({ id: "zzz", title: "Other" })];
    const res = reconcilePending([p], missions, 10);
    expect(res.apply).toHaveLength(0);
    expect(res.keep).toHaveLength(1);
    expect(res.expired).toHaveLength(0);
  });

  it("re-applies (idempotent) on a later tick within the TTL once appliedOnce", () => {
    const applied = pending({
      missionId: "m1",
      enqueuedAt: 0,
      appliedOnce: true,
    });
    // Even legless + before settle, an already-applied entry re-applies so late
    // markers get reconciled (applyOcr is idempotent).
    const missions = [mission({ id: "m1", legs: [] })];
    const res = reconcilePending([applied], missions, 500);
    expect(res.apply).toHaveLength(1);
    expect(res.apply[0].pending.appliedOnce).toBe(true);
    expect(res.keep).toHaveLength(1);
  });

  it("expires an entry once the TTL elapses (and does not apply it)", () => {
    const p = pending({
      missionId: "m1",
      enqueuedAt: 0,
      appliedOnce: true,
    });
    const missions = [mission({ id: "m1", legs: [leg("L1", "m1")] })];
    const res = reconcilePending([p], missions, AUTO_OCR_DEFAULTS.ttlMs);
    expect(res.apply).toHaveLength(0);
    expect(res.keep).toHaveLength(0);
    expect(res.expired).toHaveLength(1);
    expect(res.expired[0].missionId).toBe("m1");
  });

  it("applies a fallback-resolved entry to the matched mission id", () => {
    const p = pending({
      missionId: "missing",
      title: "Cargo Haul",
      ts: 1_000,
      enqueuedAt: 0,
    });
    const missions = [
      mission({
        id: "real",
        title: "Cargo Haul",
        acceptedAt: 1_100,
        legs: [leg("L1", "real")],
      }),
    ];
    const res = reconcilePending([p], missions, 10);
    expect(res.apply).toHaveLength(1);
    expect(res.apply[0].missionId).toBe("real");
  });

  it("processes a mixed queue: apply one, hold one, expire one", () => {
    const applyMe = pending({ missionId: "a", enqueuedAt: 100 });
    const holdMe = pending({ missionId: "b", enqueuedAt: 100 }); // legless, pre-settle
    const expireMe = pending({ missionId: "c", enqueuedAt: 0 });
    const now = 100 + AUTO_OCR_DEFAULTS.settleMs - 1; // < settle for the @100 ones
    // expireMe enqueued at 0 -> now >= ttl only if now>=ttl; ensure that:
    const nowExpire = AUTO_OCR_DEFAULTS.ttlMs + 50;

    // Use a `now` past the TTL for expireMe but the @100 entries are then also
    // past settle; give 'a' legs (apply) and 'b' no legs but appliedOnce false
    // and well past settle (so it ALSO applies). To keep 'b' held, give it a
    // distinct enqueuedAt close to nowExpire.
    const holdMe2 = pending({
      missionId: "b",
      enqueuedAt: nowExpire - 1, // just enqueued -> pre-settle, legless -> hold
    });
    const missions = [
      mission({ id: "a", legs: [leg("L1", "a")] }),
      mission({ id: "b", legs: [] }),
      mission({ id: "c", legs: [leg("L1", "c")] }),
    ];
    const res = reconcilePending(
      [applyMe, holdMe2, expireMe],
      missions,
      nowExpire,
    );
    expect(res.apply.map((a) => a.missionId).sort()).toEqual(["a"]);
    expect(res.keep.map((k) => k.missionId).sort()).toEqual(["a", "b"]);
    expect(res.expired.map((e) => e.missionId)).toEqual(["c"]);
    // Silence the unused-binding warning for the illustrative `holdMe`.
    expect(holdMe.missionId).toBe("b");
    expect(now).toBeGreaterThan(0);
  });

  it("carries cueShown through untouched (host-owned field)", () => {
    const p = pending({
      missionId: "m1",
      enqueuedAt: 0,
      appliedOnce: true,
      cueShown: true,
    });
    const missions = [mission({ id: "m1", legs: [leg("L1", "m1")] })];
    const res = reconcilePending([p], missions, 10);
    expect(res.apply[0].pending.cueShown).toBe(true);
  });
});
