/**
 * Four-Brain LIVE gather BINDINGS (Phase 2, IMPURE). Adapts VERIFIED live singletons into the pure
 * assembler's FourBrainGatherInput. Thin + dependency-injected: every live read is a field on
 * FourBrainBindingDeps, so the mapping is unit-testable with fakes and the real wiring (app.ts / the
 * dry-run script) supplies the singletons. NEVER mutates state, NEVER calls an executor.
 *
 * Unit conventions (from the verified deliverable-#1 mapping):
 *   • axisScore −1..+1 (trend); BTC ATR percentile 0..100 → /100 (volatility proxy — there is no single
 *     market-wide vol number, only per-symbol, so BTC ATR%ile is the documented proxy); advancersPct 0..1
 *     → ×2−1 (breadth); edge-memory avgNetR is in R with the n=0 FABRICATED-0 trap → null when n===0.
 *   • Sources with NO live producer are emitted MISSING with an explicit reason (liquidity depth, entry
 *     microstructure, decay signals, event risk) — NEVER fabricated as 0.
 */
import { calculateTimeframeIndicators, type Candle } from "@dtc/shared";
import { deriveDirectionVeto, CORTEX_LANE_ROSTER, type CortexLaneDirection } from "./cortex-live-gather.js";
import { FOUR_BRAIN_LANE_SUPPORT, FOUR_BRAIN_SUPPORTED_LANES as SUPPORTED_LANES } from "./four-brain-lane-support.js";
import type { MarketSafetyEvent } from "./market-state-brain.js";
import { fourBrainMode, type DirectionHorizon } from "./four-brain-types.js";
import { getFourBrainEdgeMemory, fourBrainEdgeVerdict } from "./four-brain-edge-memory.js";
import {
  FRESHNESS_TTL_MS,
  type EntryCandidateRaw,
  type ExitCandidateRaw,
  type ExecContext,
  type FourBrainGatherInput,
  type FourBrainIdentity,
  type RawReadingInput,
} from "./four-brain-live-gather.js";

/** Each roster lane's supported horizon (tactical lanes are INTRADAY; composite/basket are SWING). */
export function laneHorizon(laneId: string): DirectionHorizon {
  const id = laneId.toUpperCase();
  if (id.includes("INTRADAY") || id.includes("SHORT_FADE") || id.includes("PANIC") || id.includes("FAST")) return "INTRADAY";
  return "SWING";
}
const laneDirection = new Map(FOUR_BRAIN_LANE_SUPPORT.map((e) => [e.laneId, e.direction]));
/** Roster + PROFIT_CORE_SHORT_TRAIL — the lanes the four-brain layer supports (from the lane-support registry). */
export const FOUR_BRAIN_SUPPORTED_LANES: ReadonlySet<string> = SUPPORTED_LANES;

/** A verified single-symbol edge report (R + resolved count). */
export interface LaneReportLike {
  netAvgR: number | null;
  resolvedCount: number;
}
export interface EdgeMemoryLike {
  lookup(regimeRaw: string | null, direction: "LONG" | "SHORT"): { avgNetR: number; n: number };
  verdict(regimeRaw: string | null, direction: "LONG" | "SHORT"): { decision: string };
  hasPositiveLane(regimeRaw: string | null, direction: "LONG" | "SHORT"): boolean;
}

/** Candle-microstructure for one symbol/side (adapter B). Order-book (spread/slippage) is NOT candle-derived
 *  → stays null (MISSING). candleFresh gates ENTER_NOW; observedAtMs is the last candle open time. */
export interface EntryMicrostructure {
  distanceFromVwapAtr: number | null;
  candleExtensionAtr: number | null;
  breakoutConfirmed: boolean | null;
  volumeConfirmed: boolean | null;
  candleFresh: boolean;
  observedAtMs: number | null;
}

/** A minimal shape of packages/shared calculateTimeframeIndicators() output. */
export interface TimeframeIndicatorLike {
  vwap: number | null;
  distanceFromVwap: number | null; // percent
  volumeRatio: number | null;
  breakoutHigh: boolean;
  breakoutLow: boolean;
  atr: number | null;
  isFresh: boolean;
  lastOpenTime: number | null;
}

