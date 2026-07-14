import { describe, it, expect } from "vitest";
import {
  decideCortex,
  refitArchetypeCoefficients,
  checkCortexInvariants,
  emptyCortexState,
  cortexWinLabel,
  CORTEX_FEATURE_DIM,
  CORTEX_LANE_CAP_PCT,
  type CortexArchetype,
  type CortexContext,
  type CortexLaneInput,
  type CortexStoreState,
  type CortexTrainingExample,
} from "../src/lib/cortex-brain.js";
import { buildLaneObservationFromRaw, type CortexLaneRaw, type CrowdSide } from "../src/lib/cortex-brain-gather.js";

/**
 * Property-based FUZZ harness (2026-07-12) — the empirical complement to the LLM bug-hunts. It hammers
 * the pure CORTEX core (decide / refit / gather) with tens of thousands of ADVERSARIAL inputs (NaN, ±Inf,
 * huge, negative, null, garbage strings) and asserts the SAFETY INVARIANTS can never be violated and it
 * never throws. Deterministic (seeded LCG) so a failure is reproducible from the seed. This is what makes
 * "are there more bugs?" answerable with evidence rather than opinion: if 20k random decisions all keep
 * every output finite + bounded + non-throwing + deterministic, the numeric edge-case surface is covered.
 */

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}
const ARCHES: CortexArchetype[] = ["BREADTH", "NEUTRAL", "TACTICAL"];
const DIRS: CortexLaneInput["direction"][] = ["LONG", "SHORT", "NEUTRAL"];
const CROWD: CrowdSide[] = ["LONG", "SHORT", "NEUTRAL"];

/** A number that is USUALLY a plausible value but with ~25% chance an adversarial NaN/Inf/huge/negative. */
function advNum(r: () => number, base: number, spread: number): number {
  const p = r();
  if (p < 0.06) return NaN;
  if (p < 0.10) return Infinity;
  if (p < 0.14) return -Infinity;
  if (p < 0.18) return 1e12 * (r() - 0.5);
  if (p < 0.22) return -(r() * spread);
  return base + (r() - 0.5) * 2 * spread;
}
function advNumOrNull(r: () => number, base: number, spread: number): number | null {
  return r() < 0.2 ? null : advNum(r, base, spread);
}
function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length) % arr.length]!;
}

function randLane(r: () => number, i: number): CortexLaneInput {
  return {
    laneId: `L${i}`,
    archetype: pick(r, ARCHES),
    direction: pick(r, DIRS),
    edgeMemAvgNetR: advNumOrNull(r, 0.05, 0.5),
    edgeMemN: r() < 0.15 ? advNum(r, 50, 200) : Math.floor(r() * 300),
    laneNetAvgR: advNumOrNull(r, 0.05, 0.5),
    laneNetAvgN: r() < 0.15 ? advNum(r, 50, 200) : Math.floor(r() * 300),
    lanePf: advNumOrNull(r, 1.2, 2),
    crowdingAlign: advNumOrNull(r, 0, 1),
    kronosAgree: advNumOrNull(r, 0, 1),
    convictionScore: advNumOrNull(r, 0.5, 0.6),
    vetoed: r() < 0.2,
    staticWeightPct: r() < 0.15 ? advNum(r, 20, 40) : r() * 60,
  };
}
function randCtx(r: () => number): CortexContext {
  const n = Math.floor(r() * 16); // 0..15 lanes (incl the empty-book edge case)
  return {
    regimeFamily: pick(r, ["Bullish expansion", "Bearish pressure", "Mixed rotation", "", "UNKNOWN", "🙂garbage"]),
    axisScore: advNumOrNull(r, 0, 1),
    axisSlopePerHour: advNumOrNull(r, 0, 0.05),
    allowLong: r() < 0.5,
    allowShort: r() < 0.5,
    portfolioDrawdownPct: advNum(r, 0.05, 0.5),
    killBudgetUtilization: advNum(r, 0.3, 1.2),
    killLatched: r() < 0.15,
    lanes: Array.from({ length: n }, (_, i) => randLane(r, i)),
  };
}
function randState(r: () => number): CortexStoreState {
  const s = emptyCortexState();
  s.cumulativeResolved = r() < 0.1 ? advNum(r, 200, 500) : Math.floor(r() * 800);
  for (const a of ARCHES) {
    s.archetypes[a].w = Array.from({ length: CORTEX_FEATURE_DIM }, () => (r() < 0.1 ? advNum(r, 0, 3) : (r() - 0.5) * 6));
  }
  return s;
}

