import { atr, ema, highestHigh, lowestLow, rsi } from "../signals/indicators.js";
import type { TournamentCandle, TournamentIntent, TournamentSide, TournamentStrategyId } from "../tournament-types.js";

export interface StrategyBar {
  symbol: string;
  index: number;
  candle: TournamentCandle;
  history: readonly TournamentCandle[];
  /** Only symbols eligible at this decision time. */
  eligibleSymbols: ReadonlySet<string>;
  nextOpenTimeMs: number | null;
}

export interface TournamentStrategy {
  id: TournamentStrategyId;
  version: string;
  /** Every key/value tried is persisted by the runner; no hidden optimisation. */
  parameters: Record<string, number | string | boolean>;
  onCompletedBar(bar: StrategyBar): TournamentIntent[];
}

export interface DirectionalParameters {
  stopAtr: number;
  targetAtr: number;
  maxHoldBars: number;
}

const DEFAULT_DIRECTIONAL: DirectionalParameters = { stopAtr: 2, targetAtr: 3, maxHoldBars: 48 };

function intent(input: {
  id: TournamentStrategyId;
  bar: StrategyBar;
  side: TournamentSide;
  params?: DirectionalParameters;
  exitTemplate: string;
  score?: number;
  metadata?: Record<string, string | number | boolean | null>;
}): TournamentIntent | null {
  if (input.bar.nextOpenTimeMs === null || !input.bar.eligibleSymbols.has(input.bar.symbol)) return null;
  const range = atr([...input.bar.history, input.bar.candle], 14);
  if (range === null || range <= 0) return null;
  const params = input.params ?? DEFAULT_DIRECTIONAL;
  return {
    strategyId: input.id,
    symbol: input.bar.symbol,
    side: input.side,
    decisionTimeMs: input.bar.candle.closeTimeMs,
    entryAtOpenTimeMs: input.bar.nextOpenTimeMs,
    stopFraction: (range * params.stopAtr) / input.bar.candle.close,
    targetFraction: (range * params.targetAtr) / input.bar.candle.close,
    maxHoldBars: params.maxHoldBars,
    exitTemplate: input.exitTemplate,
    score: input.score ?? 1,
    metadata: input.metadata ?? {},
  };
}

function singleton(value: TournamentIntent | null): TournamentIntent[] { return value ? [value] : []; }

export function cashStrategy(): TournamentStrategy {
  return { id: "CASH", version: "cash-v1", parameters: {}, onCompletedBar: () => [] };
}

/** Benchmark only: uses shared wallet/exposure caps, but intentionally has no tactical stop. */
export function buyAndHoldStrategy(symbol = "BTCUSDT"): TournamentStrategy {
  return {
    id: "BTC_BUY_AND_HOLD",
    version: "buy-hold-v1",
    parameters: { symbol },
    onCompletedBar: (bar) => bar.symbol === symbol && bar.index === 0 && bar.nextOpenTimeMs !== null && bar.eligibleSymbols.has(symbol)
      ? [{ strategyId: "BTC_BUY_AND_HOLD", symbol, side: "LONG", decisionTimeMs: bar.candle.closeTimeMs, entryAtOpenTimeMs: bar.nextOpenTimeMs, stopFraction: null, targetFraction: null, maxHoldBars: Number.MAX_SAFE_INTEGER, exitTemplate: "BENCHMARK_END_OF_DATA", score: 1, metadata: { benchmark: true } }]
      : [],
  };
}