/** Convert a fresh TimeframeIndicator snapshot + last close into the Entry Brain's microstructure. Pure. */
export function microstructureFromIndicators(
  ind: TimeframeIndicatorLike,
  side: "LONG" | "SHORT",
  lastClose: number | null,
  volumeConfirmThreshold = 1.2,
): EntryMicrostructure {
  const atr = finite(ind.atr) && ind.atr! > 0 ? ind.atr! : null;
  const distAtr = atr !== null && finite(ind.vwap) && finite(lastClose) ? (lastClose! - ind.vwap!) / atr : null;
  return {
    distanceFromVwapAtr: distAtr,
    candleExtensionAtr: distAtr === null ? null : Math.abs(distAtr),
    breakoutConfirmed: side === "LONG" ? ind.breakoutHigh : ind.breakoutLow,
    volumeConfirmed: finite(ind.volumeRatio) ? ind.volumeRatio! >= volumeConfirmThreshold : null,
    candleFresh: ind.isFresh === true,
    observedAtMs: finite(ind.lastOpenTime) ? ind.lastOpenTime : null,
  };
}

/** DI for the runtime candle→microstructure accessor. The candle provider MUST be synchronous (the gather
 *  runs synchronously inside the tick; async candle fetches must be pre-warmed by the wiring, never issued
 *  inside a tick). No Binance import here — the boundary test forbids it. */
export interface EntryMicrostructureAccessorDeps {
  /** Sync candle read from an already-populated cache. null/throw ⇒ micro MISSING (never fabricated). */
  candlesFor: (symbol: string) => Candle[] | null;
  timeframe?: "5m" | "15m" | "1h";
  /** The tick's as-of clock — drives candle-freshness deterministically (no Date.now in the pure path). */
  nowMs: number;
  volumeConfirmThreshold?: number;
}

/**
 * Build the impure entryMicrostructure accessor from a sync candle provider. For each symbol it runs the
 * shared calculateTimeframeIndicators (VWAP / breakout / volume / ATR) and derives the Entry Brain
 * microstructure. `candleFresh` is enforced against the SAME candle TTL the gather uses
 * (FRESHNESS_TTL_MS.candle) + a causal check — a future or older-than-TTL candle ⇒ candleFresh=false, so
 * the Entry Brain cannot ENTER_NOW on stale candle data. Order-book depth is NOT candle-derived and stays
 * MISSING upstream. Returns null when candles are absent / too few / malformed (⇒ micro MISSING).
 */
export function makeEntryMicrostructureAccessor(
  deps: EntryMicrostructureAccessorDeps,
): (symbol: string, side: "LONG" | "SHORT") => EntryMicrostructure | null {
  const tf = deps.timeframe ?? "15m";
  const candleTtlMs = FRESHNESS_TTL_MS.candle;
  return (symbol, side) => {
    let candles: Candle[] | null = null;
    try {
      candles = deps.candlesFor(symbol);
    } catch {
      return null; // provider failure ⇒ MISSING, never fabricated
    }
    if (!candles || candles.length < 30) return null; // shared indicators require ≥30 candles
    let snap: ReturnType<typeof calculateTimeframeIndicators>;
    try {
      snap = calculateTimeframeIndicators(candles, tf, deps.nowMs);
    } catch {
      return null;
    }
    const last = candles[candles.length - 1];
    const openTime = finite(snap.lastOpenTime) ? snap.lastOpenTime : null;
    // candleFresh = the STRICTER of two budgets so a stale bar can NEVER ENTER_NOW:
    //   (a) causal + within the four-brain candle TTL ceiling (FRESHNESS_TTL_MS.candle, ~1h-bar budget), AND
    //   (b) the shared indicator's OWN timeframe-aware grace (snap.isFresh = timeframeMs(tf)×3 — e.g. 45min
    //       for 15m). The fixed ceiling alone would treat a 15m bar up to 90min (6 bars) old as fresh; ANDing
    //       the timeframe-aware grace keeps it tight per the operator's stale-candle requirement.
    const causalWithinTtl = openTime !== null && openTime <= deps.nowMs + 60_000 && deps.nowMs - openTime <= candleTtlMs;
    const candleFresh = causalWithinTtl && snap.isFresh === true;
    const ms = microstructureFromIndicators(
      {
        vwap: snap.vwap,
        distanceFromVwap: snap.distanceFromVwap,
        volumeRatio: snap.volumeRatio,
        breakoutHigh: snap.breakoutHigh,
        breakoutLow: snap.breakoutLow,
        atr: snap.atr14,
        isFresh: candleFresh,
        lastOpenTime: openTime,
      },
      side,
      last ? last.close : null,
      deps.volumeConfirmThreshold,
    );
    return ms;
  };
}

