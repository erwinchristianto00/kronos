import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFourBrainGatherInput, type FourBrainBindingDeps } from "../src/lib/four-brain-live-gather-bindings.js";
import { identityKey, rejectDuplicates, type EntryCandidateRaw } from "../src/lib/four-brain-live-gather.js";
import { staticAllocationContext } from "../src/lib/authority-contract.js";

/**
 * 2026-08-02 (four-brain-sourcing, point 3).
 *
 * Before this fix, EVERY CG open signal came from `variantMatrixOpenSignals()` — a separate shadow
 * tape (`CurrentGuardVariantMatrixObservation`) with its own synthetic ids that no real `PaperOrder`
 * ever carries verbatim. `allocationContextWithExactCortexPaperBridge` and
 * `attachExecutiveReviewToExactPaperOrder` both join on THE canonical persisted ownership triple
 * (`sourceObservationId`, `selectedLaneId`, `direction`), so those candidates could never attach to a
 * real Executive Review — not because the comparator was broken, but because the two sides were
 * comparing different id spaces.
 *
 * The fix sources CG candidates from two DISTINCT, explicitly tagged places:
 *   - "PAPER_ORDER_OWNED"     — real, currently-actionable PaperOrder rows; laneId/observationId are
 *                               order.selectedLaneId/order.sourceObservationId verbatim, so these are
 *                               attachable to a real Executive Review BY CONSTRUCTION.
 *   - "VARIANT_MATRIX_SHADOW" — the original vmStore shadow tape, kept for report-only Entry Brain
 *                               diagnostic coverage; structurally never attachable.
 *   - undefined/null          — legacy named-lane signals (SF/IM/RC/RCS/PWR/CE), untouched.
 *
 * This file tests the part of that fix that is a pure function of `FourBrainBindingDeps.openSignals`
 * → `FourBrainIdentity.sourceKind` (buildFourBrainGatherInput), plus the id-collision-avoidance claim
 * (a PAPER_ORDER_OWNED row and its VARIANT_MATRIX_SHADOW echo of the SAME underlying vmStore
 * observation carry different laneId strings, so they never look like duplicates to identityKey).
 * The app.ts wiring itself (reading peekPaperExecutionRouterStore(), filtering by paperStatus/
 * sourceType, and still calling variantMatrixOpenSignals() unchanged) is pinned by a source-level
 * guard, matching the established pattern in four-brain-sees-lanes-that-trade.test.ts.
 */
const NOW = 1_800_000_000_000;
const MIN = 60_000;

function baseDeps(o: Partial<FourBrainBindingDeps> = {}): FourBrainBindingDeps {
  return {
    instanceId: "test",
    nowMs: NOW,
    axisScore: null, axisAtMs: null, axisSlopePerHour: null,
    btcAtrPercentile: null, atrAtMs: null,
    advancersPct: null, breadthAtMs: null,
    sentiment: null, sentimentAtMs: null,
    safetyEvents: [],
    regimeRaw: "Bullish expansion",
    edgeMemory: {
      lookup: () => ({ avgNetR: 0.1, n: 40 }),
      verdict: () => ({ decision: "ALLOW_PROVEN" }),
      hasPositiveLane: () => true,
    },
    controllerBias: "LONG", convictionScore: 0.6, allowsLong: true, allowsShort: true,
    bestLaneReportForDirection: () => null,
    crowdAlignLong: null, crowdAtMs: null, kronosAgree: null, kronosAtMs: null,
    openSignals: [],
    maxSignalAgeMs: 50 * MIN,
    crowdingStateForSymbol: () => null,
    openPositions: [],
    markPriceForSymbol: () => ({ price: null, atMs: null }),
    cortexDecisionId: null, cortexFinalPctForLane: () => null, laneEligibleIncumbent: () => true,
    killLatched: false, killReason: null,
    ...o,
  } as FourBrainBindingDeps;
}

const cgSignal = (over: Partial<{
  laneId: string; symbol: string; direction: "LONG" | "SHORT"; observationId: string;
  openedAtMs: number; entryPrice: number; stopPrice: number;
  sourceKind: "PAPER_ORDER_OWNED" | "VARIANT_MATRIX_SHADOW";
}> = {}) => ({
  laneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
  symbol: "BTCUSDT",
  direction: "LONG" as const,
  observationId: "OID-1",
  openedAtMs: NOW - 5 * MIN,
  entryPrice: 100,
  stopPrice: 97,
  ...over,
});

