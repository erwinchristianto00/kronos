/**
 * [COST-SYMMETRY] The paper book's cost model must be exit-aware and fillMode-aware.
 *
 * Before this test the resolver charged a FLAT PAPER_TAKER_COST_BPS (22) / stopDistanceBps on every
 * close, which was wrong in three compounding directions at once:
 *   - maker_limit lanes overcharged 3.67x (should be MAKER_ROUNDTRIP_BPS = 6),
 *   - stop-triggered exits undercharged (no STOP_OUT_SLIPPAGE_BPS = 12 surcharge, unlike the VM
 *     matrix's own resolver, which has charged it since 2026-06),
 *   - and 2-7bps of PAPER_EXECUTION_MODEL_REALISTIC slippage double-counted, because 22 is
 *     (5 fee + 6 slippage) x 2 sides and the realism model ALREADY moved the fill prices.
 *
 * The maker correction alone is cost-REDUCING and would show up as a free netR improvement on the
 * maker lanes. Asserting the maker case AND the stop case in the same test is what makes this
 * catch that fake positive: a cost-reducing-only "fix" cannot satisfy both.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

// v2 is the default for new cohorts. vi.hoisted runs BEFORE the ESM imports below, which
// keeps the default explicit for this suite while the compatibility suite below checks
// the opt-in v1 fallback.
vi.hoisted(() => {
  process.env.PAPER_COST_MODEL_V2 = "1";
});

import {
  PaperExecutionRouterStore,
  resolvePaperOrders,
  PAPER_EXECUTION_MODEL_REALISTIC,
  PAPER_COST_MODEL_VERSION,
  type PaperResolverClient,
  type PaperKlineTuple,
  type PaperOrder,
} from "../src/lib/paper-execution-router.js";
import {
  MAKER_ROUNDTRIP_BPS,
  TAKER_ROUNDTRIP_BPS,
  STOP_OUT_SLIPPAGE_BPS,
  VARIANT_MATRIX_DEFINITIONS,
} from "../src/lib/current-guard-variant-matrix.js";

// ── fixture ──────────────────────────────────────────────────────────────────

const STOP_BPS = 300;
/** SHORT, entry 100, stop 103 (above), tp 96 (below) → |E-S|/E = 300bps exactly. */
const ENTRY = 100;
const STOP = 103;
const TP = 96;

function tmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), "paper-cost-symmetry-"));
}

function order(overrides: Partial<PaperOrder> & { paperOrderId: string; openedAt: string }): PaperOrder {
  const now = new Date().toISOString();
  return {
    sourceObservationId: `obs-${overrides.paperOrderId}`,
    sourceSignalId: null,
    dedupeKey: `${overrides.paperOrderId}:lane`,
    createdAt: now,
    updatedAt: now,
    symbol: "ETHUSDT",
    direction: "SHORT",
    regime: "BULLISH_EXPANSION",
    controllerMode: "SHORT_ONLY",
    selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE", // taker / tp1_full
    routerPermission: "SHADOW_ONLY",
    entryPrice: ENTRY,
    stopLoss: STOP,
    takeProfitLevels: [TP],
    plannedStopDistanceBps: STOP_BPS,
    riskPctOfEquity: 1,
    paperEquity: 2000,
    plannedRiskAmount: 20,
    plannedPositionNotional: 666.67,
    plannedRiskR: 1,
    oosUnconfirmed: true,
    infraNotReady: true,
    paperRiskLabel: "EXPERIMENTAL",
    operationalSafetyStatus: "OK",
    diagnosticLabel: null,
    paperStatus: "CREATED",
    grossR: null,
    costR: null,
    netR: null,
    netPnlAmount: null,
    closeReason: null,
    reportOnly: true,
    paperOnly: true,
    ...overrides,
  } as PaperOrder;
}

type Bar = { high: number; low: number; close: number };