export interface FourBrainBindingDeps {
  instanceId: string;
  nowMs: number;
  horizons?: DirectionHorizon[];

  // ── Market State (normalized values + observed timestamps) ──
  axisScore: number | null; // −1..1
  axisAtMs: number | null;
  axisSlopePerHour: number | null; // score/hr → momentum proxy
  btcAtrPercentile: number | null; // 0..100
  atrAtMs: number | null;
  advancersPct: number | null; // 0..1
  breadthAtMs: number | null;
  sentiment: number | null; // −1..1 or null
  sentimentAtMs: number | null;
  safetyEvents: MarketSafetyEvent[];
  marketValidityMs?: number;

  // ── Direction (regime-level) ──
  regimeRaw: string | null;
  edgeMemory: EdgeMemoryLike;
  controllerBias: "LONG" | "SHORT" | "NEUTRAL" | "MIXED" | "UNKNOWN";
  convictionScore: number | null; // 0..1
  allowsLong: boolean;
  allowsShort: boolean;
  bestLaneReportForDirection(direction: "LONG" | "SHORT"): LaneReportLike | null;
  crowdAlignLong: number | null; // −1..1
  crowdAtMs: number | null;
  kronosAgree: number | null; // −1..1 or null (~55% MISSING)
  kronosAtMs: number | null;

  // ── Entry candidates (open signals) ──
  openSignals: Array<{ laneId: string; symbol: string; direction: "LONG" | "SHORT"; observationId: string; openedAtMs: number; entryPrice: number; stopPrice: number }>;
  maxSignalAgeMs: number;
  crowdingStateForSymbol?: (symbol: string) => "BUILDING" | "EXHAUSTING" | "UNWINDING" | "NEUTRAL" | null;
  /** Candle-microstructure (adapter B). null ⇒ no candle data for the symbol (micro stays MISSING). */
  entryMicrostructure?: (symbol: string, side: "LONG" | "SHORT") => EntryMicrostructure | null;

  // ── Exit candidates (open positions) ──
  openPositions: Array<{ paperOrderId: string; laneId: string; symbol: string; direction: "LONG" | "SHORT"; entryPrice: number; stopPrice: number; mfeR: number | null; maeR: number | null; createdAtMs: number }>;
  markPriceForSymbol: (symbol: string) => { price: number | null; atMs: number | null };
  maxHoldMsForLane?: (laneId: string) => number | null;

  // ── Executive / incumbent ──
  cortexDecisionId: string | null;
  cortexFinalPctForLane: (laneId: string) => number | null;
  laneEligibleIncumbent: (laneId: string) => boolean;
  killLatched: boolean;
  killReason: string | null;
}

const missing = (sourceId: string, unit: string, freshnessClass: RawReadingInput["freshnessClass"], reason: string): RawReadingInput => ({
  sourceId, raw: null, normalized: null, unit, observedAtMs: null, freshnessClass, missingReason: reason,
});
// `rawOverride` preserves the AS-READ source value when the normalized value is unit-converted (so the
// audit `raw` column can be checked against the conversion — Phase-2 review fix). Defaults to normalized.
const reading = (sourceId: string, normalized: number | null, unit: string, observedAtMs: number | null, freshnessClass: RawReadingInput["freshnessClass"], reason?: string, rawOverride?: number | null): RawReadingInput => ({
  sourceId, raw: rawOverride !== undefined ? rawOverride : normalized, normalized, unit, observedAtMs, freshnessClass, missingReason: normalized == null ? (reason ?? "absent") : null,
});
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Edge-memory avgNetR (R), mapping the n===0 emptyStat fabricated-0 to null (no proven edge ≠ zero edge). */
function edgeR(dep: FourBrainBindingDeps, direction: "LONG" | "SHORT"): number | null {
  const s = dep.edgeMemory.lookup(dep.regimeRaw, direction);
  return s.n > 0 && finite(s.avgNetR) ? s.avgNetR : null;
}

