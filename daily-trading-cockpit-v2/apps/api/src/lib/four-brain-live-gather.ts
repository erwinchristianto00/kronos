/**
 * Four-Brain LIVE gather (Phase 2) — the PURE core of the impure adapter. It turns freshness-tagged
 * SOURCE READINGS (fetched by the bindings from verified live singletons) into the exact input structs the
 * four pure brains consume, and produces the audit trail the journal needs. It NEVER fetches, NEVER mutates,
 * NEVER touches an executor — the impure reads live in four-brain-live-gather-bindings.ts.
 *
 * The whole risk of Phase 2 is INTEGRATION, so this module makes the dangerous parts explicit + testable:
 *   • per-source raw + normalized + unit + observed/fetched timestamps + freshness status + missing reason
 *     + source id (never infer a missing value as 0);
 *   • SOURCE-SPECIFIC freshness limits (regime vs candle vs signal vs order-flow vs derivatives vs sentiment
 *     vs position) — not one global TTL — and a FUTURE timestamp is rejected (ERROR);
 *   • identity joins on STABLE ids (laneId, symbol/basketId, side, signalId, positionId, horizon, instanceId,
 *     decisionAtMs) — never display-name-only;
 *   • unknown lanes are surfaced (not silently dropped) and duplicate identities are REJECTED from the tick
 *     and recorded.
 */
import { classifySource, type DirectionHorizon, type MarketBias, type SourceStatus } from "./four-brain-types.js";
import type { MarketSafetyEvent, MarketStateInput } from "./market-state-brain.js";
import type { DirectionInput } from "./direction-brain.js";
import type { EntryInput } from "./entry-brain.js";
import type { ExitInput } from "./exit-brain.js";

/** Which freshness budget a source belongs to — each has its OWN TTL (never one global TTL). */
export type FreshnessClass = "regime" | "candle" | "signal" | "orderflow" | "derivatives" | "sentiment" | "position";

/** Source-specific staleness limits (ms). A candle can be an hour old and still fine; an order-book read
 *  goes stale in minutes; a position mark must be nearly real-time. */
export const FRESHNESS_TTL_MS: Record<FreshnessClass, number> = {
  regime: 30 * 60_000,
  candle: 90 * 60_000, // 1h-bar freshness budget
  signal: 50 * 60_000, // exec MAX_SIGNAL_AGE_MS
  orderflow: 5 * 60_000,
  derivatives: 10 * 60_000,
  sentiment: 60 * 60_000,
  position: 60_000,
};

/** One audited source reading. raw = as-read; normalized = value handed to the brain (unit-converted), null
 *  when not FRESH; never a fabricated 0. */
export interface SourceReading {
  sourceId: string;
  raw: number | string | boolean | null;
  normalized: number | null;
  unit: string; // "R" | "bps" | "fraction" | "0..1" | "-1..1" | "price" | "enum" | "ms" | "count"
  observedAtMs: number | null; // event/observed time (candle close, funding settle, snapshot at)
  fetchedAtMs: number | null; // wall-clock fetch time, when distinct from observed
  status: SourceStatus;
  missingReason: string | null;
  freshnessClass: FreshnessClass;
}

export interface RawReadingInput {
  sourceId: string;
  raw: number | string | boolean | null;
  /** The normalized numeric the brain wants (already unit-converted). null ⇒ genuinely absent. */
  normalized: number | null;
  unit: string;
  observedAtMs: number | null;
  fetchedAtMs?: number | null;
  freshnessClass: FreshnessClass;
  /** Explicit reason when raw/normalized is null (so a missing value is never mistaken for 0). */
  missingReason?: string | null;
}

/**
 * Classify + audit a reading. Applies the source-specific TTL + the shared causal contract (a FUTURE
 * observedAtMs ⇒ ERROR). Produces the SourceReading audit record; the normalized value is kept only when
 * FRESH (else null — never a stale/future/fabricated number reaches a brain).
 */