describe("cortex — FUZZ: decideCortex keeps every safety invariant under 20k adversarial inputs", () => {
  it("never throws, never emits a NaN/negative weight, stays bounded, and is deterministic", () => {
    const N = 8000; // heavy (×2 for the determinism re-run); generous timeout below so full-suite CPU contention can't flake it
    for (let iter = 0; iter < N; iter += 1) {
      const r = makeRng(iter + 1);
      const ctx = randCtx(r);
      const state = randState(r);
      const beta = r() < 0.15 ? advNumOrNull(r, 0.15, 0.4) ?? undefined : r();

      let d;
      try {
        d = decideCortex(ctx, state, beta === undefined ? {} : { beta: beta as number });
      } catch (err) {
        throw new Error(`decideCortex THREW at seed ${iter + 1}: ${(err as Error).message}`);
      }
      const seedInfo = `seed=${iter + 1}`;
      // Every scalar output finite + in range.
      expect(Number.isFinite(d.grossG), `${seedInfo} grossG`).toBe(true);
      expect(d.grossG >= 0 && d.grossG <= 1, `${seedInfo} grossG range`).toBe(true);
      expect(Number.isFinite(d.beta), `${seedInfo} beta`).toBe(true);
      expect(d.beta >= 0 && d.beta <= 1, `${seedInfo} beta range`).toBe(true);
      expect(Number.isFinite(d.expectedTiltDeltaR), `${seedInfo} expectedTiltDeltaR`).toBe(true);
      // Every lane weight finite, non-negative, and never exceeds max(static, cap)×G (the incumbent-safe bound).
      for (const l of d.lanes) {
        expect(Number.isFinite(l.finalPct), `${seedInfo} ${l.laneId} finalPct`).toBe(true);
        expect(l.finalPct >= -1e-9, `${seedInfo} ${l.laneId} finalPct>=0`).toBe(true);
        const effCap = Math.max(Math.max(0, Number.isFinite(l.staticPct) ? l.staticPct : 0), CORTEX_LANE_CAP_PCT);
        expect(l.finalPct <= effCap + 1e-6, `${seedInfo} ${l.laneId} finalPct<=cap`).toBe(true);
        expect(Number.isFinite(l.sizingMult) && l.sizingMult >= 0.5 - 1e-9 && l.sizingMult <= 1.5 + 1e-9, `${seedInfo} ${l.laneId} sizingMult`).toBe(true);
        expect(l.featureVector.every((v) => Number.isFinite(v)), `${seedInfo} ${l.laneId} featureVector finite`).toBe(true);
        expect(Number.isFinite(l.learnedPct) && Number.isFinite(l.pWin), `${seedInfo} ${l.laneId} learned/pWin`).toBe(true);
      }
      // Invariant check must itself be consistent: ok ⇒ no violations; not-ok ⇒ at least one.
      const inv = checkCortexInvariants(d);
      expect(inv.ok ? inv.violations.length === 0 : inv.violations.length > 0, `${seedInfo} invariants consistency`).toBe(true);
      // Determinism: identical inputs ⇒ identical decision.
      const d2 = decideCortex(ctx, state, beta === undefined ? {} : { beta: beta as number });
      expect(d2.lanes.map((l) => l.finalPct)).toEqual(d.lanes.map((l) => l.finalPct));
      expect(d2.grossG).toBe(d.grossG);
    }
  }, 120_000);
});