/** riskDistance-normalized unrealized R for an open position (LONG: up = profit). null when data insufficient. */
export function unrealizedRFromPosition(side: "LONG" | "SHORT", entry: number | null, mark: number | null, stop: number | null): number | null {
  if (!finite(entry) || !finite(mark) || !finite(stop)) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return ((side === "LONG" ? mark - entry : entry - mark) / risk);
}

/** Build the pure assembler's input from the live deps. Deterministic in deps. */
export function buildFourBrainGatherInput(dep: FourBrainBindingDeps): FourBrainGatherInput {
  const nowMs = dep.nowMs;
  const horizons = dep.horizons ?? (["INTRADAY", "SWING"] as DirectionHorizon[]);
  const validityMs = dep.marketValidityMs ?? 15 * 60_000;

  // ── Market State readings ──
  const marketState = {
    trend: reading("regime-axis-score", finite(dep.axisScore) ? dep.axisScore : null, "-1..1", dep.axisAtMs, "regime"),
    volatility: reading("btc-atr-percentile", finite(dep.btcAtrPercentile) ? dep.btcAtrPercentile / 100 : null, "0..1", dep.atrAtMs, "candle", "BTC ATR%ile proxy (no market-wide vol source)", finite(dep.btcAtrPercentile) ? dep.btcAtrPercentile : null),
    liquidity: missing("order-book-depth", "0..1", "orderflow", "no market liquidity/depth feed in repo (UNAVAILABLE)"),
    breadth: reading("breadth-advancers", finite(dep.advancersPct) ? dep.advancersPct * 2 - 1 : null, "-1..1", dep.breadthAtMs, "regime", undefined, finite(dep.advancersPct) ? dep.advancersPct : null),
    momentum: reading("regime-axis-slope", finite(dep.axisSlopePerHour) ? Math.max(-1, Math.min(1, dep.axisSlopePerHour / 0.05)) : null, "-1..1", dep.axisAtMs, "regime", undefined, finite(dep.axisSlopePerHour) ? dep.axisSlopePerHour : null),
    eventRisk: missing("event-risk", "0..1", "sentiment", "no live event-risk producer (cortex-enrichment UNAVAILABLE)"),
    sentiment: reading("sentiment", finite(dep.sentiment) ? dep.sentiment : null, "-1..1", dep.sentimentAtMs, "sentiment", "sentiment thin/STALE_PRONE"),
    safetyEvents: dep.safetyEvents,
    validityMs,
  };

  // ── Direction readings per horizon (regime-level, same for each horizon in v1) ──
  const longEdge = edgeR(dep, "LONG");
  const shortEdge = edgeR(dep, "SHORT");
  const longVeto = deriveDirectionVeto({ direction: "LONG" as CortexLaneDirection, edgeMemory: dep.edgeMemory, regimeRaw: dep.regimeRaw });
  const shortVeto = deriveDirectionVeto({ direction: "SHORT" as CortexLaneDirection, edgeMemory: dep.edgeMemory, regimeRaw: dep.regimeRaw });
  const longLane = dep.bestLaneReportForDirection("LONG");
  const shortLane = dep.bestLaneReportForDirection("SHORT");
  // Four-brain's OWN self-referential edge memory (four-brain-edge-memory.ts) — a SECOND, independent
  // proven-negative signal from the incumbent's longVeto/shortVeto above, derived from the Direction
  // Brain's OWN resolved LONG/SHORT outcomes (direction-entry-outcome-store.ts). Horizon-scoped (unlike
  // longVeto/shortVeto, which are regime-level only), so it is computed per-horizon inside the map below.
  const fbEdge = getFourBrainEdgeMemory();
  const directions = horizons.map((horizon) => {
    const fourBrainLongVeto = fourBrainEdgeVerdict(fbEdge, dep.regimeRaw, "LONG", horizon).verdict === "VETO_NEGATIVE";
    const fourBrainShortVeto = fourBrainEdgeVerdict(fbEdge, dep.regimeRaw, "SHORT", horizon).verdict === "VETO_NEGATIVE";
    return {
      horizon,
      marketBias: "NEUTRAL" as const, // placeholder — the tick overrides from the Market State Brain
      transitionRisk: 0,
      longEdge: reading("edge-memory-long", longEdge, "R", dep.axisAtMs, "regime", "n=0 (no proven edge)"),
      shortEdge: reading("edge-memory-short", shortEdge, "R", dep.axisAtMs, "regime", "n=0 (no proven edge)"),
      conviction: reading("controller-conviction", finite(dep.convictionScore) ? dep.convictionScore : null, "0..1", dep.axisAtMs, "regime"),
      longLaneEdge: reading("lane-report-long", longLane && longLane.resolvedCount > 0 ? longLane.netAvgR : null, "R", dep.axisAtMs, "regime", "no resolved long-lane closes"),
      shortLaneEdge: reading("lane-report-short", shortLane && shortLane.resolvedCount > 0 ? shortLane.netAvgR : null, "R", dep.axisAtMs, "regime", "no resolved short-lane closes"),
      kronosAgree: reading("kronos-agree", finite(dep.kronosAgree) ? dep.kronosAgree : null, "-1..1", dep.kronosAtMs, "derivatives", "kronos ~55% MISSING"),
      crowdingAlignLong: reading("crowding-align-long", finite(dep.crowdAlignLong) ? dep.crowdAlignLong : null, "-1..1", dep.crowdAtMs, "derivatives"),
      controllerBias: dep.controllerBias,
      leansLong: dep.allowsLong,
      leansShort: dep.allowsShort,
      longVeto,
      shortVeto,
      fourBrainLongVeto,
      fourBrainShortVeto,
      validityMs,
    };
  });

  const riskBlockedReason = (laneId: string, direction: "LONG" | "SHORT"): string | null => {
    if (dep.killLatched) return dep.killReason ?? "kill switch latched";
    const veto = direction === "LONG" ? longVeto : shortVeto;
    if (veto) return "edge-memory VETO (incumbent edgeVeto)";
    return null;
  };

  // ── Entry candidates (from open signals) ──
  const entryCandidatesRaw: EntryCandidateRaw[] = dep.openSignals.map((s) => {
    const identity: FourBrainIdentity = {
      instanceId: dep.instanceId, laneId: s.laneId, symbolOrBasketId: s.symbol, side: s.direction,
      signalId: s.observationId, positionId: null, horizon: laneHorizon(s.laneId), decisionAtMs: nowMs,
    };
    const exec: ExecContext = {
      cortexDecisionId: dep.cortexDecisionId,
      cortexAllocationPct: dep.cortexFinalPctForLane(s.laneId),
      laneEligibleIncumbent: dep.laneEligibleIncumbent(s.laneId),
      killLatched: dep.killLatched,
      riskBlockedReason: riskBlockedReason(s.laneId, s.direction),
    };
    // Adapter B: candle-derived microstructure (VWAP distance, extension, breakout, volume, candle freshness).
    // null ⇒ no candle adapter wired for this symbol ⇒ micro stays MISSING (never fabricated). Order-book
    // depth (spread/slippage) is NOT candle-derived and always stays MISSING here.
    const ms = dep.entryMicrostructure?.(s.symbol, s.direction) ?? null;
    const microObsAt = ms && finite(ms.observedAtMs) ? ms.observedAtMs : null;
    return {
      identity, side: s.direction,
      signalAgeMs: finite(s.openedAtMs) ? nowMs - s.openedAtMs : null,
      maxSignalAgeMs: dep.maxSignalAgeMs,
      price: finite(s.entryPrice) ? s.entryPrice : null,
      targetEntry: finite(s.entryPrice) ? s.entryPrice : null,
      invalidationPrice: finite(s.stopPrice) ? s.stopPrice : null,
      initialStopPrice: finite(s.stopPrice) ? s.stopPrice : null,
      atr: null,
      micro: {
        // VWAP distance + extension come from the candle adapter (freshnessClass "candle" ⇒ the gather
        // applies the candle TTL; a stale candle snapshot audits STALE). Order-book depth (spread/slippage)
        // has NO source in-repo ⇒ stays MISSING — never fabricated as deep liquidity / zero slippage.
        distanceFromVwapAtr: ms && ms.distanceFromVwapAtr != null
          ? reading("vwap-distance", ms.distanceFromVwapAtr, "atr", microObsAt, "candle")
          : missing("vwap-distance", "atr", "candle", ms ? "vwap/atr absent in candle snapshot" : "no candle adapter"),
        candleExtensionAtr: ms && ms.candleExtensionAtr != null
          ? reading("candle-extension", ms.candleExtensionAtr, "atr", microObsAt, "candle")
          : missing("candle-extension", "atr", "candle", ms ? "extension absent in candle snapshot" : "no candle adapter"),
        pullbackDepthAtr: missing("pullback-depth", "atr", "candle", "pullback depth not derived from candle snapshot"),
        spreadBps: missing("spread-bps", "bps", "orderflow", "order-book depth unavailable (MISSING)"),
        expectedSlippageBps: missing("expected-slippage-bps", "bps", "orderflow", "order-book depth unavailable (MISSING)"),
      },
      breakoutConfirmed: ms ? ms.breakoutConfirmed : null,
      volumeConfirmed: ms ? ms.volumeConfirmed : null,
      candleFresh: ms ? ms.candleFresh : null,
      crowdingState: dep.crowdingStateForSymbol?.(s.symbol) ?? null,
      expectedDirectionalR: s.direction === "LONG" ? longEdge : shortEdge,
      validityMs,
      exec,
    };
  });

  // ── Exit candidates (from open positions) ──
  const exitCandidatesRaw: ExitCandidateRaw[] = dep.openPositions.map((p) => {
    const mark = dep.markPriceForSymbol(p.symbol);
    // A position mark must be nearly real-time (FRESHNESS_TTL_MS.position). A STALE or FUTURE mark is
    // UNUSABLE (currentPrice → null) so it never flows into unrealizedR / hardExit as if fresh (Phase-2
    // review fix). killLatched is always a current fact and still drives hardExit on its own.
    const markFresh = finite(mark.atMs) && (mark.atMs as number) <= nowMs + 60_000 && nowMs - (mark.atMs as number) <= FRESHNESS_TTL_MS.position;
    const usableMark = markFresh && finite(mark.price) ? mark.price : null;
    const unrealizedR = unrealizedRFromPosition(p.direction, p.entryPrice, usableMark, p.stopPrice);
    const hardExit =
      dep.killLatched ||
      (finite(usableMark) && finite(p.stopPrice) && (p.direction === "LONG" ? usableMark <= p.stopPrice : usableMark >= p.stopPrice));
    const identity: FourBrainIdentity = {
      instanceId: dep.instanceId, laneId: p.laneId, symbolOrBasketId: p.symbol, side: p.direction,
      signalId: null, positionId: p.paperOrderId, horizon: laneHorizon(p.laneId), decisionAtMs: nowMs,
    };
    const exec: ExecContext = {
      cortexDecisionId: dep.cortexDecisionId,
      cortexAllocationPct: dep.cortexFinalPctForLane(p.laneId),
      laneEligibleIncumbent: dep.laneEligibleIncumbent(p.laneId),
      killLatched: dep.killLatched,
      riskBlockedReason: dep.killLatched ? dep.killReason ?? "kill switch latched" : null,
      hardExitTriggered: hardExit,
    };
    return {
      identity, side: p.direction,
      entryPrice: finite(p.entryPrice) ? p.entryPrice : null,
      currentPrice: usableMark, // freshness-gated: a stale/future mark is null (never used as fresh)
      currentAtMs: markFresh ? mark.atMs : null,
      unrealizedR,
      mfeR: finite(p.mfeR) ? p.mfeR : null,
      maeR: finite(p.maeR) ? p.maeR : null,
      timeInTradeMs: finite(p.createdAtMs) ? nowMs - p.createdAtMs : null,
      maxHoldMs: dep.maxHoldMsForLane?.(p.laneId) ?? null,
      hardStopPrice: finite(p.stopPrice) ? p.stopPrice : null,
      killLatched: dep.killLatched,
      decay: {
        // No live decay/reversal signal producer yet — the Exit Brain is null-safe; emit undefined (MISSING).
        thesisIntact: null,
      },
      validityMs,
      exec,
    };
  });

  return {
    instanceId: dep.instanceId,
    nowMs,
    supportedLanes: FOUR_BRAIN_SUPPORTED_LANES,
    marketState,
    directions,
    entryCandidatesRaw,
    exitCandidatesRaw,
  };
}