describe("FourBrainIdentity.sourceKind threading", () => {
  it("PAPER_ORDER_OWNED survives into the entry candidate identity", () => {
    const got = buildFourBrainGatherInput(baseDeps({
      openSignals: [cgSignal({ sourceKind: "PAPER_ORDER_OWNED" })],
    }));
    expect(got.entryCandidatesRaw).toHaveLength(1);
    expect(got.entryCandidatesRaw[0]!.identity.sourceKind).toBe("PAPER_ORDER_OWNED");
  });

  it("VARIANT_MATRIX_SHADOW survives into the entry candidate identity", () => {
    const got = buildFourBrainGatherInput(baseDeps({
      openSignals: [cgSignal({
        laneId: "CG_WIDE_FAST_LONG", // bare — as the shadow tape emits it
        sourceKind: "VARIANT_MATRIX_SHADOW",
      })],
    }));
    expect(got.entryCandidatesRaw).toHaveLength(1);
    expect(got.entryCandidatesRaw[0]!.identity.sourceKind).toBe("VARIANT_MATRIX_SHADOW");
  });

  /** Legacy named-lane signals (SF/IM/RC/RCS/PWR/CE) never set sourceKind — must not be silently
   *  mislabeled as verified-ownership just because the field defaults to something truthy. */
  it("omitted sourceKind (legacy named-lane signal) resolves to null, never a fabricated label", () => {
    const { sourceKind: _drop, ...withoutSourceKind } = cgSignal({ sourceKind: "PAPER_ORDER_OWNED" });
    const got = buildFourBrainGatherInput(baseDeps({ openSignals: [withoutSourceKind] }));
    expect(got.entryCandidatesRaw[0]!.identity.sourceKind).toBeNull();
  });

  /** The candidate-ownership bridge input (dep.allocationContextForLane's second arg) must still be
   *  built from the signal's own laneId/observationId/direction regardless of sourceKind — the tag is
   *  visibility-only and must never influence what gets passed to the ownership lookup. */
  it("sourceKind never changes what is handed to allocationContextForLane", () => {
    const calls: { laneId: string; candidate: { signalId: string | null; direction: string } | undefined }[] = [];
    const deps = baseDeps({
      openSignals: [cgSignal({ sourceKind: "VARIANT_MATRIX_SHADOW", observationId: "OID-9" })],
      allocationContextForLane: (laneId, candidate) => {
        calls.push({ laneId, candidate });
        return staticAllocationContext(null);
      },
    });
    buildFourBrainGatherInput(deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.laneId).toBe("CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG");
    expect(calls[0]!.candidate).toEqual({ signalId: "OID-9", direction: "LONG" });
  });
});

describe("PAPER_ORDER_OWNED and VARIANT_MATRIX_SHADOW echoes of the same vmStore observation never collide", () => {
  /**
   * A VARIANT_MATRIX_OBSERVATION-sourced PaperOrder's sourceObservationId IS the vmStore
   * observationId it was admitted from (paper-execution-router.ts _buildBaseOrder:
   * `sourceObservationId: obs.observationId`). So once such an order exists, the real
   * (PAPER_ORDER_OWNED) row and the shadow-tape (VARIANT_MATRIX_SHADOW) row for the exact same
   * underlying signal can carry the SAME observationId. They must still be treated as two distinct
   * candidates (one attachable, one report-only diagnostic) — never deduped into one, and never
   * confused for an ambiguous/duplicate identity.
   */
  const sharedObservationId = "OID-SHARED";

  it("prefixed (real, PAPER_ORDER_OWNED) vs bare (shadow) laneId ⇒ different identityKey", () => {
    const real: Pick<EntryCandidateRaw["identity"], "laneId" | "symbolOrBasketId" | "side" | "signalId" | "positionId"> = {
      laneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
      symbolOrBasketId: "BTCUSDT", side: "LONG", signalId: sharedObservationId, positionId: null,
    };
    const shadow: typeof real = {
      laneId: "CG_WIDE_FAST_LONG",
      symbolOrBasketId: "BTCUSDT", side: "LONG", signalId: sharedObservationId, positionId: null,
    };
    expect(identityKey(real)).not.toBe(identityKey(shadow));
  });

  it("both rows survive rejectDuplicates — neither is dropped as a false collision", () => {
    const got = buildFourBrainGatherInput(baseDeps({
      openSignals: [
        cgSignal({ observationId: sharedObservationId, sourceKind: "PAPER_ORDER_OWNED" }),
        cgSignal({
          laneId: "CG_WIDE_FAST_LONG",
          observationId: sharedObservationId,
          sourceKind: "VARIANT_MATRIX_SHADOW",
        }),
      ],
    }));
    const dedup = rejectDuplicates(got.entryCandidatesRaw, (c) => identityKey(c.identity));
    expect(dedup.duplicateKeys).toEqual([]);
    expect(dedup.kept).toHaveLength(2);
    const bySourceKind = Object.fromEntries(dedup.kept.map((c) => [c.identity.sourceKind, c.identity.laneId]));
    expect(bySourceKind["PAPER_ORDER_OWNED"]).toBe("CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG");
    expect(bySourceKind["VARIANT_MATRIX_SHADOW"]).toBe("CG_WIDE_FAST_LONG");
  });
});

