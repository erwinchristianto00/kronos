import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candle } from "@dtc/shared";

import {
  OUTCOME_ONLY_FIELDS,
  assertCandlesClosedAsOf,
  assertDecisionTimeSafe,
} from "../src/lib/live-edge-digger-types.js";
import { buildMarketFeatures, type SymbolCycleInput } from "../src/lib/live-edge-digger-features.js";
import {
  EDGE_RULE_FRONTIER,
  MAX_ENUMERATED_RULES,
  candidateIdFor,
  ruleContentHash,
  type EdgeRule,
} from "../src/lib/live-edge-digger-grammar.js";
import {
  MAX_ACTIVE_GENERATED,
  MAX_GENERATED_PER_CYCLE,
  MAX_GENERATED_PER_DAY,
  MAX_GENERATED_PREDICATES,
  generateHypotheses,
} from "../src/lib/live-edge-digger-hypotheses.js";
import {
  EPISODE_BLOCK_WIDTH_MS,
  MIN_EPISODES_TO_JUDGE,
  buildCandidateReport,
  buildLiveEdgeDiggerReport,
  candidateMetrics,
  clusterBootstrap,
  emitShadowSignals,
  freezeCandidate,
  independentEpisodes,
  resolveShadowObservation,
  type ShadowObservation,
} from "../src/lib/live-edge-digger.js";
import {
  COLLECTION_POLICY_VERSION,
  admitUnderPolicyV2,
  isJudgeableEvidence,
  isMatured,
} from "../src/lib/live-edge-digger-collection-policy.js";
import {
  LiveEdgeDiggerStore,
  buildLiveEdgeDiggerReportFromStore,
  runLiveEdgeDiggerCycle,
  _resetLiveEdgeDiggerCycleLatchForTests,
} from "../src/lib/live-edge-digger-cycle.js";

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  _resetLiveEdgeDiggerCycleLatchForTests();
});
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "led-"));
  dirs.push(dir);
  return dir;
}

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 7, 1);

/** Deterministic candle series. `drift` is per-bar fractional change. */
function candles(count: number, startMs: number, startPrice: number, drift = 0, intervalMs = HOUR): Candle[] {
  const out: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    price = price * (1 + drift);
    const high = Math.max(open, price) * 1.004;
    const low = Math.min(open, price) * 0.996;
    out.push({ openTime: startMs + i * intervalMs, open, high, low, close: price, volume: 1000 } as Candle);
  }
  return out;
}

function symbolInput(symbol: string, opts: {
  bars?: number; drift?: number; startPrice?: number; fundingBps?: number | null; spreadBps?: number | null;
  quoteVolume?: number | null; asOfMs?: number;
} = {}): SymbolCycleInput {
  const bars = opts.bars ?? 120;
  const asOf = opts.asOfMs ?? BASE + bars * HOUR;
  const start = asOf - bars * HOUR;
  return {
    symbol,
    hourly: candles(bars, start, opts.startPrice ?? 100, opts.drift ?? 0),
    fifteenMin: candles(8, asOf - 8 * 900_000, opts.startPrice ?? 100, 0, 900_000),
    snapshot: {
      quoteVolume24hUsd: opts.quoteVolume ?? 500_000_000,
      spreadBps: opts.spreadBps ?? 2,
      topDepthUsd: null,
      fundingBps: opts.fundingBps ?? 0,
      basisBps: null,
      openInterestUsd: 50_000_000,
    },
  };
}

