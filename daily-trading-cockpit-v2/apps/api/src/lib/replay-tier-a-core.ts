/**
 * Tier-A candle-proof — FROZEN reconstruction core. This module is the single source of the reconstruction
 * RULES (features, thresholds, labels, model family inputs, execution-cost levels) shared by BOTH the one-month
 * runner and the six-month runner, so "do not change the rules after seeing monthly results" is enforced by
 * shared code rather than copy-paste. Pure + deterministic (no Date.now / Math.random / I/O). Touches NO live
 * state, beta, CORTEX, or executor.
 *
 * Provenance: candle features are RECONSTRUCTED_HISTORICAL from closed candles only (strict causality). breadth /
 * liquidity / sentiment / eventRisk are MISSING (2-symbol survivorship-controlled universe + LIVE_ONLY inputs)
 * and are passed as {value:null} — never fabricated.
 */
import { computeEMA, computeATR, computeATRPercentile } from "./candle-indicators.js";
import { decideMarketState } from "./market-state-brain.js";
import { decideDirection } from "./direction-brain.js";
import { buildSnapshotAudit, isCausal, candleAvailableAt } from "./replay-clock.js";
import { classifyReplayRow, type ReplayRowStatus } from "./replay-quality-status.js";
import { simulateExecution, totalExecutionCostR, type EmulatorConfig } from "./replay-execution-emulator.js";
import type { DirectionHorizon } from "./four-brain-types.js";

export const HOUR = 3_600_000;
export const HORIZON_BARS: Record<DirectionHorizon, number> = { SCALP: 1, INTRADAY: 4, SWING: 24 };
export const WARMUP = 60; // bars before the first decision (EMA50/ATR14 + percentile window)
export const GAP_LOOKBACK_BARS = 168; // 7d — the widest rolling window any Tier-A feature reads (ATR percentile)
export const HURDLE_R = 0.03;
export const RISK_ATR_MULT = 1.5;
export const EXEC_LEVEL_KEYS = ["L0", "L1_low", "L1_base", "L1_high"] as const;
export type ExecLevelKey = (typeof EXEC_LEVEL_KEYS)[number];
// Pre-registered execution cost assumptions (bps). Tier-A has NO order book ⇒ these are ASSUMPTIONS, swept.
export const EXEC_LEVELS: Record<ExecLevelKey, EmulatorConfig> = {
  L0: { level: 0, spreadBps: 0, latencyMs: 0, takerFeeBps: 5, makerFeeBps: 1, slippageBps: 0 },
  L1_low: { level: 1, spreadBps: 1, latencyMs: 100, takerFeeBps: 5, makerFeeBps: 1, slippageBps: 0.5 },
  L1_base: { level: 1, spreadBps: 4, latencyMs: 250, takerFeeBps: 5, makerFeeBps: 1, slippageBps: 2 },
  L1_high: { level: 1, spreadBps: 10, latencyMs: 500, takerFeeBps: 5, makerFeeBps: 1, slippageBps: 6 },
};

export interface Candle { openTime: number; open: number; high: number; low: number; close: number; volume: number; closeTime: number; takerBuy: number; }
export interface TAMarketRow { symbol: string; tMs: number; family: string; bias: string; vol: string; conf: number; unknown: boolean; causal: boolean; status: ReplayRowStatus; }
export interface TADirRow {
  symbol: string; horizon: DirectionHorizon; tMs: number; x: number[]; action: string; bestAction: string;
  longNetR: Record<string, number>; shortNetR: Record<string, number>; chosenNetR: number | null; win: 0 | 1 | null; status: ReplayRowStatus;
}

const tanh = (x: number): number => Math.tanh(x);
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** Parse a Binance-vision klines CSV body (header row auto-skipped). Sorted ascending by openTime. */
export function parseKlines(csvText: string): Candle[] {
  const out: Candle[] = [];
  for (const line of csvText.split("\n")) {
    if (!line.trim()) continue;
    const c = line.split(",");
    if (!/^\d/.test(c[0]!)) continue; // skip header
    out.push({ openTime: +c[0]!, open: +c[1]!, high: +c[2]!, low: +c[3]!, close: +c[4]!, volume: +c[5]!, closeTime: +c[6]!, takerBuy: +(c[9] ?? 0) });
  }
  return out.sort((a, b) => a.openTime - b.openTime);
}