describe("app.ts collectFourBrainOpenSignals wiring (source-level guard)", () => {
  const APP_SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/app.ts"), "utf-8");
  const at = APP_SRC.indexOf("const collectFourBrainOpenSignals");
  const body = APP_SRC.slice(at, APP_SRC.indexOf("return out;", at));

  it("exists and is still additive over the six named lanes", () => {
    expect(at).toBeGreaterThanOrEqual(0);
    for (const lane of ["shortFadeOpenSignals", "intradayMomentumOpenSignals", "regimeCompositeOpenSignals", "regimeCompositeShortOpenSignals", "panicWashoutOpenSignals", "compositeEstimatorOpenSignals"]) {
      expect(body).toContain(lane);
    }
  });

  /** THE fix: real, currently-actionable PaperOrder rows are read directly, keyed on the exact
   *  ownership fields, and tagged PAPER_ORDER_OWNED. */
  it("sources PAPER_ORDER_OWNED signals from live PaperOrder rows via the canonical ownership fields", () => {
    expect(body).toContain("peekPaperExecutionRouterStore()");
    expect(body).toContain('order.paperStatus !== "CREATED"');
    expect(body).toContain('order.paperStatus !== "PAPER_SUBMITTED"');
    expect(body).toContain('order.sourceType !== "VARIANT_MATRIX_OBSERVATION"');
    expect(body).toContain('order.sourceType !== "SCAN_CANDIDATE_LANE_ALLOCATOR"');
    expect(body).toContain("laneId: order.selectedLaneId");
    expect(body).toContain("observationId: order.sourceObservationId");
    expect(body).toContain('sourceKind: "PAPER_ORDER_OWNED"');
  });

  /** The shadow tape must NOT be removed — only tagged. This is the literal instruction for this
   *  stage ("Do not remove the variant-matrix feed; give it a distinct provenance marker instead"). */
  it("keeps calling variantMatrixOpenSignals and tags its rows VARIANT_MATRIX_SHADOW", () => {
    expect(body).toContain("variantMatrixOpenSignals(getCurrentGuardVariantMatrixStore())");
    expect(body).toContain('sourceKind: "VARIANT_MATRIX_SHADOW"');
  });

  /** REALTIME_SHORT_MIRROR orders live in a physically separate store
   *  (getRealtimeShortMirrorStore(), "data/realtime-short") and are never present in
   *  peekPaperExecutionRouterStore().all — so the PAPER_ORDER_OWNED loop's sourceType filter can
   *  never see one regardless of whether it explicitly excludes that literal. Pin that the loop does
   *  not name it, i.e. it was deliberately scoped to the two sourceTypes that are actually reachable
   *  here rather than guessed at. */
  it("does not reference REALTIME_SHORT_MIRROR in the PAPER_ORDER_OWNED loop", () => {
    expect(body).not.toContain("REALTIME_SHORT_MIRROR");
  });

  /** Point 11: report-only visibility split by admission path, recorded inside the PAPER_ORDER_OWNED
   *  loop before the sourceKind-tagged push — never gating which signals reach `out`. */
  it("records a distinct report-only diagnostic per admission path (Path A generic, Path B chain-eligible)", () => {
    expect(body).toContain("recordCortexProductionChainDiagnostic(");
    expect(body).toContain('"CORTEX_CHAIN_ELIGIBLE_CANDIDATE"');
    expect(body).toContain('"GENERIC_FOUR_BRAIN_DIAGNOSTIC_CANDIDATE"');
    // The recording call must precede the sourceKind-tagged push, and must come before `out.push`
    // inside this same loop body — i.e. it observes the candidate, it never withholds it.
    const recordAt = body.indexOf("recordCortexProductionChainDiagnostic(");
    const pushAt = body.indexOf('sourceKind: "PAPER_ORDER_OWNED"');
    expect(recordAt).toBeGreaterThan(0);
    expect(pushAt).toBeGreaterThan(recordAt);
  });
});