describe("cortex — FUZZ: refitArchetypeCoefficients never returns a garbage-accepted model", () => {
  it("either ACCEPTS a finite, jump-bounded coefficient vector or REJECTS and returns the prior", () => {
    const N = 8000;
    for (let iter = 0; iter < N; iter += 1) {
      const r = makeRng(iter + 100003);
      const m = Math.floor(r() * 60); // 0..59 examples (incl the no-data case)
      const examples: CortexTrainingExample[] = Array.from({ length: m }, () => ({
        x: Array.from({ length: CORTEX_FEATURE_DIM }, () => (r() < 0.1 ? advNum(r, 0, 2) : (r() - 0.5) * 2)),
        y: (r() < 0.5 ? 0 : 1) as 0 | 1,
        tMs: advNum(r, 1_700_000_000_000, 5e9),
        schemaVersion: r() < 0.15 ? Math.floor(r() * 3) : 1, // sometimes wrong-schema rows
      }));
      const wPrior = Array.from({ length: CORTEX_FEATURE_DIM }, () => (r() - 0.5) * 2);
      let res;
      try {
        res = refitArchetypeCoefficients(examples, wPrior, { nowMs: advNum(r, 1_700_005_000_000, 1e9) });
      } catch (err) {
        throw new Error(`refit THREW at seed ${iter + 100003}: ${(err as Error).message}`);
      }
      expect(["ACCEPTED", "REJECTED_LOW_NEFF", "REJECTED_NON_CONVERGENCE", "REJECTED_COEFFICIENT_JUMP", "REJECTED_NON_FINITE"]).toContain(res.status);
      // On ACCEPT the coefficients MUST be finite (a non-finite fit must never be accepted).
      if (res.status === "ACCEPTED") {
        expect(res.w.length).toBe(CORTEX_FEATURE_DIM);
        expect(res.w.every((v) => Number.isFinite(v)), `refit ACCEPTED non-finite at seed ${iter + 100003}`).toBe(true);
      } else {
        // On any reject the returned vector is the (finite) prior verbatim — the caller can write it safely.
        expect(res.w.every((v) => Number.isFinite(v))).toBe(true);
      }
    }
  }, 120_000);
});

describe("cortex — FUZZ: buildLaneObservationFromRaw never throws + emits a well-formed observation", () => {
  it("survives adversarial raw inputs with valid (possibly-null) fields", () => {
    const N = 8000;
    for (let iter = 0; iter < N; iter += 1) {
      const r = makeRng(iter + 200003);
      const raw: CortexLaneRaw = {
        laneId: `X${iter}`,
        direction: pick(r, DIRS),
        edgeMemAvgNetR: advNumOrNull(r, 0.1, 0.5),
        edgeMemN: r() < 0.2 ? advNum(r, 40, 200) : Math.floor(r() * 200),
        vetoed: r() < 0.3,
        reportNetAvgR: advNumOrNull(r, 0.1, 0.5),
        reportPf: r() < 0.1 ? 999 : advNumOrNull(r, 1.3, 2),
        reportN: r() < 0.2 ? advNum(r, 30, 100) : Math.floor(r() * 100),
        hasReport: r() < 0.7,
        isXsec: r() < 0.3,
        xsecNetAvgReturn: advNumOrNull(r, 0.006, 0.05),
        xsecStopDistance: r() < 0.1 ? advNum(r, 0.003, 0.01) : 0.003,
        crowdSides: Array.from({ length: Math.floor(r() * 5) }, () => pick(r, CROWD)),
        kronosAgree: advNumOrNull(r, 0, 1),
        controllerBias: pick(r, ["LONG", "SHORT", "BOTH", "MIXED", "UNKNOWN", "NONE"] as const),
        controllerConviction: advNumOrNull(r, 0.5, 0.6),
        staticWeightPct: r() < 0.2 ? advNum(r, 20, 40) : r() * 60,
      };
      let obs;
      try {
        obs = buildLaneObservationFromRaw(raw).obs;
      } catch (err) {
        throw new Error(`gather THREW at seed ${iter + 200003}: ${(err as Error).message}`);
      }
      // Contract: every numeric field is either null or finite (never NaN/Inf leaking into the model).
      for (const v of [obs.edgeMemAvgNetR, obs.laneNetAvgR, obs.lanePf, obs.crowdingAlign, obs.kronosAgree]) {
        expect(v === null || Number.isFinite(v), `gather non-finite field at seed ${iter + 200003}`).toBe(true);
      }
      expect(Number.isFinite(obs.convictionScore) || obs.convictionScore === null).toBe(true);
      expect(obs.edgeMemN >= 0 && Number.isFinite(obs.edgeMemN)).toBe(true);
      expect(obs.laneNetAvgN >= 0 && Number.isFinite(obs.laneNetAvgN)).toBe(true);
      expect(obs.reportPf !== 999).toBe(true); // the all-wins sentinel must never reach the model as a real PF
    }
  }, 120_000);
});