/** Equal-weight benchmark: only assets eligible at the first decision may enter. */
export function equalWeightHoldStrategy(): TournamentStrategy {
  return {
    id: "EQUAL_WEIGHT_HOLD",
    version: "equal-weight-hold-v1",
    parameters: {},
    onCompletedBar: (bar) => bar.index === 0 && bar.nextOpenTimeMs !== null && bar.eligibleSymbols.has(bar.symbol)
      ? [{ strategyId: "EQUAL_WEIGHT_HOLD", symbol: bar.symbol, side: "LONG", decisionTimeMs: bar.candle.closeTimeMs, entryAtOpenTimeMs: bar.nextOpenTimeMs, stopFraction: null, targetFraction: null, maxHoldBars: Number.MAX_SAFE_INTEGER, exitTemplate: "BENCHMARK_END_OF_DATA", score: 1, metadata: { benchmark: true, equalWeight: true } }]
      : [],
  };
}

export function donchianStrategy(parameters: Partial<DirectionalParameters> & { lookback?: number } = {}): TournamentStrategy {
  const params = { ...DEFAULT_DIRECTIONAL, ...parameters };
  const lookback = parameters.lookback ?? 20;
  return {
    id: "DONCHIAN", version: "donchian-v1", parameters: { ...params, lookback },
    onCompletedBar: (bar) => {
      const previous = bar.history;
      const high = highestHigh(previous, lookback);
      const low = lowestLow(previous, lookback);
      if (high === null || low === null) return [];
      if (bar.candle.close > high) return singleton(intent({ id: "DONCHIAN", bar, side: "LONG", params, exitTemplate: "ATR_BRACKET", score: (bar.candle.close - high) / high }));
      if (bar.candle.close < low) return singleton(intent({ id: "DONCHIAN", bar, side: "SHORT", params, exitTemplate: "ATR_BRACKET", score: (low - bar.candle.close) / low }));
      return [];
    },
  };
}

export function emaCrossStrategy(parameters: Partial<DirectionalParameters> & { fast?: number; slow?: number } = {}): TournamentStrategy {
  const params = { ...DEFAULT_DIRECTIONAL, ...parameters };
  const fast = parameters.fast ?? 12;
  const slow = parameters.slow ?? 48;
  if (fast >= slow) throw new Error("TOURNAMENT_EMA_FAST_MUST_BE_LESS_THAN_SLOW");
  return {
    id: "EMA_CROSS", version: "ema-cross-v1", parameters: { ...params, fast, slow },
    onCompletedBar: (bar) => {
      const closes = [...bar.history, bar.candle].map((candle) => candle.close);
      const prior = closes.slice(0, -1);
      const nowFast = ema(closes, fast); const nowSlow = ema(closes, slow);
      const oldFast = ema(prior, fast); const oldSlow = ema(prior, slow);
      if ([nowFast, nowSlow, oldFast, oldSlow].some((value) => value === null)) return [];
      if (oldFast! <= oldSlow! && nowFast! > nowSlow!) return singleton(intent({ id: "EMA_CROSS", bar, side: "LONG", params, exitTemplate: "ATR_BRACKET", score: nowFast! - nowSlow! }));
      if (oldFast! >= oldSlow! && nowFast! < nowSlow!) return singleton(intent({ id: "EMA_CROSS", bar, side: "SHORT", params, exitTemplate: "ATR_BRACKET", score: nowSlow! - nowFast! }));
      return [];
    },
  };
}

