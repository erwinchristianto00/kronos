/**
 * Pure, deterministic fixtures for the four-brain tests. A single fixed NOW (no Date.now) so every fixture
 * replays byte-identically. Builders default to a "clean, all-fresh" input; tests override only the field
 * under test.
 */
import type { TaggedSource } from "../src/lib/four-brain-types.js";
import type { MarketStateInput } from "../src/lib/market-state-brain.js";
import type { DirectionInput } from "../src/lib/direction-brain.js";
import type { EntryInput } from "../src/lib/entry-brain.js";
import type { ExitInput } from "../src/lib/exit-brain.js";

export const NOW = 1_800_000_000_000;
export const MIN = 60_000;

/** A freshness-tagged source `ageMs` old (default fresh = now). */
export function src(value: number | null, ageMs = 0): TaggedSource {
  return { value, asOfMs: NOW - ageMs };
}
/** A source with NO timestamp (static/config — always current). */
export function staticSrc(value: number | null): TaggedSource {
  return { value, asOfMs: null };
}

export function marketInput(o: Partial<MarketStateInput> = {}): MarketStateInput {
  return {
    nowMs: NOW,
    validityMs: 15 * MIN,
    trend: src(0.5),
    volatility: src(0.4),
    liquidity: src(0.7),
    breadth: src(0.3),
    momentum: src(0.4),
    eventRisk: src(0.1),
    sentiment: src(0.2),
    safetyEvents: [],
    ...o,
  };
}

export function directionInput(o: Partial<DirectionInput> = {}): DirectionInput {
  return {
    nowMs: NOW,
    validityMs: 15 * MIN,
    horizon: "INTRADAY",
    marketBias: "NEUTRAL",
    transitionRisk: 0.2,
    longEdge: src(0.08),
    shortEdge: src(null),
    conviction: src(0.7),
    controllerBias: "LONG",
    leansLong: true,
    leansShort: true,
    longLaneEdge: src(0.06),
    shortLaneEdge: src(null),
    kronosAgree: src(0.3),
    crowdingAlignLong: src(0.2),
    ...o,
  };
}

export function entryInput(o: Partial<EntryInput> = {}): EntryInput {
  return {
    nowMs: NOW,
    validityMs: 15 * MIN,
    side: "LONG",
    signalAgeMs: 5 * MIN,
    maxSignalAgeMs: 50 * MIN,
    price: 100,
    targetEntry: 100,
    invalidationPrice: 96,
    initialStopPrice: 97,
    atr: 2,
    distanceFromVwapAtr: src(0.5),
    candleExtensionAtr: src(0.8),
    pullbackDepthAtr: src(0.2),
    breakoutConfirmed: true,
    volumeConfirmed: true,
    spreadBps: src(2),
    expectedSlippageBps: src(4),
    bookDepthOk: true,
    crowdingState: "NEUTRAL",
    expectedDirectionalR: 0.1,
    ...o,
  };
}

export function exitInput(o: Partial<ExitInput> = {}): ExitInput {
  return {
    nowMs: NOW,
    validityMs: 15 * MIN,
    side: "LONG",
    entryPrice: 100,
    currentPrice: 103,
    unrealizedR: 1.2,
    mfeR: 1.5,
    maeR: -0.3,
    timeInTradeMs: 30 * MIN,
    maxHoldMs: 48 * 60 * MIN,
    hardStopPrice: 97,
    killLatched: false,
    momentumDecay: false,
    volumeExhaustion: false,
    divergence: false,
    failedNewExtreme: false,
    structureBreak: false,
    orderFlowReversal: false,
    liquidityTargetReached: false,
    volTransition: false,
    regimeTransition: false,
    eventDecay: false,
    thesisIntact: true,
    ...o,
  };
}
