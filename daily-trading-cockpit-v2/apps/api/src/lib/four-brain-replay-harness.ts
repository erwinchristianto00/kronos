/**
 * Four-Brain REPLAY harness (operator ask C). A deterministic, in-memory, NO-execution-authority path for
 * SEMANTIC validation of the Entry/Exit brains — needed because the live testnet kill is latched (so every
 * live candidate is correctly BLOCKED_BY_RISK and there are zero open positions, meaning the live shadow can
 * never exercise a not-blocked Entry or a real Exit). This harness feeds hand-built pre-latch-like snapshots
 * through the SAME pure gather + brains and RETURNS the decisions. It journals to a local array only — it
 * imports no executor and calls no order/allocation/kill mutation. Output must be labelled REPLAY and kept
 * separate from observed live testnet shadow output.
 */
import { assembleFourBrainTick } from "./four-brain-live-gather.js";
import { buildFourBrainGatherInput, type FourBrainBindingDeps, type EntryMicrostructure } from "./four-brain-live-gather-bindings.js";
import { runFourBrainShadowTick, _resetFourBrainSingleFlightForTests } from "./four-brain-shadow-tick.js";
import type { ExecutiveDecision } from "./four-brain-types.js";

const REPLAY_NOW = 1_800_000_000_000;
const MIN = 60_000;

const allowingEdge = {
  lookup: (_r: string | null, d: "LONG" | "SHORT") => (d === "LONG" ? { avgNetR: 0.12, n: 140 } : { avgNetR: 0, n: 0 }),
  verdict: () => ({ decision: "ALLOW_PROVEN" }),
  hasPositiveLane: () => true,
};

const freshMicro: EntryMicrostructure = {
  distanceFromVwapAtr: 0.4, candleExtensionAtr: 0.4, breakoutConfirmed: true, volumeConfirmed: true, candleFresh: true, observedAtMs: REPLAY_NOW - MIN,
};

/** Base deps for a clean, PROVABLE-edge LONG signal in a bullish regime — kill NOT latched. */
function baseDeps(o: Partial<FourBrainBindingDeps> = {}): FourBrainBindingDeps {
  return {
    instanceId: "replay",
    nowMs: REPLAY_NOW,
    axisScore: 0.55, axisAtMs: REPLAY_NOW - 2 * MIN, axisSlopePerHour: 0.02,
    btcAtrPercentile: 40, atrAtMs: REPLAY_NOW - 8 * MIN,
    advancersPct: 0.68, breadthAtMs: REPLAY_NOW - 2 * MIN,
    sentiment: null, sentimentAtMs: null,
    safetyEvents: [],
    regimeRaw: "Bullish expansion",
    edgeMemory: allowingEdge,
    // 2026-07-26: these three timestamps used to be implicit — every Direction reading silently
    // inherited axisAtMs, so this fixture's "clean, PROVABLE-edge" claim rode on the axis clock and
    // was never actually stated. Once each reading carries its OWN clock, an unstamped fixture is
    // (correctly) untimed ⇒ STALE ⇒ no proven edge ⇒ no VALID candidate. Stating them explicitly is
    // what the fixture always meant; the values are recent-but-distinct so a future regression that
    // re-borrows one source's clock for another shows up as a wrong number, not a silent pass.
    edgeMemoryUpdatedAtMs: REPLAY_NOW - 5 * MIN,
    controllerCapturedAtMs: REPLAY_NOW - 2 * MIN,
    controllerBias: "LONG", convictionScore: 0.72, allowsLong: true, allowsShort: true,
    bestLaneReportForDirection: (d) =>
      d === "LONG" ? { netAvgR: 0.09, resolvedCount: 80, lastCycleAt: new Date(REPLAY_NOW - 4 * MIN).toISOString() } : null,
    crowdAlignLong: 0.2, crowdAtMs: REPLAY_NOW - 3 * MIN,
    kronosAgree: null, kronosAtMs: null,
    openSignals: [
      { laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", symbol: "BTCUSDT", direction: "LONG", observationId: "replay-sig-1", openedAtMs: REPLAY_NOW - 3 * MIN, entryPrice: 100, stopPrice: 97 },
    ],
    maxSignalAgeMs: 50 * MIN,
    crowdingStateForSymbol: () => "NEUTRAL",
    entryMicrostructure: () => freshMicro,
    openPositions: [],
    markPriceForSymbol: () => ({ price: 101, atMs: REPLAY_NOW - 30_000 }),
    cortexDecisionId: "REPLAY_DECISION:x",
    cortexFinalPctForLane: () => 40,
    laneEligibleIncumbent: () => true,
    killLatched: false,
    killReason: null,
    ...o,
  };
}

export interface ReplayResult {
  label: string;
  marketState: ReturnType<typeof runFourBrainShadowTick>["marketState"];
  executiveDecisions: ExecutiveDecision[];
  journaledCount: number;
}

/** Run one replay snapshot through the pure gather + brains. Journals to a LOCAL array (no execution). */
export function runFourBrainReplay(label: string, deps: FourBrainBindingDeps): ReplayResult {
  _resetFourBrainSingleFlightForTests(); // isolated: never contends with the live single-flight latch
  const journaled: Record<string, unknown>[] = [];
  const result = runFourBrainShadowTick({
    mode: "shadow",
    nowMs: deps.nowMs,
    gather: () => assembleFourBrainTick(buildFourBrainGatherInput(deps)),
    journalAppend: (r) => void journaled.push(r),
    tickId: `replay:${label}`,
  });
  return { label, marketState: result.marketState, executiveDecisions: result.executiveDecisions, journaledCount: journaled.length };
}

/** Scenario 1: kill NOT latched + a clean proven-edge signal ⇒ Entry is NOT risk-blocked (a VALID candidate). */
export function replayEntryNotBlocked(): ReplayResult {
  return runFourBrainReplay("entry-not-blocked", baseDeps());
}

/** Scenario 2: an open position with a fresh mark ⇒ an ExitDecision is produced. */
export function replayOpenPositionExit(): ReplayResult {
  return runFourBrainReplay("open-position-exit", baseDeps({
    openSignals: [],
    openPositions: [
      { paperOrderId: "replay-pos-1", laneId: "REGIME_COMPOSITE_CONFIRMATION_LONG", symbol: "ETHUSDT", direction: "LONG", entryPrice: 200, stopPrice: 194, mfeR: 1.4, maeR: -0.3, createdAtMs: REPLAY_NOW - 40 * MIN },
    ],
    markPriceForSymbol: () => ({ price: 209, atMs: REPLAY_NOW - 20_000 }),
  }));
}

/** Scenario 3: kill LATCHED ⇒ EVERY candidate is BLOCKED_BY_RISK (the live-latched invariant, reproduced). */
export function replayKillLatchedAllBlocked(): ReplayResult {
  return runFourBrainReplay("kill-latched-all-blocked", baseDeps({ killLatched: true, killReason: "daily loss kill latched" }));
}
