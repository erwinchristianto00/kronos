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
  EPISODE_BLOCK_WIDTH_MS,
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
  LiveEdgeDiggerStore,
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
            regimeAtEntry: "r", features: {} as never, status: "CLOSED_WIN", resolvedAt: "x",
            exitPrice: 103, exitReason: "TARGET", grossR: 1.5, costR: -0.1, netR: 1.4, holdHours: 1,
          });
        }
      }
      const report = buildCandidateReport(freezeCandidate(EDGE_RULE_FRONTIER[0]!, "2026-08-06T00:00:00.000Z"),
        rows.map((r) => ({ ...r, candidateId: candidateIdFor(EDGE_RULE_FRONTIER[0]!) })));
      const dev = report.partitions.find((p) => p.partition === "DEV")!;
      expect(dev.rows).toBe(60);
      expect(dev.episodes).toBe(3);
      const devGate = report.gates.find((g) => g.id === "dev_episodes")!;
      expect(devGate.current).toBe(3); // episodes, NOT 60 rows
      expect(devGate.pass).toBe(false);
      expect(report.decision).toBe("REJECT");
    });

    it("a candidate with no evidence REJECTs with an explicit reason and never becomes the best", () => {
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
        expect(c.decision).toBe("REJECT");
        expect(c.rejectionReasons.join(" ")).toContain("no resolved forward evidence");
      }
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
      expect(legacy.decision).toBe("REJECT");
      expect(legacy.rejectionReasons.some((r) => r.startsWith("freeze integrity:"))).toBe(true);

      // And an anchor set AFTER the row it claims to precede is caught, not rounded away.
      const backdated = buildCandidateReport(
        freezeCandidate(rule, new Date(BASE + HOUR).toISOString()), [row],
      );
      expect(backdated.freezeIntegrity.rowsOpenedBeforeFreeze).toBe(1);
      expect(backdated.freezeIntegrity.ok).toBe(false);
      expect(backdated.decision).toBe("REJECT");
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
});