export function auditReading(r: RawReadingInput, nowMs: number): SourceReading {
  const ttl = FRESHNESS_TTL_MS[r.freshnessClass];
  const status = classifySource({ value: r.normalized, asOfMs: r.observedAtMs }, nowMs, ttl);
  const missingReason =
    status === "MISSING"
      ? r.missingReason ?? "absent"
      : status === "STALE"
        ? `stale (> ${Math.round(ttl / 60_000)}min)`
        : status === "ERROR"
          ? "non-finite or future timestamp"
          : null;
  return {
    sourceId: r.sourceId,
    raw: r.raw,
    normalized: status === "FRESH" ? r.normalized : null,
    unit: r.unit,
    observedAtMs: r.observedAtMs,
    fetchedAtMs: r.fetchedAtMs ?? null,
    status,
    missingReason,
    freshnessClass: r.freshnessClass,
  };
}

/** Turn an audited reading into the brain's TaggedSource (value + asOfMs). Only a FRESH numeric survives;
 *  the brain's own classifySource re-checks it (defense in depth), so a stale/future value stays neutral. */
export function toTagged(reading: SourceReading): { value: number | null; asOfMs: number | null } {
  return { value: reading.status === "FRESH" ? reading.normalized : null, asOfMs: reading.observedAtMs };
}

/** Stable identity for a candidate/position — NEVER display-name-only. */
export interface FourBrainIdentity {
  instanceId: string;
  laneId: string;
  symbolOrBasketId: string;
  side: "LONG" | "SHORT" | "NEUTRAL" | null;
  signalId: string | null;
  positionId: string | null;
  horizon: string | null;
  decisionAtMs: number;
}

/** A canonical key for duplicate detection. Two candidates with the SAME (laneId, symbol, side, signalId|
 *  positionId) collide — the tick rejects both and records it (a real double-count/join bug otherwise). */
export function identityKey(id: Pick<FourBrainIdentity, "laneId" | "symbolOrBasketId" | "side" | "signalId" | "positionId">): string {
  return [id.laneId, id.symbolOrBasketId, id.side ?? "-", id.signalId ?? id.positionId ?? "-"].join("::");
}

export interface DedupeResult<T> {
  kept: T[];
  duplicateKeys: string[];
}

/**
 * Reject duplicate identities from a candidate set (keep NONE of a colliding group — a duplicate identity
 * means a join/enumeration bug, so it is unsafe to pick one arbitrarily) and record the colliding keys.
 * The MAIN cycle stays fail-open; only the affected candidates are dropped from THIS shadow tick.
 */
export function rejectDuplicates<T>(items: T[], keyOf: (t: T) => string): DedupeResult<T> {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(keyOf(it), (counts.get(keyOf(it)) ?? 0) + 1);
  const duplicateKeys = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  const dupSet = new Set(duplicateKeys);
  return { kept: items.filter((it) => !dupSet.has(keyOf(it))), duplicateKeys };
}

/** How a lane resolves against the supported roster. Unknown lanes are SURFACED, never silently dropped. */
export interface LaneClassification {
  laneId: string;
  supported: boolean;
}

/** Split lanes into supported vs unknown against a roster (fail-loud on unknowns in the gather result). */
export function classifyLanes(laneIds: string[], supported: ReadonlySet<string>): { supportedLanes: string[]; unknownLanes: string[] } {
  const supportedLanes: string[] = [];
  const unknownLanes: string[] = [];
  for (const l of laneIds) (supported.has(l) ? supportedLanes : unknownLanes).push(l);
  return { supportedLanes, unknownLanes };
}

/** Per-freshness-class fresh/stale/missing tally, for the metrics + journal. */
export function freshnessTally(readings: SourceReading[]): Record<string, { fresh: number; stale: number; missing: number; error: number }> {
  const out: Record<string, { fresh: number; stale: number; missing: number; error: number }> = {};
  for (const r of readings) {
    const b = (out[r.freshnessClass] ??= { fresh: 0, stale: 0, missing: 0, error: 0 });
    if (r.status === "FRESH") b.fresh += 1;
    else if (r.status === "STALE") b.stale += 1;
    else if (r.status === "ERROR") b.error += 1;
    else b.missing += 1;
  }
  return out;
}

// ── Assembly: raw readings (from the impure bindings) → the four pure brains' input structs ────────

/** Incumbent context for a candidate — the SAME semantics the live executor uses (parity-tested). */
export interface ExecContext {
  cortexDecisionId: string | null;
  cortexAllocationPct: number | null; // decideCortex finalPct 0..100; 0 = unfunded, null = unknown
  laneEligibleIncumbent: boolean;
  directionHurdlePassed?: boolean;
  killLatched: boolean;
  riskBlockedReason: string | null; // edge veto / concentration / daily-loss — incumbent rail block
  hardExitTriggered?: boolean;
}