/** The default serving port this codebase's OWN server.ts falls back to when PORT is unset
 *  (`const port = Number(process.env.PORT ?? 3101)` in apps/api/src/server.ts). Kept in lockstep here so a
 *  missing PORT env var can NEVER again silently resolve to an unrecognized id (e.g. "unknown") that isn't
 *  in FOUR_BRAIN_DEFAULT_INSTANCE_ALLOWLIST — that exact fragility once fail-closed EVERY instance-scoped
 *  four-brain feature (collection, shadow tick, lane-context journal) on the main/research instance for its
 *  entire lifetime, discovered only because the operator noticed collection was silently disabled. */
export const FOUR_BRAIN_DEFAULT_PORT = "3101";

/** Resolve a stable instance id from the runtime (PORT distinguishes 3101/3102/3103; journal paths keyed by
 *  it). Falls back to FOUR_BRAIN_DEFAULT_PORT — NEVER "unknown" — when PORT is unset, so this always agrees
 *  with the port server.ts will actually bind to. */
export function resolveFourBrainInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.FOUR_BRAIN_INSTANCE_ID ?? env.PORT ?? FOUR_BRAIN_DEFAULT_PORT).toString();
}

/** Instances the shadow tick may EVER run on. Default 3101 (research) + 3102 (testnet) ONLY — the live
 *  instance (3103) is never in the default set. An operator can narrow it via FOUR_BRAIN_INSTANCE_ALLOWLIST
 *  but the wiring must additionally hard-exclude 3103 so a stray env can never enable it on live. */