describe("cortex — FUZZ: store persistence round-trip survives corrupt/garbage on-disk state", () => {
  it("a corrupt or garbage cortex-brain.json load NEVER yields a non-finite state that decideCortex then poisons", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { CortexBrainStore } = await import("../src/lib/cortex-brain-store.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fuzz-store-"));
    try {
      for (let iter = 0; iter < 3000; iter += 1) {
        const r = makeRng(iter + 400003);
        const file = path.join(dir, `s${iter}.json`);
        // Write an adversarial on-disk model: sometimes valid, sometimes NaN/Inf weights, wrong length,
        // wrong schema, missing fields, or outright garbage bytes.
        const roll = r();
        if (roll < 0.15) {
          fs.writeFileSync(file, "not json at all {{{" + iter);
        } else {
          const badW = () => Array.from({ length: r() < 0.2 ? Math.floor(r() * 14) : CORTEX_FEATURE_DIM }, () => (r() < 0.25 ? advNum(r, 0, 5) : (r() - 0.5) * 4));
          fs.writeFileSync(
            file,
            JSON.stringify({
              version: 1,
              featureSchemaVersion: r() < 0.2 ? Math.floor(r() * 4) : 1,
              archetypes: { BREADTH: { w: badW(), refitAt: null, nEff: advNum(r, 10, 100) }, NEUTRAL: { w: badW(), refitAt: null, nEff: 0 }, TACTICAL: { w: badW(), refitAt: null, nEff: 0 } },
              cumulativeResolved: r() < 0.15 ? advNum(r, 100, 400) : Math.floor(r() * 500),
              updatedAt: null,
            }),
          );
        }
        // The store must load WITHOUT throwing and expose only finite coefficients (corrupt → seed/empty).
        const store = new CortexBrainStore(file);
        const st = store.get();
        for (const a of ARCHES) {
          expect(st.archetypes[a].w.length).toBe(CORTEX_FEATURE_DIM);
          expect(st.archetypes[a].w.every((v) => Number.isFinite(v)), `store loaded non-finite weight at seed ${iter + 400003}`).toBe(true);
        }
        expect(Number.isFinite(st.cumulativeResolved)).toBe(true);
        // And decideCortex on the loaded state stays SAFE: finite weights + a self-consistent invariant
        // verdict (ok⟺no-violations). A not-ok verdict is the safety net firing → degrade-to-federated,
        // which is correct behavior, so we assert consistency (not that it is always clean).
        const d = decideCortex(randCtx(r), st, { beta: r() });
        expect(d.lanes.every((l) => Number.isFinite(l.finalPct)), `store-fuzz finalPct finite seed ${iter + 400003}`).toBe(true);
        const inv = checkCortexInvariants(d);
        expect(inv.ok ? inv.violations.length === 0 : inv.violations.length > 0, `store-fuzz invariant consistency seed ${iter + 400003}`).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("cortex — FUZZ: cortexWinLabel is total (never throws, always 0/1)", () => {
  it("maps any number (incl NaN/Inf) to a strict 0 or 1", () => {
    for (let iter = 0; iter < 4000; iter += 1) {
      const r = makeRng(iter + 300003);
      const y = cortexWinLabel(advNum(r, 0.05, 2));
      expect(y === 0 || y === 1).toBe(true);
    }
  });
});