/** signal bar at `signalMs`, then the supplied bars on the following 5m slots. 1m returns []. */
function klineClient(bars: Bar[]): PaperResolverClient {
  return {
    getKlines: async (_s, interval, opts) => {
      if (interval === "1m") return [];
      const signalMs = opts.startTime + 300_000; // resolver asks from openedAt - CANDLE_MS
      const out: PaperKlineTuple[] = [
        [signalMs - 300_000, "0", "100.4", "99.6", "100", "0", signalMs] as PaperKlineTuple,
      ];
      bars.forEach((b, i) => {
        const openMs = signalMs + i * 300_000;
        out.push([
          openMs,
          "0",
          String(b.high),
          String(b.low),
          String(b.close),
          "0",
          openMs + 300_000,
        ] as PaperKlineTuple);
      });
      return out;
    },
  };
}

async function resolveOne(o: PaperOrder, bars: Bar[]): Promise<PaperOrder> {
  const store = new PaperExecutionRouterStore(tmpDir());
  store.add(o);
  await resolvePaperOrders(store, klineClient(bars), PAPER_EXECUTION_MODEL_REALISTIC);
  return store.all[0]!;
}

const openedAt = () => new Date(Date.now() - 20 * 60_000).toISOString();

// SHORT: SL when high >= 103, TP when low <= 96.
const NEUTRAL: Bar = { high: 100.2, low: 99.8, close: 100 };
const SL_BAR: Bar = { high: 104, low: 101, close: 103 };
const TP_BAR: Bar = { high: 100.5, low: 95.5, close: 96 };
/** revisits entry 100 (maker post-only fills), then in the same bar runs to TP. */
const MAKER_FILL_TP_BAR: Bar = { high: 100.1, low: 95.5, close: 96 };
/** revisits entry 100, then in the same bar runs to SL. */
const MAKER_FILL_SL_BAR: Bar = { high: 104, low: 99.9, close: 103 };

// ── expected charges, derived from the shared constants (not hardcoded) ──────
//
// realism model: entry 2bps, stop 5bps, tp 0bps.
const ENTRY_SLIP = PAPER_EXECUTION_MODEL_REALISTIC.entrySlippageBps; // 2
const STOP_SLIP = PAPER_EXECUTION_MODEL_REALISTIC.stopSlippageBps; // 5
const TP_SLIP = PAPER_EXECUTION_MODEL_REALISTIC.tpSlippageBps; // 0

/** walk-resolved: grossR carries NO model slippage, so nothing is netted out. */
const MAKER_WALK_TP_BPS = MAKER_ROUNDTRIP_BPS; // 6
const MAKER_WALK_STOP_BPS = MAKER_ROUNDTRIP_BPS + STOP_OUT_SLIPPAGE_BPS; // 18
/** inline: grossR already realized entry + (tp|stop) slippage. */
const TAKER_INLINE_STOP_BPS = TAKER_ROUNDTRIP_BPS + STOP_OUT_SLIPPAGE_BPS - (ENTRY_SLIP + STOP_SLIP); // 27
const TAKER_INLINE_TP_BPS = TAKER_ROUNDTRIP_BPS - (ENTRY_SLIP + TP_SLIP); // 20
const TAKER_INLINE_MTM_BPS = TAKER_ROUNDTRIP_BPS - (ENTRY_SLIP + STOP_SLIP); // 15