export function macdStrategy(parameters: Partial<DirectionalParameters> & { fast?: number; slow?: number; signal?: number } = {}): TournamentStrategy {
  const params = { ...DEFAULT_DIRECTIONAL, ...parameters };
  const fast = parameters.fast ?? 12; const slow = parameters.slow ?? 26; const signal = parameters.signal ?? 9;
  if (fast >= slow) throw new Error("TOURNAMENT_MACD_FAST_MUST_BE_LESS_THAN_SLOW");
  const macdLine = (closes: number[]): number | null => {
    const short = ema(closes, fast); const long = ema(closes, slow);
    return short === null || long === null ? null : short - long;
  };
  return {
    id: "MACD", version: "macd-v1", parameters: { ...params, fast, slow, signal },
    onCompletedBar: (bar) => {
      const closes = [...bar.history, bar.candle].map((candle) => candle.close);
      if (closes.length < slow + signal + 2) return [];
      const lines = closes.map((_value, index) => macdLine(closes.slice(0, index + 1))).filter((value): value is number => value !== null);
      const previousLines = lines.slice(0, -1);
      const now = lines.at(-1) ?? null; const before = previousLines.at(-1) ?? null;
      const nowSignal = ema(lines, signal); const oldSignal = ema(previousLines, signal);
      if ([now, before, nowSignal, oldSignal].some((value) => value === null)) return [];
      if (before! <= oldSignal! && now! > nowSignal!) return singleton(intent({ id: "MACD", bar, side: "LONG", params, exitTemplate: "ATR_BRACKET", score: now! - nowSignal! }));
      if (before! >= oldSignal! && now! < nowSignal!) return singleton(intent({ id: "MACD", bar, side: "SHORT", params, exitTemplate: "ATR_BRACKET", score: nowSignal! - now! }));
      return [];
    },
  };
}

export function rsiMeanReversionStrategy(parameters: Partial<DirectionalParameters> & { period?: number; oversold?: number; overbought?: number } = {}): TournamentStrategy {
  const params = { ...DEFAULT_DIRECTIONAL, ...parameters };
  const period = parameters.period ?? 14; const oversold = parameters.oversold ?? 30; const overbought = parameters.overbought ?? 70;
  return {
    id: "RSI_MEAN_REVERSION", version: "rsi-mean-reversion-v1", parameters: { ...params, period, oversold, overbought },
    onCompletedBar: (bar) => {
      const value = rsi([...bar.history, bar.candle].map((candle) => candle.close), period);
      if (value === null) return [];
      if (value <= oversold) return singleton(intent({ id: "RSI_MEAN_REVERSION", bar, side: "LONG", params, exitTemplate: "ATR_BRACKET", score: oversold - value }));
      if (value >= overbought) return singleton(intent({ id: "RSI_MEAN_REVERSION", bar, side: "SHORT", params, exitTemplate: "ATR_BRACKET", score: value - overbought }));
      return [];
    },
  };
}

export interface FrozenKronosSignal extends Omit<TournamentIntent, "strategyId"> {
  /** Hash of a frozen, point-in-time signal ledger. Runtime stores are forbidden. */
  sourceLedgerHash: string;
}

export interface FrozenKronosRegimeSnapshot {
  asOfMs: number;
  regime: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNKNOWN";
  sourceLedgerHash: string;
}

/**
 * An ablation wrapper that changes exactly one thing: whether a frozen Kronos
 * regime permits the baseline direction. It never recomputes a regime from the
 * full history and refuses a snapshot that was not known at decision close.
 */
export function withKronosRegimeGate(input: {
  baseline: TournamentStrategy;
  strategyId: "DONCHIAN_WITH_KRONOS_REGIME" | "MACD_WITH_KRONOS_REGIME";
  snapshots: readonly FrozenKronosRegimeSnapshot[];
}): TournamentStrategy {
  if (input.snapshots.some((snapshot) => !snapshot.sourceLedgerHash)) throw new Error("TOURNAMENT_KRONOS_REGIME_LEDGER_HASH_MISSING");
  const byAsOf = new Map(input.snapshots.map((snapshot) => [snapshot.asOfMs, snapshot]));
  return {
    id: input.strategyId,
    version: `${input.baseline.version}+kronos-regime-v1`,
    parameters: { ...input.baseline.parameters, regimeGate: true, frozenRegimeSnapshots: input.snapshots.length, frozenRegimeLedgerHashes: [...new Set(input.snapshots.map((snapshot) => snapshot.sourceLedgerHash))].sort().join(",") },
    onCompletedBar: (bar) => {
      const snapshot = byAsOf.get(bar.candle.closeTimeMs);
      if (!snapshot) return [];
      const intents = input.baseline.onCompletedBar(bar);
      return intents
        .filter((candidate) => (candidate.side === "LONG" && snapshot.regime === "BULLISH") || (candidate.side === "SHORT" && snapshot.regime === "BEARISH"))
        .map((candidate) => ({ ...candidate, strategyId: input.strategyId, metadata: { ...candidate.metadata, kronosRegime: snapshot.regime, kronosRegimeLedgerHash: snapshot.sourceLedgerHash } }));
    },
  };
}