export interface MarketStateRawReadings {
  trend: RawReadingInput;
  volatility: RawReadingInput;
  liquidity: RawReadingInput;
  breadth: RawReadingInput;
  momentum: RawReadingInput;
  eventRisk: RawReadingInput;
  sentiment: RawReadingInput;
  safetyEvents: MarketSafetyEvent[];
  validityMs: number;
}

export interface DirectionRawReadings {
  horizon: DirectionHorizon;
  marketBias: MarketBias;
  transitionRisk: number;
  longEdge: RawReadingInput;
  shortEdge: RawReadingInput;
  /** Sample counts behind longEdge/shortEdge — lets the brain separate "unmeasured" from "proven bad". */
  longEdgeN?: number | null;
  shortEdgeN?: number | null;
  conviction: RawReadingInput;
  longLaneEdge: RawReadingInput;
  shortLaneEdge: RawReadingInput;
  kronosAgree: RawReadingInput;
  crowdingAlignLong: RawReadingInput;
  controllerBias?: "LONG" | "SHORT" | "NEUTRAL" | "MIXED" | "UNKNOWN";
  leansLong?: boolean;
  leansShort?: boolean;
  longVeto?: boolean;
  shortVeto?: boolean;
  /** Four-brain's OWN self-referential edge-memory veto (four-brain-edge-memory.ts) — a SECOND,
   *  independent soft penalty from longVeto/shortVeto (the incumbent engine's edge-memory). Passed
   *  straight through to DirectionInput; see direction-brain.ts. */
  fourBrainLongVeto?: boolean;
  fourBrainShortVeto?: boolean;
  validityMs: number;
}

export interface EntryCandidateRaw {
  identity: FourBrainIdentity;
  side: "LONG" | "SHORT";
  signalAgeMs: number | null;
  maxSignalAgeMs: number;
  price: number | null;
  targetEntry: number | null;
  invalidationPrice: number | null;
  initialStopPrice: number | null;
  atr: number | null;
  micro: {
    distanceFromVwapAtr: RawReadingInput;
    candleExtensionAtr: RawReadingInput;
    pullbackDepthAtr: RawReadingInput;
    spreadBps: RawReadingInput;
    expectedSlippageBps: RawReadingInput;
  };
  breakoutConfirmed: boolean | null;
  volumeConfirmed: boolean | null;
  /** Candle-data freshness (adapter B). false ⇒ Entry Brain must not ENTER_NOW. null ⇒ no candle adapter. */
  candleFresh?: boolean | null;
  crowdingState: "BUILDING" | "EXHAUSTING" | "UNWINDING" | "NEUTRAL" | null;
  expectedDirectionalR: number | null;
  validityMs: number;
  exec: ExecContext;
}

export interface ExitCandidateRaw {
  identity: FourBrainIdentity;
  side: "LONG" | "SHORT";
  entryPrice: number | null;
  currentPrice: number | null;
  currentAtMs: number | null;
  unrealizedR: number | null;
  mfeR: number | null;
  maeR: number | null;
  timeInTradeMs: number | null;
  maxHoldMs: number | null;
  hardStopPrice: number | null;
  killLatched: boolean;
  decay: {
    momentumDecay?: boolean | null;
    volumeExhaustion?: boolean | null;
    divergence?: boolean | null;
    failedNewExtreme?: boolean | null;
    structureBreak?: boolean | null;
    orderFlowReversal?: boolean | null;
    liquidityTargetReached?: boolean | null;
    volTransition?: boolean | null;
    regimeTransition?: boolean | null;
    eventDecay?: boolean | null;
    thesisIntact?: boolean | null;
  };
  validityMs: number;
  exec: ExecContext;
}

export interface FourBrainGatherInput {
  instanceId: string;
  nowMs: number;
  supportedLanes: ReadonlySet<string>;
  marketState: MarketStateRawReadings;
  directions: DirectionRawReadings[];
  entryCandidatesRaw: EntryCandidateRaw[];
  exitCandidatesRaw: ExitCandidateRaw[];
}