/** Count non-contiguous 1h boundaries (chronological-integrity / cross-month contiguity check). */
export function countHourGaps(candles: Candle[]): number {
  let gaps = 0;
  for (let i = 1; i < candles.length; i += 1) if (candles[i]!.openTime - candles[i - 1]!.openTime !== HOUR) gaps += 1;
  return gaps;
}

/**
 * True iff a non-contiguous 1h boundary — the same "gap" signature `countHourGaps` tallies globally, e.g. a
 * missing/empty monthly CSV silently concatenated at a month boundary (see scripts/replay-tier-a-6mo-run.ts and
 * scripts/replay-entry-exit-6mo-run.ts, which both substitute `[]` for any absent monthly file rather than
 * failing loudly) — falls inside the causal lookback window feeding THIS row's features. Only looks BACKWARD
 * from `i` (a gap after `i` cannot corrupt a decision already made at `i`), bounded to `lookbackBars` (the
 * widest rolling window any Tier-A feature actually reads — see GAP_LOOKBACK_BARS). This is what lets DATA_GAP
 * actually fire in classifyReplayRow instead of being permanently hardcoded false.
 */
export function hasDataGapInLookback(candles: Candle[], i: number, lookbackBars: number): boolean {
  const start = Math.max(1, i - lookbackBars + 1);
  for (let k = start; k <= i; k += 1) {
    if (candles[k]!.openTime - candles[k - 1]!.openTime !== HOUR) return true;
  }
  return false;
}

export interface ReconstructResult {
  marketRows: TAMarketRow[]; dirRows: TADirRow[]; gaps: number;
  candidateTimestamps: number; leakGuardHits: number; causalDecisions: number; labeled: number;
}

/**
 * FROZEN per-symbol reconstruction: for each bar after WARMUP, decide Market State + Direction (all horizons)
 * from closed-candle features under strict causality, and attach counterfactual long/short netR at each frozen
 * execution level. Identical logic to the validated one-month proof.
 */
