import { describe, it, expect } from "vitest";
import {
  decideCortex,
  refitArchetypeCoefficients,
  checkCortexInvariants,
  solveLinear,
  cortexArchetypeForLane,
  cortexWinLabel,
  cortexBrainMode,
  cortexPromotedBeta,
  cortexPromotionBlockedByEnv,
  assembleCortexContext,
  buildCortexDecisionRecord,
  emptyCortexState,
  cortexBeta,
  CORTEX_BETA_MAX,
  CORTEX_BETA_RAMP_N,
  CORTEX_FEATURE_DIM,
  CORTEX_FEATURE_NAMES,
  CORTEX_FEATURE_SCHEMA_VERSION,
  type CortexContext,
  type CortexLaneInput,
  type CortexStoreState,
  type CortexTrainingExample,
} from "../src/lib/cortex-brain.js";

/** Build a training example at the current schema version. */
function train(x: number[], y: 0 | 1, tMs: number): CortexTrainingExample {
  return { x, y, tMs, schemaVersion: CORTEX_FEATURE_SCHEMA_VERSION };
}

function lane(over: Partial<CortexLaneInput> = {}): CortexLaneInput {
  return {
    laneId: "CG_WIDE_FAST_LONG",
    archetype: "BREADTH",
    direction: "LONG",
    edgeMemAvgNetR: 0.1,
    edgeMemN: 50,
    laneNetAvgR: 0.1,
    laneNetAvgN: 50,
    lanePf: 1.3,
    crowdingAlign: 0,
    kronosAgree: null,
    convictionScore: 0.6,
    vetoed: false,
    staticWeightPct: 20,
    ...over,
  };
}
function ctx(over: Partial<CortexContext> = {}): CortexContext {
  return {
    regimeFamily: "BULLISH_EXPANSION",
    axisScore: 0.5,
    axisSlopePerHour: 0.02,
    allowLong: true,
    allowShort: true,
    portfolioDrawdownPct: 0,
    killBudgetUtilization: 0,
    killLatched: false,
    lanes: [lane()],
    ...over,
  };
}
function trainedState(w: number[]): CortexStoreState {
  const s = emptyCortexState();
  s.archetypes.BREADTH.w = w;
  return s;
}

describe("cortex — feature-schema fingerprint guard (prevents silent mis-train of accumulated data)", () => {
  it("freezes the feature ORDER + count to the schema version — any reorder/rename/add fails until the version is bumped", () => {
    // The shadow journals x under CORTEX_FEATURE_SCHEMA_VERSION. If laneFeatureVector's feature ORDER
    // changes WITHOUT bumping the version, every already-collected row silently mis-trains (x[5] now means
    // something else) — weeks of data quietly corrupted. This golden fingerprint makes that impossible:
    // touch the features → this test fails → you MUST bump CORTEX_FEATURE_SCHEMA_VERSION + update the map.
    const FROZEN: Record<number, readonly string[]> = {
      1: ["bias", "axisAligned", "velAligned", "shrunkEdge", "logN", "laneNetAvgR", "lanePf", "crowdingAlign", "kronosAgree", "conviction"],
    };
    const expected = FROZEN[CORTEX_FEATURE_SCHEMA_VERSION];
    expect(expected, `No frozen fingerprint for schema v${CORTEX_FEATURE_SCHEMA_VERSION} — add one when you bump the version`).toBeDefined();
    expect(CORTEX_FEATURE_NAMES).toEqual(expected);
    expect(CORTEX_FEATURE_DIM).toBe(expected!.length);
  });
});