export interface AssembledEntryCandidate {
  identity: FourBrainIdentity;
  input: EntryInput;
  exec: ExecContext;
  readings: SourceReading[];
}
export interface AssembledExitCandidate {
  identity: FourBrainIdentity;
  input: ExitInput;
  exec: ExecContext;
}
export interface FourBrainGatheredTick {
  instanceId: string;
  asOfMs: number;
  marketStateInput: MarketStateInput;
  marketReadings: SourceReading[];
  directionInputs: { horizon: DirectionHorizon; input: DirectionInput; readings: SourceReading[] }[];
  entryCandidates: AssembledEntryCandidate[];
  exitCandidates: AssembledExitCandidate[];
  diagnostics: {
    unknownLanes: string[];
    duplicateEntryKeys: string[];
    duplicateExitKeys: string[];
    freshness: Record<string, { fresh: number; stale: number; missing: number; error: number }>;
  };
  allReadings: SourceReading[];
}

/**
 * PURE assembly: raw readings (fetched by the bindings from verified live singletons) → the exact input
 * structs the four brains consume + the audit trail. Every source is freshness-classified here (a FUTURE
 * timestamp ⇒ ERROR ⇒ neutral-filled). Duplicate candidate identities are REJECTED (both dropped) + recorded.
 * Unknown lanes are surfaced. NEVER fabricates a missing value as 0. Deterministic in the input.
 */