describe("live-edge-digger", () => {
  // =========================================================================
  // LEAKAGE
  // =========================================================================
  describe("leakage", () => {
    it("rejects any rule input naming an outcome-only field", () => {
      expect(() => assertDecisionTimeSafe(["residualRank", "netR"], "test rule")).toThrow(/netR/);
      expect(() => assertDecisionTimeSafe(["residualRank", "atrPercentile"], "test rule")).not.toThrow();
    });

    it("costR and every post-entry excursion field are classified outcome-only", () => {
      for (const f of ["costR", "netR", "grossR", "exitPrice", "maxFavorableR", "maxAdverseR", "holdBars"]) {
        expect(OUTCOME_ONLY_FIELDS, `${f} must be outcome-only`).toContain(f);
      }
    });

    it("no rule in the frontier conditions on an outcome-only field", () => {
      for (const rule of EDGE_RULE_FRONTIER) {
        const keys = Object.keys(rule.predicates);
        expect(() => assertDecisionTimeSafe(keys, rule.ruleId)).not.toThrow();
      }
    });

    it("a candle that has NOT closed at the decision instant is rejected outright", () => {
      const asOf = BASE + 10 * HOUR;
      // Final bar opens at asOf, so it closes an hour AFTER the decision — the classic forming-bar leak.
      const withForming = candles(11, BASE, 100);
      expect(() => assertCandlesClosedAsOf(withForming, HOUR, asOf, "test")).toThrow(/had not closed/);
      // Drop it and the same series is fine.
      expect(() => assertCandlesClosedAsOf(withForming.slice(0, 10), HOUR, asOf, "test")).not.toThrow();
    });

    it("buildMarketFeatures refuses a universe containing a forming bar", () => {
      const asOf = BASE + 50 * HOUR;
      const bad: SymbolCycleInput = {
        symbol: "BTCUSDT",
        hourly: candles(51, BASE, 100), // last bar opens exactly at asOf
        fifteenMin: [],
        snapshot: { quoteVolume24hUsd: 1, spreadBps: 1, topDepthUsd: null, fundingBps: 0, basisBps: null, openInterestUsd: 1 },
      };
      expect(() => buildMarketFeatures({
        asOfMs: asOf, regime: "x", regimeFamily: "MIXED", benchmarkSymbol: "BTCUSDT", symbols: [bad],
      })).toThrow(/had not closed/);
    });

    it("every emitted feature snapshot is provably as-of the decision instant", () => {
      const asOf = BASE + 120 * HOUR;
      const market = buildMarketFeatures({
        asOfMs: asOf, regime: "Bullish expansion", regimeFamily: "BULLISH", benchmarkSymbol: "BTCUSDT",
        symbols: [symbolInput("BTCUSDT", { asOfMs: asOf }), symbolInput("ETHUSDT", { asOfMs: asOf, drift: 0.001 })],
      });
      expect(market.symbols.length).toBe(2);
      for (const s of market.symbols) {
        expect(s.asOfMs).toBe(asOf);
        expect(s.lastClosedCandleCloseMs).toBeLessThanOrEqual(asOf);
      }
    });
  });

  // =========================================================================
  // BOUNDED DISCOVERY / MULTIPLE TESTING
  // =========================================================================
  describe("bounded discovery and multiple testing", () => {
    it("the frontier is hard-capped and every rule is uniquely identified", () => {
      expect(EDGE_RULE_FRONTIER.length).toBeLessThanOrEqual(MAX_ENUMERATED_RULES);
      expect(new Set(EDGE_RULE_FRONTIER.map((r) => r.ruleId)).size).toBe(EDGE_RULE_FRONTIER.length);
      expect(new Set(EDGE_RULE_FRONTIER.map((r) => candidateIdFor(r))).size).toBe(EDGE_RULE_FRONTIER.length);
    });

    it("every rule carries a stated thesis and predeclared rejection rules — none is an unexplained fit", () => {
      for (const rule of EDGE_RULE_FRONTIER) {
        expect(rule.thesis.length, rule.ruleId).toBeGreaterThan(40);
        expect(rule.rejectionRules.length, rule.ruleId).toBeGreaterThan(0);
        expect(rule.geometry.stopAtrMultiple).toBeGreaterThan(0);
        expect(rule.geometry.maxHoldHours).toBeGreaterThan(0);
      }
    });

    it("the attempt registry records EVERY rule evaluated each cycle, including those that never fire", () => {
      const asOf = BASE + 120 * HOUR;
      const market = buildMarketFeatures({
        asOfMs: asOf, regime: "Bullish expansion", regimeFamily: "BULLISH", benchmarkSymbol: "BTCUSDT",
        symbols: [symbolInput("BTCUSDT", { asOfMs: asOf }), symbolInput("ETHUSDT", { asOfMs: asOf, drift: 0.002 })],
      });
      const { attempts } = emitShadowSignals(market, "cycle-1", new Date(asOf).toISOString());
      // One entry per rule in the frontier — a non-firing rule is still a test that was run.
      expect(attempts.length).toBe(EDGE_RULE_FRONTIER.length);
      const fired = attempts.filter((a) => a.emitted > 0);
      expect(fired.length).toBeLessThanOrEqual(attempts.length);
    });

    it("caps how many correlated signals one cycle may emit per candidate", () => {
      const asOf = BASE + 120 * HOUR;
      // 12 symbols that all satisfy the same rule — without a cap this would be 12 correlated rows.
      const symbols = ["BTCUSDT", ...Array.from({ length: 11 }, (_, i) => `ALT${i}USDT`)]
        .map((s) => symbolInput(s, { asOfMs: asOf, drift: s === "BTCUSDT" ? 0 : 0.002 }));
      const market = buildMarketFeatures({
        asOfMs: asOf, regime: "Bullish expansion", regimeFamily: "BULLISH", benchmarkSymbol: "BTCUSDT", symbols,
      });
      const { observations } = emitShadowSignals(market, "cycle-1", new Date(asOf).toISOString());
      const byCandidate = new Map<string, number>();
      for (const o of observations) byCandidate.set(o.candidateId, (byCandidate.get(o.candidateId) ?? 0) + 1);
      for (const [, count] of byCandidate) expect(count).toBeLessThanOrEqual(3);
    });
  });

  // =========================================================================
  // FREEZING
  // =========================================================================
  describe("freezing", () => {
    it("the content hash covers meaning, not prose — editing the thesis does not mint a new candidate", () => {
      const rule = EDGE_RULE_FRONTIER[0]!;
      const reworded: EdgeRule = { ...rule, thesis: "completely different wording", title: "new title" };
      expect(ruleContentHash(reworded)).toBe(ruleContentHash(rule));
      expect(candidateIdFor(reworded)).toBe(candidateIdFor(rule));
    });

    it("changing a threshold, a direction, or the geometry DOES mint a new candidate id", () => {
      const rule = EDGE_RULE_FRONTIER[0]!;
      const base = candidateIdFor(rule);
      const retuned: EdgeRule = {
        ...rule,
        predicates: { ...rule.predicates, residualRank: { max: 0.25 } },
      };
      const flipped: EdgeRule = { ...rule, direction: rule.direction === "LONG" ? "SHORT" : "LONG" };
      const wider: EdgeRule = { ...rule, geometry: { ...rule.geometry, stopAtrMultiple: 99 } };
      expect(candidateIdFor(retuned)).not.toBe(base);
      expect(candidateIdFor(flipped)).not.toBe(base);
      expect(candidateIdFor(wider)).not.toBe(base);
    });

    it("the hash is stable across key ordering — an equivalent rule never hashes two ways", () => {
      const rule = EDGE_RULE_FRONTIER[0]!;
      const reordered: EdgeRule = {
        ...rule,
        predicates: Object.fromEntries(Object.entries(rule.predicates).reverse()) as EdgeRule["predicates"],
      };
      expect(ruleContentHash(reordered)).toBe(ruleContentHash(rule));
    });
  });

  // =========================================================================
  // RESOLUTION HONESTY
  // =========================================================================
  describe("resolution", () => {
    const openObs = (overrides: Partial<ShadowObservation> = {}): ShadowObservation => ({
      observationId: "o1", candidateId: "c1", contentHash: "h", symbol: "BTCUSDT", direction: "LONG",
      cycleId: "cycle-1", openedAt: new Date(BASE).toISOString(), openedAtMs: BASE,
      entryPrice: 100, stopPrice: 98, targetPrice: 103, stopDistanceBps: 200, maxHoldHours: 24,
      regimeAtEntry: "Bullish expansion", features: {} as never,
      status: "OPEN", resolvedAt: null, exitPrice: null, exitReason: null,
      grossR: null, costR: null, netR: null, holdHours: null,
      ...overrides,
    });

    it("a bar containing BOTH stop and target resolves as the STOP — never the favourable fill", () => {
      const obs = openObs();
      const bar: Candle = { openTime: BASE + HOUR, open: 100, high: 104, low: 97, close: 101, volume: 1 } as Candle;
      const out = resolveShadowObservation(obs, [bar]);
      expect(out.exitReason).toBe("AMBIGUOUS_STOP_FIRST");
      expect(out.exitPrice).toBe(98);
      expect(out.grossR).toBeCloseTo(-1, 9);
      expect(out.netR!).toBeLessThan(out.grossR!); // costs always make it worse, never better
    });

    it("charges taker round-trip, stop slippage and funding — and a stop pays more than a target", () => {
      const stopped = resolveShadowObservation(openObs(),
        [{ openTime: BASE + HOUR, open: 100, high: 100.5, low: 97, close: 98, volume: 1 } as Candle]);
      const won = resolveShadowObservation(openObs(),
        [{ openTime: BASE + HOUR, open: 100, high: 104, low: 99.5, close: 103, volume: 1 } as Candle]);
      expect(stopped.exitReason).toBe("STOP");
      expect(won.exitReason).toBe("TARGET");
      // Both pay the round trip; only the stop pays slippage.
      expect(Math.abs(stopped.costR!)).toBeGreaterThan(Math.abs(won.costR!));
      expect(won.netR!).toBeLessThan(won.grossR!);
    });

    it("stays OPEN when the horizon has not yet elapsed — never marked early at the current price", () => {
      const obs = openObs({ maxHoldHours: 24 });
      const out = resolveShadowObservation(obs,
        [{ openTime: BASE + HOUR, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 } as Candle]);
      expect(out.status).toBe("OPEN");
      expect(out.netR).toBeNull();
    });

    it("closes at mark-to-market once the horizon has fully elapsed", () => {
      const obs = openObs({ maxHoldHours: 3 });
      const bars = Array.from({ length: 6 }, (_, i) => ({
        openTime: BASE + (i + 1) * HOUR, open: 100, high: 100.4, low: 99.6, close: 100.2, volume: 1,
      } as Candle));
      const out = resolveShadowObservation(obs, bars);
      expect(out.exitReason).toBe("MAX_HOLD_MTM");
      expect(out.status).toBe("CLOSED_TIMEOUT");
    });

    it("a SHORT resolves with inverted geometry", () => {
      const obs = openObs({ direction: "SHORT", entryPrice: 100, stopPrice: 102, targetPrice: 97 });
      const out = resolveShadowObservation(obs,
        [{ openTime: BASE + HOUR, open: 100, high: 100.5, low: 96, close: 97, volume: 1 } as Candle]);
      expect(out.exitReason).toBe("TARGET");
      expect(out.grossR!).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // CLUSTERING
  // =========================================================================
  describe("episode clustering", () => {
    const rowsInCycle = (cycleId: string, openedAtMs: number, n: number, netR: number): ShadowObservation[] =>
      Array.from({ length: n }, (_, i) => ({
        observationId: `${cycleId}-${i}`, candidateId: "c1", contentHash: "h", symbol: `S${i}USDT`,
        direction: "LONG" as const, cycleId, openedAt: new Date(openedAtMs).toISOString(), openedAtMs,
        entryPrice: 100, stopPrice: 98, targetPrice: 103, stopDistanceBps: 200, maxHoldHours: 24,
        regimeAtEntry: "r", features: {} as never, status: "CLOSED_WIN" as const,
        resolvedAt: new Date(openedAtMs + HOUR).toISOString(), exitPrice: 103, exitReason: "TARGET" as const,
        grossR: netR, costR: -0.1, netR, holdHours: 1,
      }));

    it("40 symbols fired by ONE cycle are ONE independent episode, not 40", () => {
      const rows = rowsInCycle("cycle-1", BASE, 40, 1);
      expect(rows.length).toBe(40);
      expect(independentEpisodes(rows)).toBe(1);
    });

    it("separate cycles beyond the block width are separate episodes", () => {
      const rows = [
        ...rowsInCycle("cycle-1", BASE, 5, 1),
        ...rowsInCycle("cycle-2", BASE + EPISODE_BLOCK_WIDTH_MS + HOUR, 5, 1),
      ];
      expect(independentEpisodes(rows)).toBe(2);
    });

    // Added after a SURVIVING mutant: replacing the cycleId merge key with a per-row key changed
    // nothing, because openedAt chaining already collapses same-instant rows. Both mechanisms
    // independently enforce the discipline — this test pins the one the chain alone does NOT cover:
    // rows sharing a market cause but spread FURTHER APART than the block width. Only the merge key
    // can hold those together, so this is the case that proves it is load-bearing rather than decorative.
    it("rows sharing one market cause stay ONE episode even when spread beyond the block width", () => {
      const spread = [
        ...rowsInCycle("same-cause", BASE, 1, 1),
        ...rowsInCycle("same-cause", BASE + EPISODE_BLOCK_WIDTH_MS + HOUR, 1, 1),
        ...rowsInCycle("same-cause", BASE + 2 * (EPISODE_BLOCK_WIDTH_MS + HOUR), 1, 1),
      ].map((r, i) => ({ ...r, observationId: `spread-${i}` }));
      // Timestamps alone would say 3 draws; the shared cause says 1.
      expect(spread.length).toBe(3);
      expect(independentEpisodes(spread)).toBe(1);
    });

    it("the clustered bootstrap refuses an interval from a single episode, however many rows", () => {
      const rows = rowsInCycle("cycle-1", BASE, 200, 0.42);
      const b = clusterBootstrap(rows);
      expect(b.clusters).toBe(1);
      expect(b.lowerBound95).toBeNull();
      expect(b.note).toContain("fewer than 2 independent episodes");
    });

    it("the bootstrap is deterministic across repeated runs and input order", () => {
      const rows = [
        ...rowsInCycle("c1", BASE, 3, 1),
        ...rowsInCycle("c2", BASE + 40 * HOUR, 3, -1),
        ...rowsInCycle("c3", BASE + 80 * HOUR, 3, 0.5),
      ];
      const a = clusterBootstrap(rows);
      const b = clusterBootstrap(rows.slice().reverse());
      expect(a.lowerBound95).toBe(b.lowerBound95);
      expect(a.upperBound95).toBe(b.upperBound95);
    });
  });

  // =========================================================================
  // METRICS + GATES
  // =========================================================================
  describe("metrics and gates", () => {
    it("PF with no losses is null with pfStatus NO_LOSSES_YET — never a large sentinel", () => {
      const rows: ShadowObservation[] = Array.from({ length: 10 }, (_, i) => ({
        observationId: `w${i}`, candidateId: "c1", contentHash: "h", symbol: "BTCUSDT", direction: "LONG",
        cycleId: `c${i}`, openedAt: new Date(BASE).toISOString(), openedAtMs: BASE + i * 40 * HOUR,
        entryPrice: 100, stopPrice: 98, targetPrice: 103, stopDistanceBps: 200, maxHoldHours: 24,
        regimeAtEntry: "r", features: {} as never, status: "CLOSED_WIN", resolvedAt: "x",
        exitPrice: 103, exitReason: "TARGET", grossR: 1.5, costR: -0.1, netR: 1.4, holdHours: 1,
      }));
      const m = candidateMetrics(rows);
      expect(m.pf).toBeNull();
      expect(m.pfStatus).toBe("NO_LOSSES_YET");
      expect(m.pf).not.toBe(999_999);
    });

    it("[MUTANT-KILL] gates read INDEPENDENT EPISODES, not raw rows — a row-rich, episode-poor DEV slice fails", () => {
      // 5 cycles x 20 rows = 100 rows but only 5 episodes. DEV takes 3 cycles: 60 rows, 3 episodes.
      const rows: ShadowObservation[] = [];
      for (let c = 0; c < 5; c++) {
        for (let i = 0; i < 20; i++) {
          rows.push({
            observationId: `c${c}-r${i}`, candidateId: "c1", contentHash: "h", symbol: `S${i % 9}USDT`,
            direction: "LONG", cycleId: `cycle-${c}`,
            openedAt: new Date(BASE + c * 50 * HOUR).toISOString(), openedAtMs: BASE + c * 50 * HOUR,
            entryPrice: 100, stopPrice: 98, targetPrice: 103, stopDistanceBps: 200, maxHoldHours: 24,
            regimeAtEntry: "r", features: {} as never, collectionPolicyVersion: 2,
            status: "CLOSED_WIN", resolvedAt: "x",
            exitPrice: 103, exitReason: "TARGET", grossR: 1.5, costR: -0.1, netR: 1.4, holdHours: 1,
          });
        }
      }
      // Freeze anchor must PRECEDE the rows, or freeze integrity (correctly) disqualifies the
      // candidate and this test stops isolating what it claims to test. The previous anchor was
      // 2026-08-06, a full 5 days AFTER these rows open — the old single REJECT verdict hid that,
      // because a gate shortfall and a freeze violation both collapsed into the same word.
      const report = buildCandidateReport(freezeCandidate(EDGE_RULE_FRONTIER[0]!, new Date(BASE - HOUR).toISOString()),
        rows.map((r) => ({ ...r, candidateId: candidateIdFor(EDGE_RULE_FRONTIER[0]!) })),
        // Evaluated after every row's horizon has elapsed: gates only see matured evidence now.
        undefined, BASE + 5000 * HOUR);
      expect(report.freezeIntegrity.ok).toBe(true);
      const dev = report.partitions.find((p) => p.partition === "DEV")!;
      expect(dev.rows).toBe(60);
      expect(dev.episodes).toBe(3);
      const devGate = report.gates.find((g) => g.id === "dev_episodes")!;
      expect(devGate.current).toBe(3); // episodes, NOT 60 rows
      expect(devGate.pass).toBe(false);
      // 60 rows collapsing to 3 episodes is IMMATURITY, not a verdict against the rule: the gate is
      // unmet, so it cannot be CANDIDATE, but nothing here disqualifies it either.
      expect(report.lifecycle).toBe("COLLECTING");
      expect(report.rejectionReasons).toEqual([]);
      expect(report.evidenceStillNeeded.join(" ")).toContain("DEV episodes");
    });

    it("[LIFECYCLE-ZERO] a candidate with NO evidence is DORMANT, never REJECTED — absence of evidence is not evidence of absence", () => {
      const report = buildLiveEdgeDiggerReport({
        generatedAt: "2026-08-06T00:00:00.000Z",
        observations: [],
        attempts: [],
        scanner: {
          cyclesRun: 0, lastCycleAt: null, lastError: null, universeSize: null, regime: null,
          regimeFamily: null, breadth: null, cohesion: null, dispersion: null,
        },
      });
      expect(report.verdict).toBe("NO_PROVEN_EDGE_YET");
      expect(report.bestCandidateId).toBeNull();
      expect(report.recommendation).toBeNull();
      expect(report.candidates.length).toBe(EDGE_RULE_FRONTIER.length);
      for (const c of report.candidates) {
        // THE DEFECT THIS TEST NOW PINS: every rule previously read REJECT from its first cycle,
        // because "no resolved forward evidence yet" was pushed into the same list as a genuine
        // economic failure. A rule that has never fired has told us something about the MARKET, and
        // nothing whatsoever about its own edge.
        expect(c.lifecycle).toBe("DORMANT");
        expect(c.rejectionReasons).toEqual([]);
        expect(c.lifecycleReason).toContain("have not occurred");
        expect(c.evidenceStillNeeded.join(" ")).toContain("have not occurred in the live market yet");
      }
      // And the census agrees: nothing is rejected on an empty store.
      expect(report.lifecycleCounts.DORMANT).toBe(EDGE_RULE_FRONTIER.length);
      expect(report.lifecycleCounts.REJECTED).toBe(0);
      expect(report.lifecycleCounts.RECOMMENDED_FOR_3102_REVIEW).toBe(0);
    });

    it("the report is self-describing as report-only and live-blocked", () => {
      const report = buildLiveEdgeDiggerReport({
        generatedAt: "2026-08-06T00:00:00.000Z", observations: [], attempts: [],
        scanner: {
          cyclesRun: 1, lastCycleAt: "x", lastError: null, universeSize: 30, regime: "r",
          regimeFamily: "MIXED", breadth: 0.5, cohesion: 0.5, dispersion: 0.02,
        },
      });
      expect(report.reportOnly).toBe(true);
      expect(report.liveBlocked).toBe(true);
      expect(report.rulesEnumerated).toBe(EDGE_RULE_FRONTIER.length);
    });
  });

  // =========================================================================
  // CYCLE + RESTART
  // =========================================================================
  describe("cycle and restart", () => {
    const deps = (dir: string, now: number) => ({
      store: new LiveEdgeDiggerStore(join(dir, "led.json")),
      now,
      resolveUniverse: async () => ({
        symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT"],
        perSymbolMeta: {
          BTCUSDT: { quoteVolume24hUsd: 9e9, spreadBps: 1, openInterestUsd: 1e9 },
          ETHUSDT: { quoteVolume24hUsd: 5e9, spreadBps: 1, openInterestUsd: 5e8 },
          SOLUSDT: { quoteVolume24hUsd: 1e9, spreadBps: 2, openInterestUsd: 2e8 },
          ADAUSDT: { quoteVolume24hUsd: 5e8, spreadBps: 3, openInterestUsd: 1e8 },
        },
      }),
      getRegime: async () => ({ regime: "Bullish expansion", regimeFamily: "BULLISH" as const }),
      fetchCandles: async (symbol: string, interval: string) => {
        const drift = symbol === "BTCUSDT" ? 0.0005 : symbol === "SOLUSDT" ? 0.004 : -0.002;
        const intervalMs = interval === "15m" ? 900_000 : HOUR;
        const bars = interval === "15m" ? 8 : 120;
        return candles(bars, now - bars * intervalMs, 100, drift, intervalMs);
      },
      fetchFunding: async () => ({ fundingBps: 1, basisBps: 2 }),
    });

    it("runs a full cycle, emits shadow rows, and never throws", async () => {
      const dir = tmpDir();
      const now = BASE + 200 * HOUR;
      const result = await runLiveEdgeDiggerCycle(deps(dir, now));
      expect(result.scanned).toBeGreaterThan(0);
      expect(result.emitted).toBeGreaterThanOrEqual(0);
      expect(result.resolved).toBe(0); // nothing was open on the first cycle
    });

    it("[RESTART] a store reloaded from disk reproduces the identical report", async () => {
      const dir = tmpDir();
      const now = BASE + 200 * HOUR;
      const d = deps(dir, now);
      await runLiveEdgeDiggerCycle(d);
      const before = buildLiveEdgeDiggerReport({
        generatedAt: "2026-08-06T00:00:00.000Z", observations: d.store.all, attempts: d.store.attempts,
        scanner: {
          cyclesRun: d.store.cycleMeta.cycles, lastCycleAt: d.store.cycleMeta.lastCycleAt, lastError: null,
          universeSize: d.store.cycleMeta.lastUniverseSize, regime: d.store.cycleMeta.lastRegime,
          regimeFamily: d.store.cycleMeta.lastRegimeFamily, breadth: d.store.cycleMeta.lastBreadth,
          cohesion: d.store.cycleMeta.lastCohesion, dispersion: d.store.cycleMeta.lastDispersion,
        },
      });
      // Simulate a process restart: brand-new store object over the same file.
      const reloaded = new LiveEdgeDiggerStore(join(dir, "led.json"));
      const after = buildLiveEdgeDiggerReport({
        generatedAt: "2026-08-06T00:00:00.000Z", observations: reloaded.all, attempts: reloaded.attempts,
        scanner: {
          cyclesRun: reloaded.cycleMeta.cycles, lastCycleAt: reloaded.cycleMeta.lastCycleAt, lastError: null,
          universeSize: reloaded.cycleMeta.lastUniverseSize, regime: reloaded.cycleMeta.lastRegime,
          regimeFamily: reloaded.cycleMeta.lastRegimeFamily, breadth: reloaded.cycleMeta.lastBreadth,
          cohesion: reloaded.cycleMeta.lastCohesion, dispersion: reloaded.cycleMeta.lastDispersion,
        },
      });
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    });

    it("[RESTART] the same cycle run twice never double-records the same observation", async () => {
      const dir = tmpDir();
      const now = BASE + 200 * HOUR;
      const store = new LiveEdgeDiggerStore(join(dir, "led.json"));
      const d = { ...deps(dir, now), store };
      await runLiveEdgeDiggerCycle(d);
      const firstCount = store.all.length;
      await runLiveEdgeDiggerCycle(d); // identical `now` => identical observationIds
      expect(store.all.length).toBe(firstCount);
    });

    it("a corrupt store file starts empty rather than throwing on a live cycle path", () => {
      const dir = tmpDir();
      const file = join(dir, "led.json");
      require("node:fs").writeFileSync(file, "{ not json");
      const store = new LiveEdgeDiggerStore(file);
      expect(store.all).toEqual([]);
      expect(store.cycleMeta.cycles).toBe(0);
    });

    it("[FREEZE-ANCHOR] frozenAt comes from the first evaluation, NOT report time", async () => {
      const dir = tmpDir();
      const now = BASE + 200 * HOUR;
      const d = deps(dir, now);
      await runLiveEdgeDiggerCycle(d);

      const fired = d.store.attempts.filter((a) => a.observationsEmitted > 0);
      expect(fired.length).toBeGreaterThan(0);

      // Report generated LONG after the cycle. The freeze anchor must not follow it.
      const generatedAt = new Date(now + 500 * HOUR).toISOString();
      const report = buildLiveEdgeDiggerReport({
        generatedAt, observations: d.store.all, attempts: d.store.attempts,
        scanner: {
          cyclesRun: 1, lastCycleAt: new Date(now).toISOString(), lastError: null,
          universeSize: 4, regime: "r", regimeFamily: "BULLISH",
          breadth: 0.5, cohesion: 0.5, dispersion: 0.02,
        },
      });

      for (const entry of fired) {
        const c = report.candidates.find((x) => x.candidate.candidateId === entry.candidateId)!;
        expect(c.candidate.frozenAt).toBe(entry.firstEvaluatedAt);
        expect(c.candidate.frozenAt).not.toBe(generatedAt);
        expect(c.candidate.frozenAtSource).toBe("FIRST_EVALUATED");
        // The proof itself: nothing was opened before the rule was frozen.
        expect(c.freezeIntegrity.rowsOpenedBeforeFreeze).toBe(0);
        expect(c.freezeIntegrity.ok).toBe(true);
        expect(Date.parse(c.candidate.frozenAt!))
          .toBeLessThanOrEqual(Date.parse(c.freezeIntegrity.earliestObservationAt!));
      }
    });

    it("[FREEZE-ANCHOR] the anchor is written once and never moves on later cycles", async () => {
      const dir = tmpDir();
      const first = BASE + 200 * HOUR;
      const store = new LiveEdgeDiggerStore(join(dir, "led.json"));
      await runLiveEdgeDiggerCycle({ ...deps(dir, first), store });
      const anchors = new Map(store.attempts.map((a) => [a.candidateId, a.firstEvaluatedAt]));
      expect([...anchors.values()].every((v) => v !== null)).toBe(true);

      // A second cycle a day later, and a process restart, must both leave the anchor alone.
      await runLiveEdgeDiggerCycle({ ...deps(dir, first + 24 * HOUR), store });
      store.save();
      const reloaded = new LiveEdgeDiggerStore(join(dir, "led.json"));
      for (const a of reloaded.attempts) {
        expect(a.firstEvaluatedAt).toBe(anchors.get(a.candidateId));
        expect(a.cyclesEvaluated).toBe(2); // the COUNT advances even though the anchor does not
      }
    });

    it("[FREEZE-ANCHOR] editing a rule mints a new candidate rather than inheriting the old clock", () => {
      const dir = tmpDir();
      const store = new LiveEdgeDiggerStore(join(dir, "led.json"));
      const rule = EDGE_RULE_FRONTIER[0]!;
      const retuned = { ...rule, geometry: { ...rule.geometry, targetRMultiple: 9.5 } };
      expect(candidateIdFor(retuned)).not.toBe(candidateIdFor(rule));

      store.recordAttempts(
        [{ ruleId: rule.ruleId, candidateId: candidateIdFor(rule), matched: 1, emitted: 1 }],
        "2026-08-01T00:00:00.000Z",
      );
      store.recordAttempts(
        [{ ruleId: retuned.ruleId, candidateId: candidateIdFor(retuned), matched: 1, emitted: 1 }],
        "2026-08-06T00:00:00.000Z",
      );

      // Same ruleId, different content: two separate tests, two separate clocks. Keying the registry
      // by ruleId would collapse these into one and hide that a second test was ever run.
      expect(store.attempts).toHaveLength(2);
      const original = store.attempts.find((a) => a.candidateId === candidateIdFor(rule))!;
      const edited = store.attempts.find((a) => a.candidateId === candidateIdFor(retuned))!;
      expect(original.firstEvaluatedAt).toBe("2026-08-01T00:00:00.000Z");
      expect(edited.firstEvaluatedAt).toBe("2026-08-06T00:00:00.000Z");
      expect(edited.cyclesEvaluated).toBe(1);
    });

    it("[FREEZE-ANCHOR] rows with no recorded anchor FAIL CLOSED instead of being trusted", () => {
      const rule = EDGE_RULE_FRONTIER[0]!;
      const cid = candidateIdFor(rule);
      const row: ShadowObservation = {
        observationId: "o1", candidateId: cid, contentHash: "h", symbol: "BTCUSDT", direction: "LONG",
        cycleId: "c1", openedAt: new Date(BASE).toISOString(), openedAtMs: BASE,
        entryPrice: 100, stopPrice: 98, targetPrice: 103, stopDistanceBps: 200, maxHoldHours: 24,
        regimeAtEntry: "r", features: {} as never, status: "CLOSED_WIN", resolvedAt: "x",
        exitPrice: 103, exitReason: "TARGET", grossR: 1.5, costR: -0.1, netR: 1.4, holdHours: 1,
      };
      // A legacy registry entry: it predates `firstEvaluatedAt`, so the anchor is genuinely unknown.
      const legacy = buildCandidateReport(
        freezeCandidate(rule, null, 1, "UNKNOWN_PRE_MIGRATION"), [row],
      );
      expect(legacy.freezeIntegrity.ok).toBe(false);
      expect(legacy.lifecycle).toBe("REJECTED"); // structural: freeze integrity needs no sample size
      expect(legacy.rejectionReasons.some((r) => r.startsWith("freeze integrity:"))).toBe(true);

      // And an anchor set AFTER the row it claims to precede is caught, not rounded away.
      const backdated = buildCandidateReport(
        freezeCandidate(rule, new Date(BASE + HOUR).toISOString()), [row],
      );
      expect(backdated.freezeIntegrity.rowsOpenedBeforeFreeze).toBe(1);
      expect(backdated.freezeIntegrity.ok).toBe(false);
      expect(backdated.lifecycle).toBe("REJECTED");
    });

    it("[FREEZE-ANCHOR] a pre-migration store re-keys to candidateId with a null anchor", () => {
      const dir = tmpDir();
      const file = join(dir, "led.json");
      const cid = candidateIdFor(EDGE_RULE_FRONTIER[0]!);
      // The shape written before this fix: keyed by ruleId, no firstEvaluatedAt field at all.
      writeFileSync(file, JSON.stringify({
        version: 1, observations: [],
        attempts: {
          [EDGE_RULE_FRONTIER[0]!.ruleId]: {
            ruleId: EDGE_RULE_FRONTIER[0]!.ruleId, candidateId: cid,
            cyclesEvaluated: 7, cyclesFired: 3, observationsEmitted: 11,
          },
        },
        cycleMeta: {},
      }));
      const store = new LiveEdgeDiggerStore(file);
      expect(store.attempts).toHaveLength(1);
      const e = store.attempts[0]!;
      expect(e.candidateId).toBe(cid);
      expect(e.cyclesEvaluated).toBe(7);       // history preserved
      expect(e.firstEvaluatedAt).toBeNull();   // absent, and NOT back-filled with load time
    });

    it("open positions are never pruned away, even past the retention cap", () => {
      const dir = tmpDir();
      const store = new LiveEdgeDiggerStore(join(dir, "led.json"), 3);
      const mk = (id: string, status: "OPEN" | "CLOSED_WIN", ms: number): ShadowObservation => ({
        observationId: id, candidateId: "c1", contentHash: "h", symbol: "BTCUSDT", direction: "LONG",
        cycleId: id, openedAt: new Date(ms).toISOString(), openedAtMs: ms, entryPrice: 100, stopPrice: 98,
        targetPrice: 103, stopDistanceBps: 200, maxHoldHours: 24, regimeAtEntry: "r", features: {} as never,
        status, resolvedAt: null, exitPrice: null, exitReason: null,
        grossR: status === "OPEN" ? null : 1, costR: null, netR: status === "OPEN" ? null : 1, holdHours: null,
      });
      for (let i = 0; i < 6; i++) store.add(mk(`settled-${i}`, "CLOSED_WIN", BASE + i * HOUR));
      store.add(mk("open-1", "OPEN", BASE + 99 * HOUR));
      store.save();
      expect(store.all.some((o) => o.observationId === "open-1")).toBe(true);
    });
  });

  // =========================================================================
  // LIFECYCLE — the defect this engine shipped with: every rule read REJECT from
  // its first cycle, before any outcome could exist.
  // =========================================================================
  describe("lifecycle", () => {
    const RULE = EDGE_RULE_FRONTIER[0]!;
    const CID = candidateIdFor(RULE);
    const FROZEN = new Date(BASE - HOUR).toISOString();

    /** One resolved row. `cycle` controls episode identity; `netR` the economics. */
    const row = (id: string, cycle: string, netR: number, symbol = "AUSDT", atMs = BASE): ShadowObservation => ({
      observationId: id, candidateId: CID, contentHash: "h", symbol,
      direction: "LONG", cycleId: cycle,
      openedAt: new Date(atMs).toISOString(), openedAtMs: atMs,
      entryPrice: 100, stopPrice: 98, targetPrice: 103, stopDistanceBps: 200, maxHoldHours: 24,
      regimeAtEntry: "r", features: {} as never, collectionPolicyVersion: 2,
      status: netR > 0 ? "CLOSED_WIN" : "CLOSED_LOSS", resolvedAt: "x",
      exitPrice: 103, exitReason: netR > 0 ? "TARGET" : "STOP",
      grossR: netR + 0.1, costR: -0.1, netR, holdHours: 1,
    } as ShadowObservation);

    /** Far enough past every fixture row's 24h horizon that the whole cohort is matured. Verdicts
     *  are only reachable on matured evidence, so lifecycle tests must evaluate at such an instant. */
    const MATURED_AT = BASE + 400 * HOUR;

    const openRow = (id: string): ShadowObservation => ({
      ...row(id, "cycle-open", 1), status: "OPEN", resolvedAt: undefined, netR: undefined, grossR: undefined,
    } as unknown as ShadowObservation);

    it("[LIFECYCLE-DORMANT] a rule that has never fired is DORMANT with no rejection reasons", () => {
      const r = buildCandidateReport(freezeCandidate(RULE, FROZEN), [], undefined, MATURED_AT);
      expect(r.lifecycle).toBe("DORMANT");
      expect(r.rejectionReasons).toEqual([]);
      // The finding is about the MARKET, and the report says so rather than blaming the rule.
      expect(r.lifecycleReason).toContain("have not occurred");
    });

    it("[LIFECYCLE-OPEN] a rule whose every row is still unresolved is OPEN, never REJECTED", () => {
      const r = buildCandidateReport(freezeCandidate(RULE, FROZEN), [openRow("o1"), openRow("o2")], undefined, MATURED_AT);
      expect(r.lifecycle).toBe("OPEN");
      expect(r.openRows).toBe(2);
      expect(r.resolvedRows).toBe(0);
      expect(r.rejectionReasons).toEqual([]);
      expect(r.evidenceStillNeeded.join(" ")).toContain("still open");
    });

    it("[LIFECYCLE-NO-REJECT-ON-EMPTY] a LOSING but tiny sample is COLLECTING — too few episodes to conclude", () => {
      // Two losing episodes. Under the old code the negative expectancy alone produced REJECT; a
      // rule must not be discarded for being unlucky in its first two looks.
      const rows = [row("a", "c1", -1), row("b", "c2", -1)];
      const r = buildCandidateReport(freezeCandidate(RULE, FROZEN), rows);
      expect(r.independentEpisodes).toBeLessThan(MIN_EPISODES_TO_JUDGE);
      expect(r.metrics.netExpectancyR).toBeLessThan(0);
      expect(r.lifecycle).toBe("COLLECTING");
      expect(r.rejectionReasons).toEqual([]);
      expect(r.evidenceStillNeeded.join(" ")).toContain("before economics may be judged");
    });

    it("[LIFECYCLE-REJECT] a losing sample LARGE enough to judge is REJECTED, with the shortfall named", () => {
      const rows = Array.from({ length: MIN_EPISODES_TO_JUDGE }, (_, i) =>
        row(`x${i}`, `c${i}`, -1, `S${i}USDT`, BASE + i * 50 * HOUR));
      const r = buildCandidateReport(freezeCandidate(RULE, FROZEN), rows, undefined, MATURED_AT);
      expect(r.independentEpisodes).toBeGreaterThanOrEqual(MIN_EPISODES_TO_JUDGE);
      expect(r.lifecycle).toBe("REJECTED");
      expect(r.rejectionReasons.join(" ")).toContain("expectancy");
      // Crucially it names the population it concluded from — not a bare verdict.
      expect(r.rejectionReasons.join(" ")).toContain("independent episodes");
    });

    it("[LIFECYCLE-POSITIVE-STAYS-COLLECTING] a provisionally POSITIVE result below the floors is never promoted", () => {
      const rows = [row("a", "c1", 2), row("b", "c2", 2)];
      const r = buildCandidateReport(freezeCandidate(RULE, FROZEN), rows);
      expect(r.metrics.netExpectancyR).toBeGreaterThan(0);
      expect(r.lifecycle).toBe("COLLECTING");
      // The report says the positive number is not a finding, in words, where a reader will see it.
      expect(r.lifecycleReason).toContain("not a finding yet");
    });

    it("[LIFECYCLE-EMPTY-PARTITION] an empty validation partition is not read as sign disagreement", () => {
      // All rows land in DEV; VALIDATION/RECENT are empty. An empty side must never manufacture a
      // "splits disagree" rejection — absence is not disagreement.
      const rows = Array.from({ length: MIN_EPISODES_TO_JUDGE + 2 }, (_, i) =>
        row(`p${i}`, `c${i}`, 1, `S${i}USDT`, BASE + i * 50 * HOUR));
      const r = buildCandidateReport(freezeCandidate(RULE, FROZEN), rows);
      expect(r.rejectionReasons.join(" ")).not.toContain("disagree in sign");
    });

    it("[LIFECYCLE-COUNTS] the report census never shows REJECTED on an empty store", () => {
      const report = buildLiveEdgeDiggerReport({
        generatedAt: new Date(MATURED_AT).toISOString(),
        observations: [], attempts: [],
        scanner: {
          cyclesRun: 3, lastCycleAt: null, lastError: null, universeSize: 21, regime: null,
          regimeFamily: null, breadth: null, cohesion: null, dispersion: null,
        },
      });
      expect(report.lifecycleCounts.REJECTED).toBe(0);
      expect(report.lifecycleCounts.DORMANT).toBe(EDGE_RULE_FRONTIER.length);
      expect(report.verdict).toBe("NO_PROVEN_EDGE_YET");
    });
  });

  // =========================================================================
  // HYPOTHESIS GENERATION
  // =========================================================================
  describe("bounded hypothesis generation", () => {
    /** A market with a real compression cluster, crowded funding and a breadth extreme. */
    function richMarket(overrides: Partial<Parameters<typeof buildMarketFeatures>[0]> = {}) {
      const asOf = BASE + 200 * HOUR;
      const symbols: SymbolCycleInput[] = Array.from({ length: 12 }, (_, i) =>
        symbolInput(`S${i}USDT`, { asOfMs: asOf, drift: i < 9 ? 0.002 : -0.001, fundingBps: i < 4 ? 6 : 1 }));
      return buildMarketFeatures({
        asOfMs: asOf, regime: "Bullish expansion", regimeFamily: "BULLISH",
        benchmarkSymbol: "S0USDT", symbols, ...overrides,
      });
    }

    it("[GEN-BASIC] generates interpretable rules from live structure, each with a thesis and rejection rules", () => {
      const { generated } = generateHypotheses({
        market: richMarket(), cycleId: "cycle-1", atIso: "2026-08-06T00:00:00.000Z",
        existingContentHashes: new Set(EDGE_RULE_FRONTIER.map(ruleContentHash)),
        existingGenerated: [],
      });
      expect(generated.length).toBeGreaterThan(0);
      expect(generated.length).toBeLessThanOrEqual(MAX_GENERATED_PER_CYCLE);
      for (const g of generated) {
        expect(g.rule.thesis.length).toBeGreaterThan(40);
        expect(g.rule.rejectionRules.length).toBeGreaterThan(0);
        expect(g.candidateId).toContain(g.rule.ruleId);
        // Provenance: the live observation that motivated it, never an outcome.
        expect(g.originObservation.length).toBeGreaterThan(0);
        // Grammar/complexity ceiling holds.
        const predicateCount = Object.keys(g.rule.predicates)
          .filter((k) => !["regimeFamilies", "maxSpreadBps", "minQuoteVolume24hUsd"].includes(k)).length;
        expect(predicateCount).toBeLessThanOrEqual(MAX_GENERATED_PREDICATES);
      }
    });

    it("[GEN-NO-LEAKAGE] no generated predicate names an outcome-only field", () => {
      const { generated } = generateHypotheses({
        market: richMarket(), cycleId: "c", atIso: "2026-08-06T00:00:00.000Z",
        existingContentHashes: new Set(), existingGenerated: [],
      });
      for (const g of generated) {
        expect(() => assertDecisionTimeSafe(Object.keys(g.rule.predicates), g.rule.ruleId)).not.toThrow();
        for (const field of OUTCOME_ONLY_FIELDS) {
          expect(Object.keys(g.rule.predicates)).not.toContain(field);
        }
      }
    });

    it("[GEN-DEDUP] the same market can never generate the same rule twice — repeated cycles saturate instead of re-freezing", () => {
      // Cycles beyond the per-cycle budget DEFER the remaining proposals rather than discarding
      // them, so the honest invariant is not "the second cycle generates nothing" but "no rule is
      // ever generated twice". Re-freezing a known rule would restart its clock and double-count it
      // in the multiple-testing denominator, which is the failure this guards.
      const market = richMarket();
      const seen = new Set(EDGE_RULE_FRONTIER.map(ruleContentHash));
      const accumulated: ReturnType<typeof generateHypotheses>["generated"][number][] = [];
      let sawDuplicateSuppression = false;

      for (let cycle = 0; cycle < 8; cycle++) {
        const res = generateHypotheses({
          market, cycleId: `c${cycle}`, atIso: `2026-08-0${(cycle % 9) + 1}T00:00:00.000Z`,
          existingContentHashes: seen,
          existingGenerated: accumulated,
        });
        for (const g of res.generated) {
          const hash = ruleContentHash(g.rule);
          // THE INVARIANT: never seen before, in any earlier cycle.
          expect(seen.has(hash)).toBe(false);
          seen.add(hash);
          accumulated.push(g);
        }
        if (res.suppressed.some((s) => s.reason === "DUPLICATE")) sawDuplicateSuppression = true;
      }

      // It generated something, then saturated on this one unchanging market state...
      expect(accumulated.length).toBeGreaterThan(0);
      // ...and every candidateId is distinct — the property that actually matters.
      expect(new Set(accumulated.map((g) => g.candidateId)).size).toBe(accumulated.length);
      // ...and once saturated it reports duplicates rather than silently doing nothing.
      expect(sawDuplicateSuppression).toBe(true);
    });

    it("[GEN-CAPS] per-cycle, per-day and total-active caps each stop generation and say which one bound", () => {
      const market = richMarket();
      const base = { market, cycleId: "c", existingContentHashes: new Set<string>() };
      // Per-cycle: never more than the budget in one call.
      const cycle = generateHypotheses({ ...base, atIso: "2026-08-06T00:00:00.000Z", existingGenerated: [] });
      expect(cycle.generated.length).toBeLessThanOrEqual(MAX_GENERATED_PER_CYCLE);

      const fake = (n: number, day: string) => Array.from({ length: n }, (_, i) => ({
        rule: { ...EDGE_RULE_FRONTIER[0]!, ruleId: `FAKE_${day}_${i}` },
        candidateId: `FAKE_${day}_${i}`, generatedAt: `${day}T00:00:00.000Z`,
        originCycleId: "c", originObservation: "x",
      }));
      // Daily cap.
      const daily = generateHypotheses({
        ...base, atIso: "2026-08-06T12:00:00.000Z", existingGenerated: fake(MAX_GENERATED_PER_DAY, "2026-08-06"),
      });
      expect(daily.generated.length).toBe(0);
      expect(daily.suppressed[0]!.reason).toBe("DAILY_CAP");
      // Total-active cap dominates even on a fresh day.
      const total = generateHypotheses({
        ...base, atIso: "2026-09-01T00:00:00.000Z", existingGenerated: fake(MAX_ACTIVE_GENERATED, "2026-08-01"),
      });
      expect(total.generated.length).toBe(0);
      expect(total.suppressed[0]!.reason).toBe("TOTAL_ACTIVE_CAP");
    });

    it("[GEN-DETERMINISTIC] the same market and the same known-set produce the same rules — the freeze anchor means something", () => {
      const args = {
        market: richMarket(), cycleId: "c", atIso: "2026-08-06T00:00:00.000Z",
        existingContentHashes: new Set<string>(), existingGenerated: [],
      };
      const a = generateHypotheses(args);
      const b = generateHypotheses(args);
      expect(b.generated.map((g) => g.candidateId)).toEqual(a.generated.map((g) => g.candidateId));
    });

    it("[GEN-EDIT-NEW-ID] editing a generated rule's threshold mints a new candidateId, never reusing the old clock", () => {
      const { generated } = generateHypotheses({
        market: richMarket(), cycleId: "c", atIso: "2026-08-06T00:00:00.000Z",
        existingContentHashes: new Set(), existingGenerated: [],
      });
      const original = generated[0]!;
      const edited: EdgeRule = {
        ...original.rule,
        geometry: { ...original.rule.geometry, stopAtrMultiple: original.rule.geometry.stopAtrMultiple + 0.5 },
      };
      expect(candidateIdFor(edited)).not.toBe(original.candidateId);
      // Prose-only edits do NOT mint a new identity — the line between clarifying and changing.
      const reworded: EdgeRule = { ...original.rule, thesis: `${original.rule.thesis} (clarified)` };
      expect(candidateIdFor(reworded)).toBe(original.candidateId);
    });

    it("[GEN-THIN-TAPE] a thin or unclassified cross-section generates nothing — fails closed", () => {
      const asOf = BASE + 200 * HOUR;
      const thin = buildMarketFeatures({
        asOfMs: asOf, regime: "x", regimeFamily: "BULLISH", benchmarkSymbol: "S0USDT",
        symbols: [symbolInput("S0USDT", { asOfMs: asOf }), symbolInput("S1USDT", { asOfMs: asOf })],
      });
      expect(generateHypotheses({
        market: thin, cycleId: "c", atIso: "2026-08-06T00:00:00.000Z",
        existingContentHashes: new Set(), existingGenerated: [],
      }).generated.length).toBe(0);

      const unknown = buildMarketFeatures({
        asOfMs: asOf, regime: null, regimeFamily: "UNKNOWN", benchmarkSymbol: "S0USDT",
        symbols: Array.from({ length: 12 }, (_, i) => symbolInput(`S${i}USDT`, { asOfMs: asOf })),
      });
      expect(generateHypotheses({
        market: unknown, cycleId: "c", atIso: "2026-08-06T00:00:00.000Z",
        existingContentHashes: new Set(), existingGenerated: [],
      }).generated.length).toBe(0);
    });
  });

  // =========================================================================
  // COVERAGE TRANSPARENCY
  // =========================================================================
  describe("coverage transparency", () => {
    it("[COVERAGE] a partial scan reports the canonical universe, the exclusions, and never implies full coverage", async () => {
      const dir = tmpDir();
      const now = BASE + 200 * HOUR;
      // 40 symbols in the universe; only some have enough history.
      const universe = Array.from({ length: 40 }, (_, i) => `S${i}USDT`);
      const store = new LiveEdgeDiggerStore(join(dir, "led.json"));
      await runLiveEdgeDiggerCycle({
        store, now,
        resolveUniverse: async () => ({
          symbols: universe,
          perSymbolMeta: Object.fromEntries(universe.map((s) => [s, { quoteVolume24hUsd: 1e9, spreadBps: 2, openInterestUsd: 1e8 }])),
        }),
        getRegime: async () => ({ regime: "Bullish expansion", regimeFamily: "BULLISH" as const }),
        fetchCandles: async (symbol: string, interval: string) => {
          // Every 5th symbol has too little history — a real, itemisable exclusion.
          const idx = Number(symbol.replace(/\D/g, ""));
          const intervalMs = interval === "15m" ? 900_000 : HOUR;
          const bars = interval === "15m" ? 8 : (idx % 5 === 0 ? 5 : 120);
          return candles(bars, now - bars * intervalMs, 100, 0.001, intervalMs);
        },
        fetchFunding: async () => ({ fundingBps: 1, basisBps: null }),
      });
      const report = buildLiveEdgeDiggerReportFromStore(store, "2026-08-06T00:00:00.000Z");
      const cov = report.coverage!;
      expect(cov.canonicalUniverseSize).toBe(40);
      // The engine cap means it never even looked at most of them, and that is stated as an ENGINE
      // fact rather than a market one.
      expect(cov.scannedSymbols).toBeLessThan(40);
      expect(cov.excludedSymbols).toBeGreaterThan(0);
      expect(cov.exclusionReasons.some((r) => r.reason.includes("LIVE_EDGE_DIGGER_MAX_SYMBOLS"))).toBe(true);
      expect(cov.exclusionReasons.some((r) => r.reason.includes("insufficient hourly history"))).toBe(true);
      // Missing features are itemised, not silently null.
      expect(cov.featureGaps.some((g) => g.feature === "basisBps")).toBe(true);
      expect(cov.cycleMs).not.toBeNull();
      expect(cov.completedCandleWatermark).not.toBeNull();
      // And the note refuses to let the number be read as full coverage.
      expect(cov.coverageNote).toContain("NOT full-universe coverage");
    });

    it("[COVERAGE-PERSIST] coverage and generated rules survive a restart from disk", async () => {
      const dir = tmpDir();
      const now = BASE + 200 * HOUR;
      const file = join(dir, "led.json");
      const universe = Array.from({ length: 14 }, (_, i) => `S${i}USDT`);
      const deps = (store: LiveEdgeDiggerStore) => ({
        store, now,
        resolveUniverse: async () => ({
          symbols: universe,
          perSymbolMeta: Object.fromEntries(universe.map((s) => [s, { quoteVolume24hUsd: 1e9, spreadBps: 2, openInterestUsd: 1e8 }])),
        }),
        getRegime: async () => ({ regime: "Bullish expansion", regimeFamily: "BULLISH" as const }),
        fetchCandles: async (symbol: string, interval: string) => {
          const intervalMs = interval === "15m" ? 900_000 : HOUR;
          const bars = interval === "15m" ? 8 : 120;
          const idx = Number(symbol.replace(/\D/g, ""));
          return candles(bars, now - bars * intervalMs, 100, idx < 10 ? 0.003 : -0.001, intervalMs);
        },
        fetchFunding: async (s: string) => ({ fundingBps: Number(s.replace(/\D/g, "")) < 4 ? 6 : 1, basisBps: 2 }),
      });
      await runLiveEdgeDiggerCycle(deps(new LiveEdgeDiggerStore(file)));
      const before = buildLiveEdgeDiggerReportFromStore(new LiveEdgeDiggerStore(file), "2026-08-06T00:00:00.000Z");

      // A genuinely new store object over the same file — the restart path.
      const after = buildLiveEdgeDiggerReportFromStore(new LiveEdgeDiggerStore(file), "2026-08-06T00:00:00.000Z");
      expect(after.generation.generatedRuleCount).toBe(before.generation.generatedRuleCount);
      expect(after.coverage!.canonicalUniverseSize).toBe(before.coverage!.canonicalUniverseSize);
      expect(after.candidates.map((c) => c.candidate.candidateId))
        .toEqual(before.candidates.map((c) => c.candidate.candidateId));
      // Generated rules are reported separately from the seeds — never conflated.
      expect(after.seedRuleCount).toBe(EDGE_RULE_FRONTIER.length);
      expect(after.rulesEnumerated).toBe(EDGE_RULE_FRONTIER.length + after.generation.generatedRuleCount);
    });

    it("[GEN-FROZEN-BEFORE-OBSERVATION] every generated rule is frozen at or before its first observation", async () => {
      const dir = tmpDir();
      const now = BASE + 200 * HOUR;
      const file = join(dir, "led.json");
      const universe = Array.from({ length: 14 }, (_, i) => `S${i}USDT`);
      const store = new LiveEdgeDiggerStore(file);
      await runLiveEdgeDiggerCycle({
        store, now,
        resolveUniverse: async () => ({
          symbols: universe,
          perSymbolMeta: Object.fromEntries(universe.map((s) => [s, { quoteVolume24hUsd: 1e9, spreadBps: 2, openInterestUsd: 1e8 }])),
        }),
        getRegime: async () => ({ regime: "Bullish expansion", regimeFamily: "BULLISH" as const }),
        fetchCandles: async (symbol: string, interval: string) => {
          const intervalMs = interval === "15m" ? 900_000 : HOUR;
          const bars = interval === "15m" ? 8 : 120;
          const idx = Number(symbol.replace(/\D/g, ""));
          return candles(bars, now - bars * intervalMs, 100, idx < 10 ? 0.003 : -0.001, intervalMs);
        },
        fetchFunding: async (s: string) => ({ fundingBps: Number(s.replace(/\D/g, "")) < 4 ? 6 : 1, basisBps: 2 }),
      });
      const report = buildLiveEdgeDiggerReportFromStore(store, "2026-08-06T00:00:00.000Z");
      for (const c of report.candidates) {
        // Whatever the lifecycle, no candidate may hold evidence that predates its own freeze.
        expect(c.freezeIntegrity.rowsOpenedBeforeFreeze).toBe(0);
        if (c.rawRows > 0) expect(c.freezeIntegrity.ok).toBe(true);
      }
      // Generated rules are persisted even when they never fire — the multiple-testing denominator
      // must count what was really tried, not only what happened to trigger.
      for (const g of report.generation.rules) {
        expect(report.candidates.some((c) => c.candidate.candidateId === g.candidateId)).toBe(true);
      }
    });
  });

  // =========================================================================
  // COLLECTION POLICY v2 + CENSORING
  // =========================================================================
  describe("collection policy v2 and censoring", () => {
    const cycleDeps = (dir: string, now: number, store?: LiveEdgeDiggerStore) => ({
      store: store ?? new LiveEdgeDiggerStore(join(dir, "led.json")),
      now,
      resolveUniverse: async () => ({
        symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT"],
        perSymbolMeta: {
          BTCUSDT: { quoteVolume24hUsd: 9e9, spreadBps: 1, openInterestUsd: 1e9 },
          ETHUSDT: { quoteVolume24hUsd: 5e9, spreadBps: 1, openInterestUsd: 5e8 },
          SOLUSDT: { quoteVolume24hUsd: 1e9, spreadBps: 2, openInterestUsd: 2e8 },
          ADAUSDT: { quoteVolume24hUsd: 5e8, spreadBps: 3, openInterestUsd: 1e8 },
        },
      }),
      getRegime: async () => ({ regime: "Bullish expansion", regimeFamily: "BULLISH" as const }),
      fetchCandles: async (symbol: string, interval: string) => {
        const drift = symbol === "BTCUSDT" ? 0.0005 : symbol === "SOLUSDT" ? 0.004 : -0.002;
        const intervalMs = interval === "15m" ? 900_000 : HOUR;
        const bars = interval === "15m" ? 8 : 120;
        return candles(bars, now - bars * intervalMs, 100, drift, intervalMs);
      },
      fetchFunding: async () => ({ fundingBps: 1, basisBps: 2 }),
    });

    const row = (over: Partial<ShadowObservation> & { observationId: string; openedAtMs: number }): ShadowObservation => ({
      candidateId: "cand@v1-aaaa", contentHash: "h", symbol: "BTCUSDT", direction: "LONG",
      cycleId: `cycle-${over.openedAtMs}`, openedAt: new Date(over.openedAtMs).toISOString(),
      entryPrice: 100, stopPrice: 98, targetPrice: 103, stopDistanceBps: 200, maxHoldHours: 24,
      regimeAtEntry: "MIXED", features: {} as never, collectionPolicyVersion: 2,
      status: "OPEN", resolvedAt: null, exitPrice: null, exitReason: null,
      grossR: null, costR: null, netR: null, holdHours: null,
      ...over,
    });

    // ---- A. ADMISSION -----------------------------------------------------------------------
    it("[OVERLAP] a signal persisting across 12 cycles emits ONE row per candidate+symbol", () => {
      // The exact v1 defect: entryPrice is the last CLOSED 1h candle, so 12 cycles 7 minutes apart
      // all see the same price and each minted a distinct observationId.
      let existing: ShadowObservation[] = [];
      let admittedTotal = 0;
      const suppressedReasons: string[] = [];
      for (let i = 0; i < 12; i++) {
        const t = BASE + i * 7 * 60_000;
        const proposal = row({ observationId: `o-${i}`, openedAtMs: t });
        const res = admitUnderPolicyV2([proposal], existing, EPISODE_BLOCK_WIDTH_MS);
        admittedTotal += res.admitted.length;
        suppressedReasons.push(...res.suppressed.map((x) => x.reason));
        existing = [...existing, ...res.admitted];
      }
      expect(admittedTotal).toBe(1);
      expect(existing).toHaveLength(1);
      expect(suppressedReasons).toHaveLength(11);
      expect(new Set(suppressedReasons)).toEqual(new Set(["OPEN_POSITION_EXISTS"]));
    });

    it("[OVERLAP] closing inside the same episode does NOT permit re-entry", () => {
      const closed = row({
        observationId: "o-1", openedAtMs: BASE,
        status: "CLOSED_LOSS", resolvedAt: new Date(BASE + HOUR).toISOString(),
        exitPrice: 98, exitReason: "STOP", grossR: -1, costR: -0.11, netR: -1.11, holdHours: 1,
      });
      // 2h later: the position is CLOSED, but the 36h episode block has not ended.
      const next = row({ observationId: "o-2", openedAtMs: BASE + 2 * HOUR });
      const res = admitUnderPolicyV2([next], [closed], EPISODE_BLOCK_WIDTH_MS);
      expect(res.admitted).toHaveLength(0);
      expect(res.suppressed[0]!.reason).toBe("ALREADY_ENTERED_THIS_EPISODE");
    });

    it("[OVERLAP] a NEW canonical episode permits re-entry", () => {
      const closed = row({
        observationId: "o-1", openedAtMs: BASE,
        status: "CLOSED_LOSS", resolvedAt: new Date(BASE + HOUR).toISOString(),
        exitPrice: 98, exitReason: "STOP", grossR: -1, costR: -0.11, netR: -1.11, holdHours: 1,
      });
      const next = row({ observationId: "o-2", openedAtMs: BASE + EPISODE_BLOCK_WIDTH_MS + 1 });
      const res = admitUnderPolicyV2([next], [closed], EPISODE_BLOCK_WIDTH_MS);
      expect(res.admitted).toHaveLength(1);
      expect(res.suppressed).toHaveLength(0);
    });

    it("[OVERLAP] an exact observationId collision is reported as DUPLICATE, not as overlap", () => {
      const first = row({ observationId: "dup", openedAtMs: BASE });
      const res = admitUnderPolicyV2([row({ observationId: "dup", openedAtMs: BASE })], [first], EPISODE_BLOCK_WIDTH_MS);
      expect(res.suppressed[0]!.reason).toBe("DUPLICATE_OBSERVATION");
    });

    it("[OVERLAP] two proposals for the same key in ONE batch cannot both slip through", () => {
      const res = admitUnderPolicyV2(
        [row({ observationId: "a", openedAtMs: BASE }), row({ observationId: "b", openedAtMs: BASE + 60_000 })],
        [], EPISODE_BLOCK_WIDTH_MS,
      );
      expect(res.admitted).toHaveLength(1);
      expect(res.suppressed).toHaveLength(1);
    });

    it("[POLICY] a v1 row never blocks a v2 entry", () => {
      // v1 rows were collected while re-entry was unrestricted. Letting one block admission would
      // import the old defect into the new evidence.
      const v1 = { ...row({ observationId: "old", openedAtMs: BASE }), collectionPolicyVersion: undefined };
      const res = admitUnderPolicyV2([row({ observationId: "new", openedAtMs: BASE + 60_000 })], [v1], EPISODE_BLOCK_WIDTH_MS);
      expect(res.admitted).toHaveLength(1);
    });

    it("[POLICY] seed and generated rules go through the SAME admission path", async () => {
      const dir = tmpDir();
      const now = BASE + 200 * HOUR;
      const store = new LiveEdgeDiggerStore(join(dir, "led.json"));
      await runLiveEdgeDiggerCycle(cycleDeps(dir, now, store));
      await runLiveEdgeDiggerCycle(cycleDeps(dir, now + 7 * 60_000, store));
      // Whatever fired — seed or GEN_ — must be one row per candidate+symbol.
      const keys = store.all.map((o) => `${o.candidateId}|${o.symbol}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(store.all.every((o) => o.collectionPolicyVersion === 2)).toBe(true);
    });

    it("[CLUSTERING] the LIVE cycle blocks re-entry for a CLOSED row inside the same episode", async () => {
      // Guards the CALL SITE, not just the pure function: the cycle must hand admission the same
      // episode width the evidence is clustered on. A narrower width there would let the engine
      // re-enter inside one market look and then have the clustering silently merge the rows away
      // — inflating n exactly as v1 did. Closing the rows first removes the OPEN guard, so the
      // episode width is the ONLY thing that can still refuse the second entry.
      const dir = tmpDir();
      const now = BASE + 200 * HOUR;
      const store = new LiveEdgeDiggerStore(join(dir, "led.json"));
      await runLiveEdgeDiggerCycle(cycleDeps(dir, now, store));
      const afterFirst = store.all.map((o) => `${o.candidateId}|${o.symbol}`);
      expect(afterFirst.length).toBeGreaterThan(0);

      for (const o of store.all) {
        store.replace(o.observationId, {
          ...o, status: "CLOSED_LOSS", resolvedAt: new Date(now + HOUR).toISOString(),
          exitPrice: o.stopPrice, exitReason: "STOP", grossR: -1, costR: -0.11, netR: -1.11, holdHours: 1,
        });
      }
      // 3h later — well inside the 36h episode block, and every prior row is CLOSED.
      await runLiveEdgeDiggerCycle(cycleDeps(dir, now + 3 * HOUR, store));

      const keys = store.all.map((o) => `${o.candidateId}|${o.symbol}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of afterFirst) {
        expect(keys.filter((x) => x === k)).toHaveLength(1);
      }
      expect(store.cycleMeta.suppressedTotals.ALREADY_ENTERED_THIS_EPISODE ?? 0).toBeGreaterThan(0);
    });

    it("[RESTART] suppression state and the v2 cutover survive a restart", async () => {
      const dir = tmpDir();
      const file = join(dir, "led.json");
      const now = BASE + 200 * HOUR;
      const store = new LiveEdgeDiggerStore(file);
      await runLiveEdgeDiggerCycle(cycleDeps(dir, now, store));
      await runLiveEdgeDiggerCycle(cycleDeps(dir, now + 7 * 60_000, store));
      store.save();
      const cutover = store.cycleMeta.collectionPolicyV2CutoverAt;
      const totals = { ...store.cycleMeta.suppressedTotals };
      expect(cutover).not.toBeNull();

      const reloaded = new LiveEdgeDiggerStore(file);
      expect(reloaded.cycleMeta.collectionPolicyV2CutoverAt).toBe(cutover);
      expect(reloaded.cycleMeta.suppressedTotals).toEqual(totals);
      // And the reloaded store still refuses the duplicates — dedup state IS the persisted rows.
      await runLiveEdgeDiggerCycle(cycleDeps(dir, now + 14 * 60_000, reloaded));
      const keys = reloaded.all.map((o) => `${o.candidateId}|${o.symbol}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(reloaded.cycleMeta.collectionPolicyV2CutoverAt).toBe(cutover); // never rewritten
    });

    // ---- B. CENSORING -----------------------------------------------------------------------
    const censoredFixture = (): { rows: ShadowObservation[]; nowMs: number } => {
      // The exact 3101 shape: early stops resolved, everything else still inside its horizon.
      const rows: ShadowObservation[] = [];
      for (let i = 0; i < 4; i++) {
        const at = BASE + i * 15 * 60_000;
        rows.push(row({
          observationId: `stop-${i}`, openedAtMs: at,
          symbol: `S${i}USDT`, cycleId: `c-${i}`,
          status: "CLOSED_LOSS", resolvedAt: new Date(at + HOUR).toISOString(),
          exitPrice: 98, exitReason: "STOP", grossR: -1, costR: -0.11, netR: -1.11, holdHours: 1,
        }));
      }
      // "now" is 2h in: each row stopped out after 1h, but its 24h horizon is still running, so the
      // farther target has not had the chance the nearer stop had. Exactly the 3101 shape.
      return { rows, nowMs: BASE + 2 * HOUR };
    };

    it("[CENSOR] early stops with unresolved rows are CENSORED, never a negative verdict", () => {
      const { rows, nowMs } = censoredFixture();
      const report = buildCandidateReport(
        freezeCandidate(EDGE_RULE_FRONTIER[0]!, new Date(BASE - HOUR).toISOString()),
        rows.map((r) => ({ ...r, candidateId: candidateIdFor(EDGE_RULE_FRONTIER[0]!) })),
        undefined, nowMs,
      );
      expect(report.lifecycle).toBe("CENSORED");
      expect(report.rejectionReasons).toHaveLength(0);          // NOT a disqualification
      expect(report.evidenceCohorts.matured.rows).toBe(0);
      expect(report.evidenceCohorts.matured.netExpectancyR).toBeNull();
      // The censored figure is still visible, but labelled and excluded from the verdict.
      expect(report.evidenceCohorts.provisionalResolvedOnly.rows).toBe(4);
      expect(report.evidenceCohorts.provisionalResolvedOnly.netExpectancyR).toBeLessThan(0);
      expect(report.evidenceCohorts.provisionalResolvedOnly.label).toBe("CENSORED / NOT JUDGEABLE");
      // and it never reaches the gates
      expect(report.metrics.netExpectancyR).toBeNull();
      expect(report.independentEpisodes).toBe(0);
    });

    it("[CENSOR] once horizons elapse the matured cohort becomes the canonical evidence", () => {
      const { rows } = censoredFixture();
      const matureNow = BASE + 48 * HOUR; // every 24h horizon has now elapsed
      const report = buildCandidateReport(
        freezeCandidate(EDGE_RULE_FRONTIER[0]!, new Date(BASE - HOUR).toISOString()),
        rows.map((r) => ({ ...r, candidateId: candidateIdFor(EDGE_RULE_FRONTIER[0]!) })),
        undefined, matureNow,
      );
      expect(report.evidenceCohorts.matured.rows).toBe(4);
      expect(report.evidenceCohorts.matured.netExpectancyR).toBeCloseTo(-1.11, 6);
      expect(report.metrics.netExpectancyR).toBeCloseTo(-1.11, 6);  // now canonical
      // Minutes apart, so ONE canonical episode however many rows — the clustering is unchanged.
      expect(report.independentEpisodes).toBe(1);
      expect(report.lifecycle).not.toBe("CENSORED");
      // cost components are attributable on matured evidence
      expect(report.evidenceCohorts.matured.feeR).toBeLessThan(0);
      expect(report.evidenceCohorts.matured.stopSlippageR).toBeLessThan(0);
      expect(report.evidenceCohorts.matured.fundingR).toBe(-0);
    });

    it("[POLICY] v1 rows stay visible but never enter a v2 gate", () => {
      const { rows } = censoredFixture();
      const matureNow = BASE + 48 * HOUR;
      const asV1 = rows.map((r) => ({
        ...r, candidateId: candidateIdFor(EDGE_RULE_FRONTIER[0]!), collectionPolicyVersion: undefined,
      }));
      const report = buildCandidateReport(
        freezeCandidate(EDGE_RULE_FRONTIER[0]!, new Date(BASE - HOUR).toISOString()),
        asV1, undefined, matureNow,
      );
      expect(report.evidenceCohorts.v1Rows).toBe(4);
      expect(report.evidenceCohorts.v2Rows).toBe(0);
      expect(report.evidenceCohorts.provisionalResolvedOnly.rows).toBe(4); // visible
      expect(report.evidenceCohorts.matured.rows).toBe(0);                 // but never judged
      expect(report.metrics.netExpectancyR).toBeNull();
      expect(report.independentEpisodes).toBe(0);
      expect(report.lifecycle).toBe("CENSORED");
      expect(report.rejectionReasons).toHaveLength(0);
    });

    it("[CENSOR] the book headline is CENSORED, not a negative-edge verdict", () => {
      const { rows, nowMs } = censoredFixture();
      const report = buildLiveEdgeDiggerReport({
        generatedAt: new Date(nowMs).toISOString(),
        observations: rows.map((r) => ({ ...r, candidateId: candidateIdFor(EDGE_RULE_FRONTIER[0]!) })),
        attempts: [], coverage: null,
        scanner: {
          cyclesRun: 4, lastCycleAt: null, lastError: null, universeSize: 4,
          regime: "MIXED", regimeFamily: "MIXED", breadth: 0.5, cohesion: 0.5, dispersion: 0.02,
        },
      });
      expect(report.verdict).toBe("CENSORED_NO_MATURED_FORWARD_EVIDENCE");
      expect(report.collection.judgeableRows).toBe(0);
      expect(report.collection.policyVersion).toBe(2);
      expect(report.bestCandidateId).toBeNull();
      expect(report.recommendation).toBeNull();
    });

    it("[CENSOR] a censored candidate can never be ranked, recommended or promoted", () => {
      const { rows, nowMs } = censoredFixture();
      const report = buildLiveEdgeDiggerReport({
        generatedAt: new Date(nowMs).toISOString(),
        observations: rows.map((r) => ({ ...r, candidateId: candidateIdFor(EDGE_RULE_FRONTIER[0]!) })),
        attempts: [], coverage: null,
        scanner: {
          cyclesRun: 4, lastCycleAt: null, lastError: null, universeSize: 4,
          regime: "MIXED", regimeFamily: "MIXED", breadth: 0.5, cohesion: 0.5, dispersion: 0.02,
        },
      });
      expect(report.candidates.every((c) => c.lifecycle !== "CANDIDATE")).toBe(true);
      expect(report.candidates.every((c) => c.lifecycle !== "RECOMMENDED_FOR_3102_REVIEW")).toBe(true);
      expect(report.lifecycleCounts.CANDIDATE).toBe(0);
      expect(report.lifecycleCounts.RECOMMENDED_FOR_3102_REVIEW).toBe(0);
    });

    it("[MATURITY] maturity is elapsed TIME, not resolution", () => {
      const openRow = row({ observationId: "o", openedAtMs: BASE, maxHoldHours: 24 });
      expect(isMatured(openRow, BASE + 23 * HOUR)).toBe(false);
      expect(isMatured(openRow, BASE + 24 * HOUR)).toBe(true);
      // A row that stopped out in 20 minutes is RESOLVED but not matured — its farther target
      // never got the chance the nearer stop did.
      const fastStop = row({
        observationId: "s", openedAtMs: BASE, maxHoldHours: 24,
        status: "CLOSED_LOSS", resolvedAt: new Date(BASE + 20 * 60_000).toISOString(),
        exitPrice: 98, exitReason: "STOP", grossR: -1, costR: -0.11, netR: -1.11, holdHours: 0.33,
      });
      expect(isMatured(fastStop, BASE + HOUR)).toBe(false);
      expect(isJudgeableEvidence(fastStop, BASE + HOUR)).toBe(false);
      expect(isJudgeableEvidence(fastStop, BASE + 25 * HOUR)).toBe(true);
    });
  });
});