export function reconstructSymbol(symbol: string, candles: Candle[]): ReconstructResult {
  const marketRows: TAMarketRow[] = [];
  const dirRows: TADirRow[] = [];
  let candidateTimestamps = 0, leakGuardHits = 0, causalDecisions = 0, labeled = 0;
  const gaps = countHourGaps(candles);

  const closes = candles.map((c) => c.close);
  const ema50 = computeEMA(closes, 50);
  const atr14 = computeATR(candles, 14);
  const atrPct = atr14.map((a, i) => (finite(a) && closes[i]! > 0 ? a / closes[i]! : null));
  const atrPctile = computeATRPercentile(atrPct, GAP_LOOKBACK_BARS); // 7d rolling percentile (causal)

  for (let i = WARMUP; i < candles.length; i += 1) {
    candidateTimestamps += 1;
    const c = candles[i]!;
    const decisionAtMs = c.closeTime + 1; // decision made JUST after the bar closes (no early high/low)
    if (!candleAvailableAt(c.openTime, HOUR, decisionAtMs)) { leakGuardHits += 1; continue; } // CAUSALITY GUARD

    const trendRaw = finite(ema50[i]) && finite(atr14[i]) && atr14[i]! > 0 ? tanh((c.close - ema50[i]!) / (2 * atr14[i]!)) : null;
    const vol = finite(atrPctile[i]) ? atrPctile[i]! / 100 : null;
    const roc = i >= 20 && closes[i - 20]! > 0 ? closes[i]! / closes[i - 20]! - 1 : null;
    const mom = roc !== null ? tanh(roc / 0.05) : null;
    const asOf = c.closeTime;
    const dataGap = hasDataGapInLookback(candles, i, GAP_LOOKBACK_BARS);

    const audit = buildSnapshotAudit(decisionAtMs, [{ name: "btc1h", ts: c.closeTime }], () => 6 * HOUR);
    const causal = isCausal(audit);

    const ms = decideMarketState({
      nowMs: decisionAtMs, validityMs: HOUR,
      trend: { value: trendRaw, asOfMs: asOf }, volatility: { value: vol, asOfMs: asOf },
      liquidity: { value: null, asOfMs: asOf }, breadth: { value: null, asOfMs: asOf }, // breadth MISSING (2-symbol universe)
      momentum: { value: mom, asOfMs: asOf }, eventRisk: { value: null }, sentiment: { value: null }, safetyEvents: [],
    });
    const featuresPresent = finite(trendRaw) && finite(vol) && finite(mom);
    const msStatus = classifyReplayRow({ purpose: "MarketState", timestampsCausal: causal, schemaMatch: true, configVersioned: true, dataGap, labelSafe: true, requiredFeaturesPresent: featuresPresent, dataTier: "A_CANDLE", executionCalibrated: false, modelFitEligible: true }).status;
    marketRows.push({ symbol, tMs: decisionAtMs, family: ms.family, bias: ms.bias, vol: ms.volatility, conf: ms.confidence, unknown: ms.family === "UNKNOWN", causal, status: msStatus });
    if (causal) causalDecisions += 1;

    for (const horizon of Object.keys(HORIZON_BARS) as DirectionHorizon[]) {
      const H = HORIZON_BARS[horizon];
      const dir = decideDirection({
        nowMs: decisionAtMs, validityMs: HOUR, horizon, marketBias: ms.bias, transitionRisk: ms.transitionRisk,
        longEdge: { value: null }, shortEdge: { value: null }, conviction: { value: null }, // edge-memory/controller MISSING historically
      });
      let longNetR: Record<string, number> = {}, shortNetR: Record<string, number> = {}, bestAction = "FLAT", chosenNetR: number | null = null, win: 0 | 1 | null = null;
      if (i + H < candles.length && finite(atr14[i]) && atr14[i]! > 0) {
        const entry = c.close, exit = candles[i + H]!.close, risk = RISK_ATR_MULT * atr14[i]!;
        const grossLong = (exit - entry) / risk;
        for (const [name, cfg] of Object.entries(EXEC_LEVELS)) {
          const oneWay = totalExecutionCostR(simulateExecution({ orderId: "e", decisionId: "d", side: "BUY", type: "MARKET", requestedQty: 1, referencePrice: entry, riskDistancePrice: risk, submittedAtMs: decisionAtMs }, cfg));
          const cost = 2 * oneWay; // round trip
          longNetR[name] = grossLong - cost;
          shortNetR[name] = -grossLong - cost;
        }
        const lb = longNetR.L1_base!, sb = shortNetR.L1_base!;
        bestAction = lb >= sb && lb > 0 ? "LONG" : sb > 0 ? "SHORT" : "FLAT";
        chosenNetR = dir.action === "LONG" ? lb : dir.action === "SHORT" ? sb : 0;
        win = chosenNetR > HURDLE_R ? 1 : 0;
        labeled += 1;
      }
      const dStatus = classifyReplayRow({ purpose: "Direction", timestampsCausal: causal, schemaMatch: true, configVersioned: true, dataGap, labelSafe: chosenNetR !== null, requiredFeaturesPresent: featuresPresent, dataTier: "A_CANDLE", executionCalibrated: false, modelFitEligible: true }).status;
      dirRows.push({ symbol, horizon, tMs: decisionAtMs, x: [trendRaw ?? 0, vol ?? 0, mom ?? 0], action: dir.action, bestAction, longNetR, shortNetR, chosenNetR, win, status: dStatus });
    }
  }
  return { marketRows, dirRows, gaps, candidateTimestamps, leakGuardHits, causalDecisions, labeled };
}

/** UTC calendar-day key (integer days since epoch) — the clustering unit for the day-block bootstrap. */
export const dayKey = (tMs: number): number => Math.floor(tMs / 86_400_000);
/** UTC month key "YYYY-MM" for per-month breakdowns (deterministic, no Date needed for the label). */
export function monthKey(tMs: number): string {
  const days = Math.floor(tMs / 86_400_000);
  // derive Y-M from epoch-days without Date: walk years/months (small, deterministic).
  let y = 1970, d = days;
  const isLeap = (yy: number) => (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
  for (;;) { const dy = isLeap(y) ? 366 : 365; if (d < dy) break; d -= dy; y += 1; }
  const mlen = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let m = 0; for (; m < 12; m += 1) { if (d < mlen[m]!) break; d -= mlen[m]!; }
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}