export function assembleFourBrainTick(input: FourBrainGatherInput): FourBrainGatheredTick {
  const nowMs = input.nowMs;
  const allReadings: SourceReading[] = [];
  const rd = (r: RawReadingInput): SourceReading => {
    const reading = auditReading(r, nowMs);
    allReadings.push(reading);
    return reading;
  };

  // ── Market State ──────────────────────────────────────────────────────────────────────────────
  const ms = input.marketState;
  const msReadings = {
    trend: rd(ms.trend),
    volatility: rd(ms.volatility),
    liquidity: rd(ms.liquidity),
    breadth: rd(ms.breadth),
    momentum: rd(ms.momentum),
    eventRisk: rd(ms.eventRisk),
    sentiment: rd(ms.sentiment),
  };
  const marketReadings = Object.values(msReadings);
  const marketStateInput: MarketStateInput = {
    nowMs,
    validityMs: ms.validityMs,
    trend: toTagged(msReadings.trend),
    volatility: toTagged(msReadings.volatility),
    liquidity: toTagged(msReadings.liquidity),
    breadth: toTagged(msReadings.breadth),
    momentum: toTagged(msReadings.momentum),
    eventRisk: toTagged(msReadings.eventRisk),
    sentiment: toTagged(msReadings.sentiment),
    safetyEvents: ms.safetyEvents,
  };

  // ── Direction (per horizon) ──────────────────────────────────────────────────────────────────
  const directionInputs = input.directions.map((d) => {
    const readings = {
      longEdge: rd(d.longEdge),
      shortEdge: rd(d.shortEdge),
      conviction: rd(d.conviction),
      longLaneEdge: rd(d.longLaneEdge),
      shortLaneEdge: rd(d.shortLaneEdge),
      kronosAgree: rd(d.kronosAgree),
      crowdingAlignLong: rd(d.crowdingAlignLong),
    };
    const di: DirectionInput = {
      nowMs,
      validityMs: d.validityMs,
      horizon: d.horizon,
      marketBias: d.marketBias,
      transitionRisk: d.transitionRisk,
      longEdge: toTagged(readings.longEdge),
      shortEdge: toTagged(readings.shortEdge),
      longEdgeN: d.longEdgeN ?? null,
      shortEdgeN: d.shortEdgeN ?? null,
      conviction: toTagged(readings.conviction),
      longLaneEdge: toTagged(readings.longLaneEdge),
      shortLaneEdge: toTagged(readings.shortLaneEdge),
      kronosAgree: toTagged(readings.kronosAgree),
      crowdingAlignLong: toTagged(readings.crowdingAlignLong),
      controllerBias: d.controllerBias,
      leansLong: d.leansLong,
      leansShort: d.leansShort,
      longVeto: d.longVeto,
      shortVeto: d.shortVeto,
      fourBrainLongVeto: d.fourBrainLongVeto,
      fourBrainShortVeto: d.fourBrainShortVeto,
    };
    return { horizon: d.horizon, input: di, readings: Object.values(readings) };
  });

  // ── Entry candidates (dedup by identity; unknown lanes surfaced) ─────────────────────────────
  const entryDedup = rejectDuplicates(input.entryCandidatesRaw, (c) => identityKey(c.identity));
  const entryCandidates: AssembledEntryCandidate[] = entryDedup.kept.map((c) => {
    const micro = {
      distanceFromVwapAtr: rd(c.micro.distanceFromVwapAtr),
      candleExtensionAtr: rd(c.micro.candleExtensionAtr),
      pullbackDepthAtr: rd(c.micro.pullbackDepthAtr),
      spreadBps: rd(c.micro.spreadBps),
      expectedSlippageBps: rd(c.micro.expectedSlippageBps),
    };
    const ei: EntryInput = {
      nowMs,
      validityMs: c.validityMs,
      side: c.side,
      // Candidate identity salt for decisionId — the SAME key used for entry-candidate dedup above, so
      // it is guaranteed unique across every kept candidate in this tick (see EntryInput.candidateKey's
      // doc comment in entry-brain.ts for the collision this closes).
      candidateKey: identityKey(c.identity),
      signalAgeMs: c.signalAgeMs,
      maxSignalAgeMs: c.maxSignalAgeMs,
      price: c.price,
      targetEntry: c.targetEntry,
      invalidationPrice: c.invalidationPrice,
      initialStopPrice: c.initialStopPrice,
      atr: c.atr,
      distanceFromVwapAtr: toTagged(micro.distanceFromVwapAtr),
      candleExtensionAtr: toTagged(micro.candleExtensionAtr),
      pullbackDepthAtr: toTagged(micro.pullbackDepthAtr),
      spreadBps: toTagged(micro.spreadBps),
      expectedSlippageBps: toTagged(micro.expectedSlippageBps),
      breakoutConfirmed: c.breakoutConfirmed,
      volumeConfirmed: c.volumeConfirmed,
      candleFresh: c.candleFresh ?? null, // adapter B: false ⇒ Entry Brain must not ENTER_NOW
      bookDepthOk: null, // UNAVAILABLE source — MISSING, not required
      crowdingState: c.crowdingState,
      expectedDirectionalR: c.expectedDirectionalR,
    };
    return { identity: c.identity, input: ei, exec: c.exec, readings: Object.values(micro) };
  });

  // ── Exit candidates (dedup by identity) ──────────────────────────────────────────────────────
  const exitDedup = rejectDuplicates(input.exitCandidatesRaw, (c) => identityKey(c.identity));
  const exitCandidates: AssembledExitCandidate[] = exitDedup.kept.map((c) => {
    const xi: ExitInput = {
      nowMs,
      validityMs: c.validityMs,
      side: c.side,
      // Candidate identity salt for decisionId — the SAME key used for exit-candidate dedup above, so
      // it is guaranteed unique across every kept candidate in this tick (see ExitInput.candidateKey's
      // doc comment in exit-brain.ts for the collision this closes).
      candidateKey: identityKey(c.identity),
      entryPrice: c.entryPrice,
      currentPrice: c.currentPrice,
      unrealizedR: c.unrealizedR,
      mfeR: c.mfeR,
      maeR: c.maeR,
      timeInTradeMs: c.timeInTradeMs,
      maxHoldMs: c.maxHoldMs,
      hardStopPrice: c.hardStopPrice,
      killLatched: c.killLatched,
      ...c.decay,
    };
    return { identity: c.identity, input: xi, exec: c.exec };
  });

  // ── Unknown lanes across all candidates (surfaced, never silently dropped) ────────────────────
  const laneIds = [...new Set([...input.entryCandidatesRaw.map((c) => c.identity.laneId), ...input.exitCandidatesRaw.map((c) => c.identity.laneId)])];
  const { unknownLanes } = classifyLanes(laneIds, input.supportedLanes);

  return {
    instanceId: input.instanceId,
    asOfMs: nowMs,
    marketStateInput,
    marketReadings,
    directionInputs,
    entryCandidates,
    exitCandidates,
    diagnostics: {
      unknownLanes,
      duplicateEntryKeys: entryDedup.duplicateKeys,
      duplicateExitKeys: exitDedup.duplicateKeys,
      freshness: freshnessTally(allReadings),
    },
    allReadings,
  };
}