describe("[COST-SYMMETRY] exit-aware + fillMode-aware paper cost model", () => {
  it("A: maker_limit TP is charged the MAKER round-trip, not the taker one", async () => {
    const o = await resolveOne(
      order({
        paperOrderId: "A",
        openedAt: openedAt(),
        selectedLaneId: "CG_VARIANT_MATRIX:CG_MAKER_LIMIT_SIM",
        fillMode: "maker_limit",
      }),
      [NEUTRAL, MAKER_FILL_TP_BAR],
    );
    expect(o.paperStatus).toBe("PAPER_CLOSED_WIN");
    expect(o.costR!).toBeCloseTo(-MAKER_WALK_TP_BPS / STOP_BPS, 6); // -6/300
    expect(o.costModelVersion).toBe(PAPER_COST_MODEL_VERSION);
  });

  it("B: maker_limit stop-out pays the maker round-trip PLUS the stop-out surcharge", async () => {
    const o = await resolveOne(
      order({
        paperOrderId: "B",
        openedAt: openedAt(),
        selectedLaneId: "CG_VARIANT_MATRIX:CG_MAKER_LIMIT_SIM",
        fillMode: "maker_limit",
      }),
      [NEUTRAL, MAKER_FILL_SL_BAR],
    );
    expect(o.paperStatus).toBe("PAPER_CLOSED_LOSS");
    expect(o.costR!).toBeCloseTo(-MAKER_WALK_STOP_BPS / STOP_BPS, 6); // -18/300, NOT free
  });

  it("C: taker inline SL pays the stop-out surcharge minus the slippage already in grossR", async () => {
    const o = await resolveOne(order({ paperOrderId: "C", openedAt: openedAt() }), [SL_BAR]);
    expect(o.closeReason).toBe("SL_HIT");
    expect(o.costR!).toBeCloseTo(-TAKER_INLINE_STOP_BPS / STOP_BPS, 6); // -27/300
  });

  it("D: taker inline TP1 is charged only the un-realized part of the round-trip", async () => {
    const o = await resolveOne(order({ paperOrderId: "D", openedAt: openedAt() }), [TP_BAR]);
    expect(o.closeReason).toBe("TP1_HIT");
    expect(o.costR!).toBeCloseTo(-TAKER_INLINE_TP_BPS / STOP_BPS, 6); // -20/300
  });

  it("E: a horizon mark-to-market close is NOT a stop trigger and pays no surcharge", async () => {
    // openedAt older than PAPER_MAX_HOLD_MS (72h) so the max-hold branch fires, with a path that
    // never touches SL or TP.
    const o = await resolveOne(
      order({ paperOrderId: "E", openedAt: new Date(Date.now() - 80 * 60 * 60_000).toISOString() }),
      [NEUTRAL, NEUTRAL, NEUTRAL],
    );
    expect(o.closeReason).toBe("MAX_HOLD_MTM");
    expect(o.costR!).toBeCloseTo(-TAKER_INLINE_MTM_BPS / STOP_BPS, 6); // -15/300
  });

  it("F: GUARD — a stop exit must cost strictly MORE than a TP exit on the same geometry", async () => {
    // Impossible to satisfy with any flat cost model. This is the assertion that makes a
    // maker-discount-only change fail.
    const sl = await resolveOne(order({ paperOrderId: "F1", openedAt: openedAt() }), [SL_BAR]);
    const tp = await resolveOne(order({ paperOrderId: "F2", openedAt: openedAt() }), [TP_BAR]);
    expect(sl.costR!).toBeLessThan(tp.costR!); // costR is negative → more negative = more expensive

    const makerTp = await resolveOne(
      order({
        paperOrderId: "F3",
        openedAt: openedAt(),
        selectedLaneId: "CG_VARIANT_MATRIX:CG_MAKER_LIMIT_SIM",
        fillMode: "maker_limit",
      }),
      [NEUTRAL, MAKER_FILL_TP_BAR],
    );
    // ...and a maker fill must cost strictly LESS than the equivalent taker fill.
    expect(makerTp.costR!).toBeGreaterThan(tp.costR!);
  });

  it("G: netR stays grossR + costR, and the cohort discriminator is stamped on every close", async () => {
    const o = await resolveOne(order({ paperOrderId: "G", openedAt: openedAt() }), [SL_BAR]);
    expect(o.netR!).toBeCloseTo(o.grossR! + o.costR!, 9);
    expect(o.costModelVersion).toBe(PAPER_COST_MODEL_VERSION);
  });

  /**
   * H: LOAD-BEARING INVARIANT, not a style check.
   *
   * The resolver picks its RESOLUTION PATH from `order.fillMode` (a maker_limit order goes through
   * walkVariantPath and models post-only no-fill risk; a taker order runs the inline branches).
   * _paperCostModelForOrder picks its COST BASIS from `def.costModel`, mirroring the VM matrix's own
   * variantRoundTripBps(). Those are two different fields, and they agree only because every
   * definition currently sets them equal — verified here rather than assumed.
   *
   * If someone ever sets costModel:"maker_limit" while leaving fillMode:"taker", the paper book
   * would SIMULATE a spread-crossing taker fill and CHARGE it the 6bps maker round-trip: a silent
   * 14bps-per-trade understatement, in the fake-positive direction, on a lane whose netR feeds
   * lane economics and CORTEX promotion. That is exactly the class of bug this whole change exists
   * to remove, so it gets a tripwire instead of a comment.
   */
  it("H: every variant definition's costModel matches its fillMode (cost basis == simulated fill)", () => {
    const divergent = VARIANT_MATRIX_DEFINITIONS.filter((d) => d.costModel !== d.fillMode).map(
      (d) => `${d.id}: fillMode=${d.fillMode} costModel=${d.costModel}`,
    );
    expect(divergent).toEqual([]);
  });

  /**
   * H2: the ORDER-level half of H, which H does not cover.
   *
   * The resolver reads `order.fillMode ?? "taker"` to choose its PATH, while _paperCostModelForOrder
   * reads `def.costModel` to choose its BASIS. H pins the DEFINITIONS; this pins the consequence for
   * a stored ORDER whose fillMode is absent (paper-execution-router defaults it to "taker" on the
   * PaperOpportunity path). Such a row on a maker lane resolves through the INLINE taker branches —
   * simulating a spread-crossing fill with no post-only no-fill risk — while being charged the 6bps
   * maker round-trip: a 14-16bps/trade understatement in the fake-positive direction on a lane whose
   * netR feeds CORTEX. Not reachable in today's data (all 4,692 maker-lane rows carry fillMode), so
   * this documents and pins the coupling rather than asserting a bug.
   */
  it("H2: a maker-lane order with NO persisted fillMode resolves inline yet is charged the maker basis", async () => {
    const o = await resolveOne(
      order({
        paperOrderId: "H2",
        openedAt: openedAt(),
        selectedLaneId: "CG_VARIANT_MATRIX:CG_MAKER_LIMIT_SIM",
        fillMode: undefined, // legacy / PaperOpportunity row
      }),
      [SL_BAR],
    );
    // PATH: inline taker (SL_HIT), NOT the maker walk (which would report MAKER_* / no-fill).
    expect(o.closeReason).toBe("SL_HIT");
    // BASIS: maker, taken from def.costModel — inline, so the model slippage already in grossR is
    // netted out. The floor (MAKER_ROUNDTRIP_BPS) binds: 6 + 12 − 7 = 11.
    const expectedBps = Math.max(
      MAKER_ROUNDTRIP_BPS,
      MAKER_ROUNDTRIP_BPS + STOP_OUT_SLIPPAGE_BPS - (ENTRY_SLIP + STOP_SLIP),
    );
    expect(o.costR!).toBeCloseTo(-expectedBps / STOP_BPS, 6);
    // The divergence is real and this is its magnitude vs. the taker basis the PATH simulated.
    expect(o.costR!).toBeGreaterThan(-TAKER_INLINE_STOP_BPS / STOP_BPS);
  });

  /**
   * I: PATH-INDEPENDENCE. Which resolver path an order takes is decided purely by exitRule
   * (scaleout_tp1_trail | mfe_giveback | maker_limit → walkVariantPath; trail_after_tp1 → inline),
   * so the SAME economic exit must not cost different amounts on the two paths.
   *
   * The walk path used to test only `status === "CLOSED_LOSS" || resolutionSource ===
   * "MFE_GIVEBACK_EXIT"`, so a walk-resolved TRAIL_BREAKEVEN win skipped the 12bps stop-out
   * surcharge that the inline path charged for the identical exit — a systematic 5bps/stopBps
   * discount to the scaleout lanes over the trail lanes, on 221 rows in the testnet store, feeding
   * CORTEX's per-lane netR on an instance where promotion is ENABLED.
   */
  it("I: a trail-to-breakeven WIN costs the same on the walk path as on the inline path", async () => {
    // TP1 touched, then price returns to entry → trail-to-breakeven on both lanes.
    const bars: Bar[] = [NEUTRAL, TP_BAR, { high: 100.5, low: 99.5, close: 100 }];
    const inline = await resolveOne(
      order({
        paperOrderId: "I1",
        openedAt: openedAt(),
        selectedLaneId: "CG_VARIANT_MATRIX:CG_TRAIL_AFTER_TP1", // exitRule trail_after_tp1 → INLINE
      }),
      bars,
    );
    const walk = await resolveOne(
      order({
        paperOrderId: "I2",
        openedAt: openedAt(),
        selectedLaneId: "CG_VARIANT_MATRIX:CG_SCALEOUT_TP1_TRAIL", // scaleout_tp1_trail → WALK
      }),
      bars,
    );
    // Both lanes are taker with identical geometry, so any cost difference is path artifact.
    const stopLike = (r: string | null) =>
      r != null && (r.startsWith("TRAIL_BREAKEVEN") || r === "ATR_TRAIL_STOP" || r === "MFE_GIVEBACK_EXIT");
    expect(stopLike(inline.closeReason)).toBe(true);
    expect(stopLike(walk.closeReason)).toBe(true);

    // The walk carries no model slippage (raw E/S/T) and the inline nets it out, so the two are
    // charged different BPS by design; what must match is the stop-out surcharge being applied on
    // BOTH. Compare each against its own path's stop-like expectation.
    const walkStopBps = TAKER_ROUNDTRIP_BPS + STOP_OUT_SLIPPAGE_BPS; // 34; this fixture closes before funding accrues
    expect(walk.costR!).toBeCloseTo(-walkStopBps / STOP_BPS, 6);
    expect(inline.costR!).toBeCloseTo(-TAKER_INLINE_STOP_BPS / STOP_BPS, 6); // 27
    // Without the fix the walk booked TP_LIKE: 22/300 instead of 34/300.
    expect(walk.costR!).toBeLessThan(-TAKER_ROUNDTRIP_BPS / STOP_BPS);
  });
});