describe("cortex — round-2 robustness fixes (NaN edgeMemN, NaN beta)", () => {
  it("a NaN/Infinity edgeMemN on ONE lane does NOT wipe the learned channel for the others", () => {
    // Before the finiteOr guard on x[4]=logN: edgeMemN=NaN → x[4]=NaN → pWin=NaN → rawSum=NaN → the
    // `rawSum>0` short-circuit forced learnedPct=0 for EVERY lane (whole book) while invariants still passed.
    const st = emptyCortexState();
    const w = new Array(CORTEX_FEATURE_DIM).fill(0);
    w[5] = 3; // weight on laneNetAvgR so pWin varies by the healthy lanes' own edge
    st.archetypes.BREADTH.w = w;
    const lanes = [
      lane({ laneId: "HEALTHY_A", laneNetAvgR: 0.15, laneNetAvgN: 200, edgeMemAvgNetR: 0.1, edgeMemN: 200, staticWeightPct: 20 }),
      lane({ laneId: "HEALTHY_B", laneNetAvgR: 0.02, laneNetAvgN: 200, edgeMemAvgNetR: 0.1, edgeMemN: 200, staticWeightPct: 20 }),
      lane({ laneId: "CORRUPT", laneNetAvgR: 0.1, laneNetAvgN: 200, edgeMemAvgNetR: 0.1, edgeMemN: NaN as unknown as number, staticWeightPct: 20 }),
    ];
    const d = decideCortex(ctx({ lanes }), st, { beta: 1 });
    expect(d.lanes.every((l) => Number.isFinite(l.finalPct))).toBe(true);
    expect(Number.isFinite(d.expectedTiltDeltaR)).toBe(true);
    expect(checkCortexInvariants(d).ok).toBe(true);
    // the healthy lanes STILL earn a learned tilt (channel not wiped by the corrupt sibling)
    expect(d.lanes.find((l) => l.laneId === "HEALTHY_A")!.learnedPct).toBeGreaterThan(0);
    expect(d.lanes.find((l) => l.laneId === "HEALTHY_A")!.featureVector.every((v) => Number.isFinite(v))).toBe(true);
    expect(d.lanes.find((l) => l.laneId === "CORRUPT")!.featureVector.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("opts.beta=NaN falls back to the ramp (finiteOr), not an all-NaN allocation", () => {
    const d = decideCortex(ctx(), emptyCortexState(), { beta: NaN });
    expect(Number.isFinite(d.beta)).toBe(true);
    expect(d.lanes.every((l) => Number.isFinite(l.finalPct))).toBe(true);
    expect(Number.isFinite(d.expectedTiltDeltaR)).toBe(true);
    expect(checkCortexInvariants(d).ok).toBe(true);
  });
});

describe("cortex — decide (starts == incumbent, gates, deleverage)", () => {
  it("β=0 reproduces the static table exactly for eligible lanes", () => {
    const c = ctx({ lanes: [lane({ laneId: "A", staticWeightPct: 20 }), lane({ laneId: "B", staticWeightPct: 15 })] });
    const d = decideCortex(c, emptyCortexState(), { beta: 0 });
    expect(d.lanes.find((l) => l.laneId === "A")!.finalPct).toBeCloseTo(20, 6);
    expect(d.lanes.find((l) => l.laneId === "B")!.finalPct).toBeCloseTo(15, 6);
  });

  it("never funds a vetoed lane at any β", () => {
    for (const beta of [0, 0.3, 1]) {
      const d = decideCortex(ctx({ lanes: [lane({ vetoed: true, staticWeightPct: 20 })] }), trainedState(new Array(CORTEX_FEATURE_DIM).fill(1)), { beta });
      expect(d.lanes[0]!.finalPct).toBe(0);
      expect(d.lanes[0]!.reason).toContain("veto");
    }
  });

  it("does NOT hard-zero a counter-posture direction (soft lean, not a regime gate)", () => {
    // allowShort=false is now a soft lean, not a gate — the SHORT lane stays eligible and, at β=0,
    // reproduces the static table. Only a proven-negative `vetoed` lane is hard-zeroed.
    const d = decideCortex(ctx({ allowShort: false, lanes: [lane({ direction: "SHORT", laneId: "S", staticWeightPct: 20 })] }), emptyCortexState(), { beta: 0 });
    expect(d.lanes[0]!.eligible).toBe(true);
    expect(d.lanes[0]!.finalPct).toBeCloseTo(20, 6);
  });

  it("preserves an incumbent above the cap at β=0 (starts == today for an 80% lane)", () => {
    const d = decideCortex(ctx({ lanes: [lane({ laneId: "BIG", staticWeightPct: 80 })] }), emptyCortexState(), { beta: 0 });
    expect(d.lanes[0]!.finalPct).toBeCloseTo(80, 6); // NOT silently cut to the 35% cap
    expect(checkCortexInvariants(d).ok).toBe(true);
  });

  it("is NaN-robust on staticWeightPct + killBudgetUtilization (no NaN weights escape)", () => {
    const d = decideCortex(
      ctx({ killBudgetUtilization: NaN, lanes: [lane({ laneId: "A", staticWeightPct: NaN as unknown as number })] }),
      emptyCortexState(),
      { beta: 0 },
    );
    expect(Number.isFinite(d.grossG)).toBe(true);
    expect(d.lanes.every((l) => Number.isFinite(l.finalPct))).toBe(true);
    expect(checkCortexInvariants(d).ok).toBe(true);
  });

  it("expectedTiltDeltaR is 0 at β=0 (no tilt ⇒ no predicted reality gap)", () => {
    const d = decideCortex(ctx({ lanes: [lane({ laneId: "A", staticWeightPct: 20 }), lane({ laneId: "B", staticWeightPct: 15 })] }), emptyCortexState(), { beta: 0 });
    expect(Math.abs(d.expectedTiltDeltaR)).toBeLessThan(1e-9);
  });

  it("kill-switch → FLAT, gross 0, nothing funded", () => {
    const d = decideCortex(ctx({ killLatched: true }), emptyCortexState(), { beta: 0 });
    expect(d.posture).toBe("FLAT");
    expect(d.grossG).toBe(0);
    expect(d.lanes.every((l) => l.finalPct === 0)).toBe(true);
  });

  it("kill-budget utilization deleverages the gross scalar on the deterministic schedule (not to zero)", () => {
    // util 0.55 sits in the gradual band (0.4→0.7 lerps gross 1→0.6): t=(0.55−0.4)/0.3=0.5 ⇒ G=1−0.5·0.4=0.8
    const mid = decideCortex(ctx({ killBudgetUtilization: 0.55 }), emptyCortexState(), { beta: 0 });
    expect(mid.grossG).toBeCloseTo(0.8, 6);
    expect(mid.posture).toBe("RISK_ON"); // below the 0.7 aggressive threshold
    expect(mid.lanes[0]!.finalPct).toBeCloseTo(20 * 0.8, 6);
    // util 0.7 hits the aggressive band boundary: G=0.6, posture flips RISK_OFF.
    const agg = decideCortex(ctx({ killBudgetUtilization: 0.7 }), emptyCortexState(), { beta: 0 });
    expect(agg.grossG).toBeCloseTo(0.6, 6);
    expect(agg.posture).toBe("RISK_OFF");
    // util ≥1 floors at the gross floor (engine kill rail owns it past there).
    const floor = decideCortex(ctx({ killBudgetUtilization: 1.2 }), emptyCortexState(), { beta: 0 });
    expect(floor.grossG).toBeCloseTo(0.25, 6);
  });

  it("with trained coefficients + β=1, tilts capital toward the stronger-edge lane", () => {
    const w = new Array(CORTEX_FEATURE_DIM).fill(0);
    w[3] = 3; // strong positive weight on shrunkEdge
    const c = ctx({
      lanes: [
        lane({ laneId: "STRONG", edgeMemAvgNetR: 0.2, edgeMemN: 120, staticWeightPct: 20 }),
        lane({ laneId: "WEAK", edgeMemAvgNetR: 0.01, edgeMemN: 120, staticWeightPct: 20 }),
      ],
    });
    const d = decideCortex(c, trainedState(w), { beta: 1 });
    const strong = d.lanes.find((l) => l.laneId === "STRONG")!;
    const weak = d.lanes.find((l) => l.laneId === "WEAK")!;
    expect(strong.finalPct).toBeGreaterThan(weak.finalPct);
    expect(strong.pWin).toBeGreaterThan(0.5);
  });

  it("caps the learned TILT of a small-incumbent lane at 35%", () => {
    const w = new Array(CORTEX_FEATURE_DIM).fill(0);
    w[3] = 5;
    // two small-static lanes so the winner's learned share would exceed 35% without the cap
    const c = ctx({
      lanes: [
        lane({ laneId: "STRONG", edgeMemAvgNetR: 0.3, edgeMemN: 200, staticWeightPct: 10 }),
        lane({ laneId: "WEAK", edgeMemAvgNetR: 0.01, edgeMemN: 200, staticWeightPct: 10 }),
      ],
    });
    const d = decideCortex(c, trainedState(w), { beta: 1 });
    expect(d.lanes.find((l) => l.laneId === "STRONG")!.finalPct).toBeLessThanOrEqual(35 + 1e-6);
    expect(checkCortexInvariants(d).ok).toBe(true);
  });
});

describe("cortex — invariants", () => {
  it("passes a normal decision and catches an over-cap / vetoed-funded vector", () => {
    const good = decideCortex(ctx(), emptyCortexState(), { beta: 0 });
    expect(checkCortexInvariants(good).ok).toBe(true);

    const overCap = { ...good, lanes: [{ ...good.lanes[0]!, finalPct: 50 }] };
    expect(checkCortexInvariants(overCap).ok).toBe(false);

    const fundedVeto = {
      ...good,
      lanes: [{ ...good.lanes[0]!, eligible: false, reason: "edge-memory / controller veto", finalPct: 10 }],
    };
    expect(checkCortexInvariants(fundedVeto).ok).toBe(false);
  });
});

describe("cortex — learning (refit logistic via IRLS)", () => {
  const now = 2_000_000_000_000;

  it("learns from mistakes: a feature that predicts wins gets a positive coefficient", () => {
    const examples: CortexTrainingExample[] = [];
    for (let i = 0; i < 80; i += 1) {
      const good = i % 2 === 0;
      const x = new Array(CORTEX_FEATURE_DIM).fill(0);
      x[0] = 1;
      x[3] = good ? 0.8 : -0.8; // shrunkEdge feature separates win/loss
      x[9] = 0.5;
      examples.push(train(x, good ? 1 : 0, now));
    }
    const { w, nEff, status } = refitArchetypeCoefficients(examples, new Array(CORTEX_FEATURE_DIM).fill(0), { nowMs: now });
    expect(status).toBe("ACCEPTED");
    expect(nEff).toBeCloseTo(80, 4); // no decay when tMs == now
    expect(w[3]).toBeGreaterThan(0.5); // learned that feature 3 predicts a win
  });

  it("anti-overfit: thin data is more shrunk to the prior than abundant data (λ ∝ 1/N_eff)", () => {
    const wPrior = new Array(CORTEX_FEATURE_DIM).fill(0);
    const mk = (n: number): CortexTrainingExample[] =>
      Array.from({ length: n }, (_, i) => {
        const x = new Array(CORTEX_FEATURE_DIM).fill(0);
        x[0] = 1;
        x[3] = i % 2 === 0 ? 0.8 : -0.8;
        return train(x, i % 2 === 0 ? 1 : 0, now);
      });
    const thin = refitArchetypeCoefficients(mk(6), wPrior, { nowMs: now }).w;
    const thick = refitArchetypeCoefficients(mk(300), wPrior, { nowMs: now }).w;
    // same signal, but the well-sampled fit trusts it further (less ridge) — thin stays nearer prior
    expect(Math.abs(thick[3]!)).toBeGreaterThan(Math.abs(thin[3]!));
  });

  it("anti-overfit backstop: a thin resolved sample ⇒ β≈0 ⇒ decide stays ~static despite big coefficients", () => {
    const state = trainedState(new Array(CORTEX_FEATURE_DIM).fill(4)); // aggressive learned coefficients
    state.cumulativeResolved = 5; // only 5 closes accrued
    const d = decideCortex(ctx({ lanes: [lane({ laneId: "A", staticWeightPct: 20 })] }), state); // β from cortexBeta
    expect(d.beta).toBeLessThan(0.02);
    expect(Math.abs(d.lanes[0]!.finalPct - 20)).toBeLessThan(1); // ~static; the learned tilt is inert while data is thin
  });

  it("empty examples → returns the prior unchanged with REJECTED_LOW_NEFF", () => {
    const wPrior = [0.1, 0.2, 0.3, 0.4, 0, 0, 0, 0, 0, 0];
    const r = refitArchetypeCoefficients([], wPrior, { nowMs: now });
    expect(r.w).toEqual(wPrior);
    expect(r.status).toBe("REJECTED_LOW_NEFF");
  });

  it("recency decay down-weights old data (nEff < raw count)", () => {
    const old = now - 90 * 86_400_000; // 2 half-lives ago
    const examples = Array.from({ length: 10 }, () =>
      train(new Array(CORTEX_FEATURE_DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)), 1, old),
    );
    const { nEff } = refitArchetypeCoefficients(examples, new Array(CORTEX_FEATURE_DIM).fill(0), { nowMs: now });
    expect(nEff).toBeCloseTo(10 * 0.25, 4); // 0.5^2 per example
  });

  it("rejects stale-schema rows (no usable data → prior, REJECTED_LOW_NEFF)", () => {
    const stale: CortexTrainingExample = { x: new Array(CORTEX_FEATURE_DIM).fill(0), y: 1, tMs: now, schemaVersion: 999 };
    const r = refitArchetypeCoefficients([stale], new Array(CORTEX_FEATURE_DIM).fill(0), { nowMs: now });
    expect(r.status).toBe("REJECTED_LOW_NEFF"); // the wrong-schema row is dropped
  });

  it("rejects a blown-up (coefficient-jump) fit and keeps the prior model", () => {
    // separable data would push a coefficient huge; a tiny maxJump forces the reject path
    const examples = Array.from({ length: 200 }, (_, i) => {
      const x = new Array(CORTEX_FEATURE_DIM).fill(0);
      x[0] = 1;
      x[3] = i % 2 === 0 ? 1 : -1;
      return train(x, i % 2 === 0 ? 1 : 0, now);
    });
    const wPrior = new Array(CORTEX_FEATURE_DIM).fill(0);
    const r = refitArchetypeCoefficients(examples, wPrior, { nowMs: now, maxJump: 0.01 });
    expect(r.status).toBe("REJECTED_COEFFICIENT_JUMP");
    expect(r.w).toEqual(wPrior); // model preserved, not corrupted
  });

  it("2026-07-20 fix: undamped Newton oscillation on collinear features + stale prior now converges (ACCEPTED, not REJECTED_NON_CONVERGENCE)", () => {
    // Regression for the real TACTICAL archetype failure: near-collinear features (mirroring
    // laneNetAvgR/lanePf moving together) plus a stale prior displaced from the data's optimum
    // made undamped Newton steps overshoot and oscillate between two coefficient vectors forever,
    // never satisfying the convergence tolerance. A backtracking line search guarantees each step
    // improves the penalized likelihood, so it converges instead of oscillating.
    const mkRow = (i: number): CortexTrainingExample => {
      const r = (n: number) => Math.sin(42 * 99991 + i * 7919 + n * 104729) * 0.5 + 0.5;
      const core = r(5) * 2 - 1;
      const x = new Array(CORTEX_FEATURE_DIM).fill(0);
      x[0] = 1;
      x[1] = r(1) * 2 - 1;
      x[2] = r(2) * 2 - 1;
      x[3] = r(3) * 2 - 1;
      x[4] = r(4);
      x[5] = core + (r(6) - 0.5) * 0.02; // near-duplicate of x[6], like laneNetAvgR/lanePf
      x[6] = core + (r(7) - 0.5) * 0.02;
      x[9] = r(8);
      const y: 0 | 1 = core + (r(9) - 0.5) * 1.4 > 0 ? 1 : 0;
      return train(x, y, now);
    };
    const examples = Array.from({ length: 89 }, (_, i) => mkRow(i));
    // Stale prior displaced far from the data's true optimum — mirrors a thin-sample archetype
    // whose last accepted fit no longer matches the current data.
    const wPrior = [0.6, 4.56, -3.5, 0.8, -1.2, 1.8, -1.8, 0, 0, 1];
    const r = refitArchetypeCoefficients(examples, wPrior, { nowMs: now, iterations: 12, maxJump: 8 });
    expect(r.status).toBe("ACCEPTED");
    expect(r.w.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("win label applies the economic hurdle (a fee-scratch is not a win)", () => {
    expect(cortexWinLabel(0.2)).toBe(1);
    expect(cortexWinLabel(0.01)).toBe(0); // below hurdle → loss
    expect(cortexWinLabel(-0.5)).toBe(0);
    expect(cortexWinLabel(NaN)).toBe(0);
  });
});

describe("cortex — Phase 4 promotion (2026-07-20, operator-approved testnet-only wiring)", () => {
  describe("cortexPromotedBeta", () => {
    it("is hard 0 whenever the regime-coverage gate hasn't passed, regardless of everything else", () => {
      expect(cortexPromotedBeta(CORTEX_BETA_RAMP_N, false, 0)).toBe(0);
      expect(cortexPromotedBeta(1_000_000, false, 0)).toBe(0);
    });

    it("fully damps to 0 when blindCapitalPct is 100 (no lane has learning feedback yet)", () => {
      expect(cortexPromotedBeta(CORTEX_BETA_RAMP_N, true, 100)).toBe(0);
    });

    it("reaches β_max only at full ramp AND zero blind capital", () => {
      expect(cortexPromotedBeta(CORTEX_BETA_RAMP_N, true, 0)).toBeCloseTo(CORTEX_BETA_MAX, 9);
    });

    it("damps proportionally to blind capital — half-blind halves the ramped β", () => {
      const full = cortexPromotedBeta(CORTEX_BETA_RAMP_N, true, 0);
      const halfBlind = cortexPromotedBeta(CORTEX_BETA_RAMP_N, true, 50);
      expect(halfBlind).toBeCloseTo(full / 2, 9);
    });

    it("matches the plain cortexBeta ramp at a partial sample count once undamped", () => {
      const n = CORTEX_BETA_RAMP_N / 2;
      expect(cortexPromotedBeta(n, true, 0)).toBeCloseTo(cortexBeta(n), 9);
    });

    it("never lets a non-finite blindCapitalPct escape as a non-finite or over-max β", () => {
      const r = cortexPromotedBeta(CORTEX_BETA_RAMP_N, true, NaN);
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBe(0); // NaN blind-capital defaults to the SAFEST reading (100 == fully blind)
    });
  });

  describe("cortexPromotionBlockedByEnv (hard circuit breaker, independent of any opt-in flag)", () => {
    it("blocks when LIVE_BINANCE_ENV is mainnet — this is the real-money boundary the execution engine itself uses", () => {
      expect(cortexPromotionBlockedByEnv({ LIVE_BINANCE_ENV: "mainnet" } as NodeJS.ProcessEnv)).toBe(true);
    });
    it("does not block on testnet", () => {
      expect(cortexPromotionBlockedByEnv({ LIVE_BINANCE_ENV: "testnet" } as NodeJS.ProcessEnv)).toBe(false);
    });
    it("does not block when unset (safe default is NOT blocked, since the mode opt-in is the primary gate)", () => {
      expect(cortexPromotionBlockedByEnv({} as NodeJS.ProcessEnv)).toBe(false);
    });
    it("is case/whitespace-insensitive so a sloppy .env value still trips the breaker", () => {
      expect(cortexPromotionBlockedByEnv({ LIVE_BINANCE_ENV: "  MainNet  " } as NodeJS.ProcessEnv)).toBe(true);
    });
  });
});

describe("cortex — helpers", () => {
  it("solveLinear solves a small system", () => {
    const x = solveLinear([[2, 1], [1, 3]], [3, 5]);
    expect(x[0]).toBeCloseTo(0.8, 6);
    expect(x[1]).toBeCloseTo(1.4, 6);
  });

  it("β ramps from 0 by cumulative sample", () => {
    expect(cortexBeta(0)).toBe(0);
    expect(cortexBeta(150)).toBeCloseTo(0.15, 6); // 0.3 * 150/300
    expect(cortexBeta(10_000)).toBeCloseTo(0.3, 6); // capped at β_max
  });

  it("maps lane ids to archetypes", () => {
    expect(cortexArchetypeForLane("CROSS_SECTIONAL_MARKET_NEUTRAL")).toBe("NEUTRAL");
    expect(cortexArchetypeForLane("SHORT_FADE_EXHAUSTION")).toBe("TACTICAL");
    expect(cortexArchetypeForLane("INTRADAY_MOMENTUM_BREAKOUT")).toBe("TACTICAL");
    expect(cortexArchetypeForLane("CG_WIDE_FAST_LONG")).toBe("BREADTH");
    expect(cortexArchetypeForLane("COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG")).toBe("BREADTH");
  });
});

describe("cortex — wiring seam (mode gate, context assembly, journal record)", () => {
  it("mode gate: default off; recognizes shadow/live; unknown → off (safe)", () => {
    expect(cortexBrainMode({} as NodeJS.ProcessEnv)).toBe("off");
    expect(cortexBrainMode({ CENTRAL_BRAIN_MODE: "shadow" } as NodeJS.ProcessEnv)).toBe("shadow");
    expect(cortexBrainMode({ CENTRAL_BRAIN_MODE: "LIVE" } as NodeJS.ProcessEnv)).toBe("live");
    expect(cortexBrainMode({ CENTRAL_BRAIN_MODE: "garbage" } as NodeJS.ProcessEnv)).toBe("off");
  });

  it("assembleCortexContext derives each lane's archetype and preserves the observation", () => {
    const c = assembleCortexContext(
      { regimeFamily: "BEARISH_EXPANSION", axisScore: -0.5, axisSlopePerHour: -0.02, allowLong: false, allowShort: true, portfolioDrawdownPct: 0, killBudgetUtilization: 0, killLatched: false },
      [
        { laneId: "CG_WIDE_FAST_SHORT", direction: "SHORT", edgeMemAvgNetR: 0.1, edgeMemN: 40, laneNetAvgR: 0.1, laneNetAvgN: 40, lanePf: 1.2, crowdingAlign: 0, kronosAgree: null, convictionScore: 0.7, vetoed: false, staticWeightPct: 30 },
        { laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", direction: "NEUTRAL", edgeMemAvgNetR: null, edgeMemN: 0, laneNetAvgR: 0.02, laneNetAvgN: 60, lanePf: 1.05, crowdingAlign: null, kronosAgree: null, convictionScore: null, vetoed: false, staticWeightPct: 10 },
      ],
    );
    expect(c.lanes[0]!.archetype).toBe("BREADTH");
    expect(c.lanes[1]!.archetype).toBe("NEUTRAL");
    expect(c.lanes[0]!.staticWeightPct).toBe(30);
    // and it decides cleanly end-to-end
    const d = decideCortex(c, emptyCortexState(), { beta: 0 });
    expect(checkCortexInvariants(d).ok).toBe(true);
  });

  it("buildCortexDecisionRecord produces an auditable BRAIN_DECISION trace", () => {
    const c = ctx();
    const d = decideCortex(c, emptyCortexState(), { beta: 0 });
    const rec = buildCortexDecisionRecord({ atIso: "2026-07-12T00:00:00Z", mode: "shadow", ctx: c, decision: d, invariants: checkCortexInvariants(d) }) as Record<string, unknown>;
    expect(rec.kind).toBe("BRAIN_DECISION");
    expect(rec.mode).toBe("shadow");
    expect(rec.invariantsOk).toBe(true);
    expect(Array.isArray(rec.lanes)).toBe(true);
    expect((rec.lanes as unknown[]).length).toBe(c.lanes.length);
  });

  it("journals a VALID training row per lane: x (== the model's actual feature vector) + raw inputs + direction", () => {
    // This is the data-validity guard: without capturing x at decision time, #218 could not build a
    // training example later (the decision-time features would be gone) → weeks of shadow data wasted.
    const c = ctx({ lanes: [lane({ laneId: "L", edgeMemAvgNetR: 0.12, edgeMemN: 60, laneNetAvgR: 0.1, laneNetAvgN: 60, lanePf: 1.3, crowdingAlign: -0.4, kronosAgree: 0.3, convictionScore: 0.7 })] });
    const d = decideCortex(c, emptyCortexState(), { beta: 0 });
    const rec = buildCortexDecisionRecord({ atIso: "2026-07-12T00:00:00Z", mode: "shadow", ctx: c, decision: d, invariants: checkCortexInvariants(d) }) as Record<string, unknown>;
    const laneRec = (rec.lanes as Array<Record<string, unknown>>)[0]!;
    // x is present, correct length, and byte-for-byte the feature vector the decision used.
    const x = laneRec.x as number[];
    expect(Array.isArray(x)).toBe(true);
    expect(x.length).toBe(CORTEX_FEATURE_DIM);
    expect(x).toEqual(d.lanes[0]!.featureVector.map((v) => Number(v.toFixed(6))));
    expect(x.every((v) => Number.isFinite(v))).toBe(true);
    // raw inputs are captured so x is reconstructable + auditable; direction + schema present.
    const raw = laneRec.raw as Record<string, unknown>;
    expect(raw.edgeMemAvgNetR).toBe(0.12);
    expect(raw.edgeMemN).toBe(60);
    expect(raw.laneNetAvgR).toBe(0.1);
    expect(raw.lanePf).toBe(1.3);
    expect(raw.crowdingAlign).toBe(-0.4);
    expect(raw.kronosAgree).toBe(0.3);
    expect(raw.convictionScore).toBe(0.7);
    expect(laneRec.direction).toBe("LONG");
    expect(rec.featureSchemaVersion).toBe(CORTEX_FEATURE_SCHEMA_VERSION);
    expect(rec.at).toBe("2026-07-12T00:00:00Z"); // the timestamp #218 keys the y-label off
  });
});

describe("cortex — NEUTRAL-lane allocation magnitude (operator decision 2: shrunk own-edge, not raw)", () => {
  type Arch = "BREADTH" | "NEUTRAL" | "TACTICAL";
  // Bias-only weights: pWin = sigmoid(w[0]); every edge feature has weight 0, so p_win is isolated from
  // the lane's edge — this lets us drive p_win up/down independently of the allocation magnitude.
  function stateWithBias(biasByArch: Partial<Record<Arch, number>>): CortexStoreState {
    const s = emptyCortexState();
    for (const arch of Object.keys(biasByArch) as Arch[]) {
      const w = new Array(CORTEX_FEATURE_DIM).fill(0);
      w[0] = biasByArch[arch]!;
      s.archetypes[arch].w = w;
    }
    return s;
  }
  const neutral = (over: Partial<CortexLaneInput> = {}): CortexLaneInput =>
    lane({ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", archetype: "NEUTRAL", direction: "NEUTRAL", edgeMemAvgNetR: null, edgeMemN: 0, convictionScore: 0.5, crowdingAlign: null, staticWeightPct: 20, ...over });
  const ref = (over: Partial<CortexLaneInput> = {}): CortexLaneInput =>
    lane({ laneId: "REF_LONG", archetype: "BREADTH", direction: "LONG", edgeMemAvgNetR: 0.1, edgeMemN: 200, laneNetAvgR: 0.1, laneNetAvgN: 200, staticWeightPct: 20, ...over });
  const find = (d: ReturnType<typeof decideCortex>, id: string) => d.lanes.find((l) => l.laneId === id)!;

  it("1) NEUTRAL + positive own-edge + pWin>0.5 → its own-edge boosts the learned share", () => {
    const st = stateWithBias({ NEUTRAL: 5, BREADTH: 5 });
    const hi = decideCortex(ctx({ lanes: [ref(), neutral({ laneNetAvgR: 0.15, laneNetAvgN: 200 })] }), st, { beta: 1 });
    const lo = decideCortex(ctx({ lanes: [ref(), neutral({ laneNetAvgR: 0.02, laneNetAvgN: 200 })] }), st, { beta: 1 });
    const nHi = find(hi, "CROSS_SECTIONAL_MARKET_NEUTRAL");
    const nLo = find(lo, "CROSS_SECTIONAL_MARKET_NEUTRAL");
    expect(nHi.learnedPct).toBeGreaterThan(0); // XSEC %→R edge can actually MOVE the allocation, not just p_win
    expect(nHi.learnedPct).toBeGreaterThan(nLo.learnedPct); // more own-edge ⇒ more learned share
  });

  it("2) NEUTRAL + positive own-edge but pWin<0.5 → trimmed (0 learned share, below incumbent)", () => {
    const st = stateWithBias({ NEUTRAL: -5, BREADTH: 5 });
    const d = decideCortex(ctx({ lanes: [ref(), neutral({ laneNetAvgR: 0.15, laneNetAvgN: 200 })] }), st, { beta: 1 });
    const n = find(d, "CROSS_SECTIONAL_MARKET_NEUTRAL");
    expect(n.learnedPct).toBe(0);
    expect(n.finalPct).toBeLessThan(n.staticPct); // below its incumbent = trimmed
  });

  it("3) NEUTRAL + null or negative own-edge → no boost even with pWin>0.5 (magnitude floors at 0)", () => {
    const st = stateWithBias({ NEUTRAL: 5, BREADTH: 5 });
    for (const bad of [null, -0.2] as Array<number | null>) {
      const d = decideCortex(ctx({ lanes: [ref(), neutral({ laneNetAvgR: bad, laneNetAvgN: 200 })] }), st, { beta: 1 });
      expect(find(d, "CROSS_SECTIONAL_MARKET_NEUTRAL").learnedPct).toBe(0);
    }
  });

  it("4) DIRECTIONAL magnitude tracks edge-memory, NOT the lane's own laneNetAvgR", () => {
    const st = stateWithBias({ BREADTH: 5 });
    // A: strong edge-memory, zero own-edge. B: zero edge-memory, huge own-edge. A must still win the tilt.
    const A = lane({ laneId: "A", archetype: "BREADTH", direction: "LONG", edgeMemAvgNetR: 0.2, edgeMemN: 200, laneNetAvgR: 0, laneNetAvgN: 200, staticWeightPct: 20 });
    const B = lane({ laneId: "B", archetype: "BREADTH", direction: "LONG", edgeMemAvgNetR: 0, edgeMemN: 200, laneNetAvgR: 0.5, laneNetAvgN: 200, staticWeightPct: 20 });
    const d = decideCortex(ctx({ lanes: [A, B] }), st, { beta: 1 });
    expect(find(d, "A").learnedPct).toBeGreaterThan(find(d, "B").learnedPct);
  });

  it("5) allocation magnitude is always finite and capped (a huge/garbage own-edge cannot dominate)", () => {
    const st = stateWithBias({ NEUTRAL: 5, BREADTH: 5 });
    // own-edge 0.6 vs 1000: both exceed CORTEX_MAX_EDGE_MAGNITUDE_R (0.5) so both cap, and both x[5]
    // clamps to 1 → identical learned share (the huge one cannot dominate the capped one).
    const capA = neutral({ laneId: "CROSS_SECTIONAL_A", laneNetAvgR: 0.6, laneNetAvgN: 1_000_000 });
    const capB = neutral({ laneId: "CROSS_SECTIONAL_B", laneNetAvgR: 1000, laneNetAvgN: 1_000_000 });
    const d = decideCortex(ctx({ lanes: [capA, capB] }), st, { beta: 1 });
    expect(find(d, "CROSS_SECTIONAL_A").learnedPct).toBeCloseTo(find(d, "CROSS_SECTIONAL_B").learnedPct, 6);
    // and a NaN/Infinity own-edge never escapes as a non-finite weight
    const garbage = decideCortex(
      ctx({ lanes: [neutral({ laneNetAvgR: Infinity, laneNetAvgN: NaN as unknown as number }), ref()] }),
      st,
      { beta: 1 },
    );
    expect(garbage.lanes.every((l) => Number.isFinite(l.finalPct) && Number.isFinite(l.shrunkNetR))).toBe(true);
    expect(checkCortexInvariants(garbage).ok).toBe(true);
  });

  it("6) β=0 still reproduces the exact static incumbent even with a NEUTRAL lane in the mix", () => {
    const st = stateWithBias({ NEUTRAL: 5, BREADTH: 5 });
    const d = decideCortex(
      ctx({ lanes: [ref({ staticWeightPct: 25 }), neutral({ laneNetAvgR: 0.15, laneNetAvgN: 200, staticWeightPct: 15 })] }),
      st,
      { beta: 0 },
    );
    expect(find(d, "REF_LONG").finalPct).toBeCloseTo(25, 6);
    expect(find(d, "CROSS_SECTIONAL_MARKET_NEUTRAL").finalPct).toBeCloseTo(15, 6);
  });
});

describe("cortex — β=0 == POST-FEDERATED-VETO incumbent, NOT the raw preset (wording-precision guard)", () => {
  // The honest claim is NOT "β=0 == raw static preset". It is "β=0 == what the incumbent federated system
  // actually allocates today" = the static table with proven-negative/vetoed lanes hard-zeroed (the same
  // edge-memory VETO / controller NO_TRADE the live system already applies), then gross-scaled. These tests
  // pin that exact behavior by comparing against an INDEPENDENTLY-computed post-veto incumbent.
  it("zeroes vetoed lanes exactly like the live federated veto; keeps eligible lanes at static (G=1)", () => {
    const lanes = [
      lane({ laneId: "KEEP_A", direction: "LONG", staticWeightPct: 30, vetoed: false }),
      lane({ laneId: "KEEP_B", direction: "SHORT", staticWeightPct: 25, vetoed: false }),
      lane({ laneId: "VETOED", direction: "LONG", staticWeightPct: 20, vetoed: true }), // proven-negative
    ];
    const d = decideCortex(ctx({ lanes, killBudgetUtilization: 0 }), emptyCortexState(), { beta: 0 });
    // Independently-computed post-federated incumbent: vetoed → 0, others → static × G(=1). No lib helper used.
    const incumbent: Record<string, number> = { KEEP_A: 30, KEEP_B: 25, VETOED: 0 };
    for (const l of d.lanes) expect(l.finalPct).toBeCloseTo(incumbent[l.laneId]!, 6);
    // Distinct from the RAW preset — which would keep VETOED at 20.
    expect(d.lanes.find((l) => l.laneId === "VETOED")!.finalPct).not.toBeCloseTo(20, 6);
    expect(d.lanes.find((l) => l.laneId === "VETOED")!.reason).toContain("veto");
  });

  it("applies the incumbent's gross deleverage at β=0 (static × G), vetoed lane still zeroed", () => {
    const lanes = [
      lane({ laneId: "KEEP", direction: "SHORT", staticWeightPct: 40, vetoed: false }),
      lane({ laneId: "VETOED", direction: "LONG", staticWeightPct: 10, vetoed: true }),
    ];
    // killBudgetUtilization 0.55 ⇒ gradual band ⇒ G=0.8 (independent hand-calc: 1−((0.55−0.4)/0.3)·0.4).
    const G = 0.8;
    const d = decideCortex(ctx({ lanes, killBudgetUtilization: 0.55 }), emptyCortexState(), { beta: 0 });
    expect(d.grossG).toBeCloseTo(G, 6);
    expect(d.lanes.find((l) => l.laneId === "KEEP")!.finalPct).toBeCloseTo(40 * G, 6);
    expect(d.lanes.find((l) => l.laneId === "VETOED")!.finalPct).toBe(0);
  });
});

describe("cortex — journal magnitude audit trail (pre-cap edge → post-cap magnitude → learned → final)", () => {
  it("decision carries edgeEstimatePreCap, post-cap allocationMagnitude, and a magnitudeCapped flag", () => {
    const st = emptyCortexState();
    // NEUTRAL lane with a huge own-edge (pre-cap ≫ 0.5) hits the cap; a small-edge one does not.
    const big = lane({ laneId: "CROSS_SECTIONAL_MARKET_NEUTRAL", archetype: "NEUTRAL", direction: "NEUTRAL", edgeMemAvgNetR: null, edgeMemN: 0, laneNetAvgR: 2.0, laneNetAvgN: 1000, staticWeightPct: 20 });
    const small = lane({ laneId: "CG_MFE_GIVEBACK", archetype: "NEUTRAL", direction: "NEUTRAL", edgeMemAvgNetR: null, edgeMemN: 0, laneNetAvgR: 0.05, laneNetAvgN: 1000, staticWeightPct: 10 });
    const d = decideCortex(ctx({ lanes: [big, small] }), st, { beta: 0.3 });
    const b = d.lanes.find((l) => l.laneId === "CROSS_SECTIONAL_MARKET_NEUTRAL")!;
    const s = d.lanes.find((l) => l.laneId === "CG_MFE_GIVEBACK")!;
    expect(b.edgeEstimatePreCap).toBeGreaterThan(0.5); // pre-cap ~2R
    expect(b.allocationMagnitude).toBeCloseTo(0.5, 6); // post-cap == ceiling
    expect(b.magnitudeCapped).toBe(true); // XSEC hammering the cap is visible
    expect(s.allocationMagnitude).toBeCloseTo(0.05 * (1000 / 1040), 3); // small edge un-capped
    expect(s.magnitudeCapped).toBe(false);
    // and the same four fields survive into the journalled BRAIN_DECISION record
    const rec = buildCortexDecisionRecord({ atIso: "2026-07-12T00:00:00Z", mode: "shadow", ctx: ctx({ lanes: [big, small] }), decision: d, invariants: checkCortexInvariants(d) }) as Record<string, unknown>;
    const laneRec = (rec.lanes as Array<Record<string, unknown>>).find((l) => l.laneId === "CROSS_SECTIONAL_MARKET_NEUTRAL")!;
    for (const k of ["edgeEstimatePreCap", "allocationMagnitude", "magnitudeCapped", "learnedPct", "finalPct"]) {
      expect(laneRec).toHaveProperty(k);
    }
    expect(laneRec.magnitudeCapped).toBe(true);
  });
});