export const FOUR_BRAIN_DEFAULT_INSTANCE_ALLOWLIST: readonly string[] = ["3101", "3102"];

/** The serving port that identifies the LIVE money instance — hard-blocked no matter what. */
export const FOUR_BRAIN_LIVE_INSTANCE_PORT = "3103";

/** True only if this instance is BOTH in the allowlist AND not the hard-blocked live instance (3103). The
 *  live block keys off BOTH the resolved id AND the raw serving PORT, so a stray FOUR_BRAIN_INSTANCE_ID that
 *  relabels the live box can never smuggle the tick onto real-money 3103. */
export function fourBrainInstanceAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  // Belt-and-suspenders: block if EITHER the resolved id OR the actual serving port is the live instance.
  if (resolveFourBrainInstanceId(env) === FOUR_BRAIN_LIVE_INSTANCE_PORT) return false;
  if ((env.PORT ?? "").toString().trim() === FOUR_BRAIN_LIVE_INSTANCE_PORT) return false;
  const id = resolveFourBrainInstanceId(env);
  const raw = (env.FOUR_BRAIN_INSTANCE_ALLOWLIST ?? FOUR_BRAIN_DEFAULT_INSTANCE_ALLOWLIST.join(",")).trim();
  const allow = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return allow.has(id);
}

/** True only when the four-brain shadow cycle is actually configured to run on THIS instance — BOTH
 *  FOUR_BRAIN_MODE==="shadow" AND fourBrainInstanceAllowed(env). This is the exact composed gate app.ts
 *  uses to arm the shadow-tick interval ("Arm the interval ONLY where the tick could actually run").
 *  Anything that wants to answer "is four-brain live on this box" — in particular the operator dashboard's
 *  /api/shadow/four-brain `enabled` field — must key off THIS, not merely "did this process construct the
 *  metrics aggregator": app.ts's four-brain wiring block runs on every non-test process regardless of mode,
 *  so a metrics/ring-buffer object always gets constructed there even when shadow mode is off. Without this
 *  helper gating what gets exposed to the route, a mode-off instance would report enabled:true with an
 *  honestly-all-zero (never fabricated) but semantically-misleading health object — indistinguishable from
 *  "shadow mode is on and simply hasn't completed a tick yet". */
export function fourBrainShadowActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return fourBrainMode(env) === "shadow" && fourBrainInstanceAllowed(env);
}