/**
 * J: THE COMPATIBILITY SWITCH. v2 is default-ON; with the explicit v1 flag the whole book — resolver AND the
 * three what-if counterfactuals — must be byte-identical v1 flat cost, and stamp version 1. There
 * is no half-applied state in which some rows are v2 and some v1 within a single process.
 *
 * Uses a fresh module registry because PAPER_COST_MODEL_V2_ENABLED is read once at module load.
 */
describe("[COST-SYMMETRY] PAPER_COST_MODEL_V2 explicit v1 compatibility switch", () => {
  const prior = process.env.PAPER_COST_MODEL_V2;
  beforeAll(() => {
    process.env.PAPER_COST_MODEL_V2 = "0";
    vi.resetModules();
  });
  afterAll(() => {
    if (prior === undefined) delete process.env.PAPER_COST_MODEL_V2;
    else process.env.PAPER_COST_MODEL_V2 = prior;
    vi.resetModules();
  });

  it("J: with v1 explicitly selected, every exit kind is charged the flat v1 taker cost and stamped v1", async () => {
    const mod = await import("../src/lib/paper-execution-router.js");
    expect(mod.PAPER_COST_MODEL_V2_ENABLED).toBe(false);
    expect(mod.PAPER_COST_MODEL_VERSION).toBe(1);

    const resolveV1 = async (o: PaperOrder, bars: Bar[]): Promise<PaperOrder> => {
      const store = new mod.PaperExecutionRouterStore(tmpDir());
      store.add(o);
      await mod.resolvePaperOrders(store, klineClient(bars), mod.PAPER_EXECUTION_MODEL_REALISTIC);
      return store.all[0]!;
    };
    const FLAT = -22 / STOP_BPS; // PAPER_TAKER_COST_BPS / stopDistanceBps

    const sl = await resolveV1(order({ paperOrderId: "J1", openedAt: openedAt() }), [SL_BAR]);
    const tp = await resolveV1(order({ paperOrderId: "J2", openedAt: openedAt() }), [TP_BAR]);
    const maker = await resolveV1(
      order({
        paperOrderId: "J3",
        openedAt: openedAt(),
        selectedLaneId: "CG_VARIANT_MATRIX:CG_MAKER_LIMIT_SIM",
        fillMode: "maker_limit",
      }),
      [NEUTRAL, MAKER_FILL_TP_BAR],
    );
    // Flat: stop == TP == maker. This is precisely the asymmetry v2 removes, held in place here.
    expect(sl.costR!).toBeCloseTo(FLAT, 9);
    expect(tp.costR!).toBeCloseTo(FLAT, 9);
    expect(maker.costR!).toBeCloseTo(FLAT, 9);
    for (const o of [sl, tp, maker]) expect(o.costModelVersion).toBe(1);
  });
});