/** Adapter deliberately refuses to synthesize "current Kronos" from future/runtime state. */
export function currentKronosAdapter(signals: readonly FrozenKronosSignal[]): TournamentStrategy {
  if (signals.some((signal) => !signal.sourceLedgerHash)) throw new Error("TOURNAMENT_KRONOS_LEDGER_HASH_MISSING");
  const byDecision = new Map<number, FrozenKronosSignal[]>();
  for (const signal of signals) byDecision.set(signal.decisionTimeMs, [...(byDecision.get(signal.decisionTimeMs) ?? []), signal]);
  return {
    id: "KRONOS_CURRENT", version: "kronos-current-adapter-v1", parameters: { frozenSignals: signals.length, frozenSignalLedgerHashes: [...new Set(signals.map((signal) => signal.sourceLedgerHash))].sort().join(",") },
    onCompletedBar: (bar) => (byDecision.get(bar.candle.closeTimeMs) ?? [])
      .filter((signal) => signal.symbol === bar.symbol && bar.eligibleSymbols.has(signal.symbol))
      .map((signal) => ({ ...signal, strategyId: "KRONOS_CURRENT" as const, metadata: { ...signal.metadata, sourceLedgerHash: signal.sourceLedgerHash } })),
  };
}

export interface RandomControlReference {
  referenceId: string;
  symbol: string;
  /** Original point-in-time entry, needed to prove concurrency preservation. */
  referenceEntryTimeMs: number;
  side: TournamentSide;
  stopFraction: number | null;
  targetFraction: number | null;
  maxHoldBars: number;
  exitTemplate: string;
  score: number;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RandomControlParity {
  passes: boolean;
  failures: string[];
}

function profileAtTimes(entries: readonly { entryTimeMs: number; maxHoldBars: number }[], times: readonly number[]): number[] {
  return times.map((time, index) => entries.filter((entry) => {
    const start = times.indexOf(entry.entryTimeMs);
    return start >= 0 && index >= start && index < start + entry.maxHoldBars;
  }).length);
}

/**
 * A timing-only control must prove its full planned ledger is comparable before
 * it is allowed to run. Actual fills remain subject to the same shared caps.
 */
export function assertRandomControlPlanParity(input: {
  reference: readonly RandomControlReference[];
  planned: readonly (RandomControlReference & { entryTimeMs: number })[];
  timeline: readonly number[];
}): RandomControlParity {
  const failures: string[] = [];
  if (input.reference.length !== input.planned.length) failures.push("TRADE_COUNT");
  const referenceById = new Map(input.reference.map((entry) => [entry.referenceId, entry]));
  for (const entry of input.planned) {
    const reference = referenceById.get(entry.referenceId);
    if (!reference || reference.symbol !== entry.symbol || reference.side !== entry.side || reference.stopFraction !== entry.stopFraction || reference.targetFraction !== entry.targetFraction || reference.maxHoldBars !== entry.maxHoldBars || reference.exitTemplate !== entry.exitTemplate || reference.score !== entry.score) failures.push(`TEMPLATE_${entry.referenceId}`);
  }
  const directionMix = (entries: readonly { side: TournamentSide }[]) => entries.reduce((counts, entry) => ({ ...counts, [entry.side]: (counts[entry.side] ?? 0) + 1 }), {} as Record<TournamentSide, number>);
  if (JSON.stringify(directionMix(input.reference)) !== JSON.stringify(directionMix(input.planned))) failures.push("DIRECTION_MIX");
  const originalProfile = profileAtTimes(input.reference.map((entry) => ({ entryTimeMs: entry.referenceEntryTimeMs, maxHoldBars: entry.maxHoldBars })), input.timeline);
  const plannedProfile = profileAtTimes(input.planned, input.timeline);
  // Timing moves, but the distribution of simultaneous planned positions may not.
  if (JSON.stringify([...originalProfile].sort((a, b) => a - b)) !== JSON.stringify([...plannedProfile].sort((a, b) => a - b))) failures.push("CONCURRENCY_PROFILE");
  return { passes: failures.length === 0, failures };
}

/** Xorshift is explicit so random controls reproduce without platform RNG state. */
function xorshift(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
}

/**
 * Randomise only entry timing. Direction, stop/target, max-hold, exit template,
 * score and therefore sizing/concurrency demand are copied verbatim from the
 * reference plan. Callers must persist this planned map in the run manifest.
 */
export function randomTimingControl(input: { reference: readonly RandomControlReference[]; eligibleEntryTimesBySymbol: ReadonlyMap<string, readonly number[]>; seed: number }): TournamentStrategy {
  const rng = xorshift(input.seed);
  const planned = new Map<number, RandomControlReference[]>();
  const plan: Array<RandomControlReference & { entryTimeMs: number }> = [];
  const timeline = [...new Set([...input.eligibleEntryTimesBySymbol.values()].flat())].sort((a, b) => a - b);
  for (const reference of input.reference) {
    const candidates = [...(input.eligibleEntryTimesBySymbol.get(reference.symbol) ?? [])].sort((a, b) => a - b);
    if (candidates.length === 0) throw new Error(`TOURNAMENT_RANDOM_CONTROL_NO_ELIGIBLE_TIME_${reference.symbol}`);
    const viable = candidates.filter((candidate) => {
      const candidateIndex = candidates.indexOf(candidate);
      return !plan.some((existing) => {
        if (existing.symbol !== reference.symbol) return false;
        const existingIndex = candidates.indexOf(existing.entryTimeMs);
        return candidateIndex < existingIndex + existing.maxHoldBars && existingIndex < candidateIndex + reference.maxHoldBars;
      });
    });
    if (viable.length === 0) throw new Error(`TOURNAMENT_RANDOM_CONTROL_SYMBOL_CONCURRENCY_UNAVAILABLE_${reference.symbol}`);
    const selected = viable[Math.floor(rng() * viable.length)]!;
    planned.set(selected, [...(planned.get(selected) ?? []), reference]);
    plan.push({ ...reference, entryTimeMs: selected });
  }
  const parity = assertRandomControlPlanParity({ reference: input.reference, planned: plan, timeline });
  if (!parity.passes) throw new Error(`TOURNAMENT_RANDOM_CONTROL_PARITY_FAIL_${parity.failures.join("_")}`);
  return {
    id: "RANDOM_CONTROL", version: "random-timing-control-v1", parameters: { seed: input.seed, referenceTrades: input.reference.length },
    onCompletedBar: (bar) => (planned.get(bar.nextOpenTimeMs ?? -1) ?? [])
      .filter((reference) => reference.symbol === bar.symbol && bar.eligibleSymbols.has(reference.symbol) && bar.nextOpenTimeMs !== null)
      .map((reference) => ({ strategyId: "RANDOM_CONTROL" as const, symbol: reference.symbol, side: reference.side, decisionTimeMs: bar.candle.closeTimeMs, entryAtOpenTimeMs: bar.nextOpenTimeMs!, stopFraction: reference.stopFraction, targetFraction: reference.targetFraction, maxHoldBars: reference.maxHoldBars, exitTemplate: reference.exitTemplate, score: reference.score, metadata: { ...reference.metadata, randomised: true, randomReferenceId: reference.referenceId } })),
  };
}
