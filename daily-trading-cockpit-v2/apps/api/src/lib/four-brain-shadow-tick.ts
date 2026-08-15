/**
 * Four-Brain SHADOW tick (Phase 2, REPORT-ONLY). Orchestrates one report-only pass: gather → Market State →
 * Direction (per horizon) → Entry (per candidate) → Exit (per open position) → ExecutiveDecision → invariants
 * → journal → metrics. It DRIVES NOTHING. Hard guarantees, all tested:
 *   • Gated: mode !== "shadow" ⇒ ZERO gather + ZERO journal/store I/O (a pure early return).
 *   • Single-flight: if a prior tick is still running, SKIP the new one (never overlap) + metric the skip.
 *   • Fail-open: any exception (gather or a brain) is swallowed — the incumbent cycle is never broken.
 *   • Deterministic decisions: asOfMs is injected; decision IDs are content-derived + deduped on retry.
 *   • No execution: this module imports only pure brains + the report journal — never an executor/order path.
 */
import {
  fourBrainMode,
  type DirectionDecision,
  type ExecutiveDecision,
  type FourBrainMode,
  type MarketBias,
  type MarketStateAuthority,
  type MarketStateDecision,
} from "./four-brain-types.js";
import { decideMarketState } from "./market-state-brain.js";
import { decideDirection } from "./direction-brain.js";
import { decideEntry } from "./entry-brain.js";
import { decideExit } from "./exit-brain.js";
import { buildExecutiveDecision, runBrainSafely } from "./executive-decision.js";
import { rankFourBrainShadowEntries } from "./four-brain-shadow-ranking.js";
import {
  checkEntryInvariants,
  checkExecutiveInvariants,
  checkExitInvariants,
} from "./four-brain-invariants.js";
import { buildExecutiveDecisionRecord, type ExecutiveJournalContext } from "./four-brain-journal.js";
import type { FourBrainGatheredTick } from "./four-brain-live-gather.js";

export interface FourBrainTickMetrics {
  attempted: number;
  completed: number;
  skippedSingleFlight: number;
  gatherErrors: number;
  journalErrors: number;
  reviewAttachmentErrors: number;
  /** 2026-07-22 fix: a single candidate's Direction/Entry/Exit/ExecutiveDecision call throwing used to
   *  abort the ENTIRE tick (the one top-level try/catch), losing the market snapshot + every OTHER
   *  candidate's decision too — disproportionate to one bad candidate. Each per-candidate brain call is
   *  now wrapped in runBrainSafely (executive-decision.ts's own doc always claimed this, but it was never
   *  actually called anywhere until this fix) so a single failure only skips that one candidate. */
  brainErrors: number;
  invariantFailures: number;
  decisions: number;
  duplicateDecisionIds: number;
  byCandidateStatus: Record<string, number>;
  byBrainAction: Record<string, number>;
  unknownLanes: number;
  duplicateIdentities: number;
  laneCoverage: number; // # entry candidates evaluated
  positionCoverage: number; // # exit candidates evaluated
  staleOrMissingByClass: Record<string, { stale: number; missing: number; error: number; fresh: number }>;
  gatherMs: number;
  inferenceMs: number;
  journalMs: number;
}

export interface FourBrainTickResult {
  ran: boolean;
  reason: "mode-off" | "single-flight-skip" | "gather-error" | "exception" | "ok";
  marketState: MarketStateDecision | null;
  directions: DirectionDecision[];
  executiveDecisions: ExecutiveDecision[];
  metrics: FourBrainTickMetrics;
}

export interface FourBrainShadowTickDeps {
  /** Resolved four-brain mode (fourBrainMode(process.env)). Passed in so tests control it. */
  mode: FourBrainMode;
  /** Injected as-of clock — the single consistent asOfMs for the whole tick (deterministic in tests). */
  nowMs: number;
  /** Impure gather. MAY throw — the tick fails open (gather-error). */
  gather: (nowMs: number) => FourBrainGatheredTick;
  /** Append a report record. Contractually never throws (CortexDecisionJournal), but wrapped anyway. */
  journalAppend: (record: Record<string, unknown>) => void;
  /** Extra journal context (incumbent snapshot, etc.). */
  journalContext?: (gathered: FourBrainGatheredTick) => ExecutiveJournalContext;
  /** Shadow-only observer for exact review attachment. It is never an execution authority. */
  onExecutiveDecision?: (decision: ExecutiveDecision, identity: { signalId: string | null; positionId: string | null }) => void;
  /** Monotonic perf clock for LATENCY only (never affects decisions). Defaults to () => 0. */
  perfNow?: () => number;
  emitMetrics?: (m: FourBrainTickMetrics) => void;
  tickId: string;
}

function emptyMetrics(): FourBrainTickMetrics {
  return {
    attempted: 0, completed: 0, skippedSingleFlight: 0, gatherErrors: 0, journalErrors: 0, reviewAttachmentErrors: 0, brainErrors: 0, invariantFailures: 0,
    decisions: 0, duplicateDecisionIds: 0, byCandidateStatus: {}, byBrainAction: {}, unknownLanes: 0,
    duplicateIdentities: 0, laneCoverage: 0, positionCoverage: 0, staleOrMissingByClass: {}, gatherMs: 0, inferenceMs: 0, journalMs: 0,
  };
}

/** Emit metrics, swallowing ANY exception — a metrics sink must NEVER be able to throw into the incumbent
 *  cycle (a throw here, especially inside the fail-open catch, would defeat the whole report-only guarantee). */
function safeEmit(deps: FourBrainShadowTickDeps, metrics: FourBrainTickMetrics): void {
  try {
    deps.emitMetrics?.(metrics);
  } catch {
    /* metrics are best-effort; never propagate */
  }
}

/** The focussed testnet's canonical regime is the one actionable state. */
function authoritativeBias(authority: MarketStateAuthority): MarketBias {
  if (authority.canonicalRegimeFamily === "BULLISH") return "BULLISH";
  if (authority.canonicalRegimeFamily === "BEARISH") return "BEARISH";
  if (authority.canonicalRegimeFamily === "MIXED") return "MIXED";
  return "NEUTRAL";
}

function applyMarketStateAuthority(
  technical: MarketStateDecision,
  authority: MarketStateAuthority | null,
): MarketStateDecision {
  if (!authority) return technical;
  return {
    ...technical,
    // The independent technical family remains in the audit payload. Only its
    // directional bias is overridden, so Direction Brain cannot treat a
    // canonical MIXED market as BULLISH/BEARISH just from a saturated slope.
    bias: authoritativeBias(authority),
    authority,
    reasons: [
      ...technical.reasons,
      `executor canonical=${authority.canonicalRegimeFamily}; scanner=${authority.scannerRegime ?? "UNKNOWN"}; technical family is diagnostic only`,
    ],
  };
}

/**
 * Evaluate exactly one executor-owned candidate on the same pure Four-Brain path as the scheduled
 * shadow tick, without touching its module-level single-flight latch, journal, metrics, or an
 * executor. The caller supplies the exact lane/symbol/side/signal identity immediately before
 * submit, so a later periodic scan cannot be mistaken for the decision that preceded an actual
 * fill.
 */
export interface FourBrainPreEntryEvaluation {
  executive: ExecutiveDecision;
  identity: { signalId: string | null; positionId: null };
  marketState: MarketStateDecision;
  directions: DirectionDecision[];
  invariantViolations: string[];
}

export function evaluateFourBrainPreEntryCandidate(
  gathered: FourBrainGatheredTick,
): FourBrainPreEntryEvaluation | null {
  if (gathered.entryCandidates.length !== 1) return null;
  try {
    const candidate = gathered.entryCandidates[0]!;
    const marketState = applyMarketStateAuthority(
      decideMarketState(gathered.marketStateInput),
      gathered.marketStateAuthority,
    );
    const directions: DirectionDecision[] = [];
    const directionByHorizon = new Map<string, DirectionDecision>();
    for (const row of gathered.directionInputs) {
      const direction = runBrainSafely(() =>
        decideDirection({ ...row.input, marketBias: marketState.bias, transitionRisk: marketState.transitionRisk }),
      );
      if (direction === null) continue;
      directions.push(direction);
      directionByHorizon.set(row.horizon, direction);
    }
    const entry = runBrainSafely(() => decideEntry(candidate.input));
    if (entry === null) return null;
    const signalFresh = candidate.readings.length === 0
      ? undefined
      : candidate.input.signalAgeMs != null && candidate.input.signalAgeMs <= candidate.input.maxSignalAgeMs;
    const entryInvariants = checkEntryInvariants(entry, { signalFresh, side: candidate.input.side });
    const executive = runBrainSafely(() =>
      buildExecutiveDecision({
        nowMs: gathered.asOfMs,
        marketState,
        direction: directionByHorizon.get(candidate.identity.horizon ?? "") ?? null,
        entry,
        exit: null,
        allocationContext: candidate.exec.allocationContext,
        marketContext: candidate.exec.marketContext,
        laneId: candidate.identity.laneId,
        symbolOrBasketId: candidate.identity.symbolOrBasketId,
        laneEligibleIncumbent: candidate.exec.laneEligibleIncumbent,
        directionHurdlePassed: candidate.exec.directionHurdlePassed,
        executionReinforcement: candidate.exec.executionReinforcement,
        killLatched: candidate.exec.killLatched,
        riskBlockedReason: candidate.exec.riskBlockedReason,
        identityDiscriminator: `entry:${candidate.identity.signalId ?? candidate.identity.symbolOrBasketId}`,
      }),
    );
    if (executive === null) return null;
    const ranked = rankFourBrainShadowEntries([executive])[0] ?? executive;
    const executiveInvariants = checkExecutiveInvariants(ranked);
    return {
      executive: ranked,
      identity: { signalId: candidate.identity.signalId, positionId: null },
      marketState,
      directions,
      invariantViolations: [...entryInvariants.violations, ...executiveInvariants.violations],
    };
  } catch {
    return null;
  }
}

// Module-level single-flight guard — a prior tick still running ⇒ the next is skipped, never overlapped.
let inFlight = false;
/** Test hook: reset the single-flight latch. */
export function _resetFourBrainSingleFlightForTests(): void {
  inFlight = false;
}

/**
 * Run ONE shadow tick. Synchronous + report-only. Returns a result + metrics; never throws.
 */
export function runFourBrainShadowTick(deps: FourBrainShadowTickDeps): FourBrainTickResult {
  const metrics = emptyMetrics();
  // ── Gate: off / unknown ⇒ ZERO I/O (no gather, no journal). ────────────────────────────────────
  if (deps.mode !== "shadow") {
    return { ran: false, reason: "mode-off", marketState: null, directions: [], executiveDecisions: [], metrics };
  }
  // ── Single-flight: skip if a prior tick is still running. ──────────────────────────────────────
  if (inFlight) {
    metrics.skippedSingleFlight = 1;
    safeEmit(deps, metrics);
    return { ran: false, reason: "single-flight-skip", marketState: null, directions: [], executiveDecisions: [], metrics };
  }
  inFlight = true;
  metrics.attempted = 1;
  const perf = deps.perfNow ?? (() => 0);
  const nowMs = deps.nowMs;
  try {
    // ── Gather (fail-open on error). ──────────────────────────────────────────────────────────────
    const g0 = perf();
    let gathered: FourBrainGatheredTick;
    try {
      gathered = deps.gather(nowMs);
    } catch {
      metrics.gatherErrors = 1;
      safeEmit(deps, metrics);
      return { ran: false, reason: "gather-error", marketState: null, directions: [], executiveDecisions: [], metrics };
    }
    metrics.gatherMs = perf() - g0;
    metrics.unknownLanes = gathered.diagnostics.unknownLanes.length;
    metrics.duplicateIdentities = gathered.diagnostics.duplicateEntryKeys.length + gathered.diagnostics.duplicateExitKeys.length;
    metrics.staleOrMissingByClass = gathered.diagnostics.freshness;
    metrics.laneCoverage = gathered.entryCandidates.length;
    metrics.positionCoverage = gathered.exitCandidates.length;

    // ── Inference: market state, direction per horizon, entry/exit per candidate. ─────────────────
    const i0 = perf();
    const marketState = applyMarketStateAuthority(
      decideMarketState(gathered.marketStateInput),
      gathered.marketStateAuthority,
    );
    const directionByHorizon = new Map<string, DirectionDecision>();
    const directions: DirectionDecision[] = [];
    for (const d of gathered.directionInputs) {
      // Each horizon has independent evidence and self-outcome state. A failure in one must not
      // suppress the others, and no result is copied across horizons.
      const dec = runBrainSafely(() => decideDirection({ ...d.input, marketBias: marketState.bias, transitionRisk: marketState.transitionRisk }));
      if (dec === null) { metrics.brainErrors += 1; continue; }
      directionByHorizon.set(d.horizon, dec);
      directions.push(dec);
      metrics.byBrainAction[`dir:${dec.action}`] = (metrics.byBrainAction[`dir:${dec.action}`] ?? 0) + 1;
    }

    const executiveDecisions: ExecutiveDecision[] = [];
    const entryExecutiveDecisions: ExecutiveDecision[] = [];
    const identityByExecutiveDecisionId = new Map<
      string,
      { signalId: string | null; positionId: string | null }
    >();
    const seenDecisionIds = new Set<string>();

    for (const c of gathered.entryCandidates) {
      const entry = runBrainSafely(() => decideEntry(c.input));
      if (entry === null) {
        metrics.brainErrors += 1;
        continue; // this candidate is skipped; every other candidate + the market snapshot still journal
      }
      metrics.byBrainAction[`entry:${entry.action}`] = (metrics.byBrainAction[`entry:${entry.action}`] ?? 0) + 1;
      const signalFresh = c.readings.length === 0 ? undefined : c.input.signalAgeMs != null && c.input.signalAgeMs <= c.input.maxSignalAgeMs;
      const inv = checkEntryInvariants(entry, { signalFresh, side: c.input.side });
      if (!inv.ok) metrics.invariantFailures += inv.violations.length;
      const exec = runBrainSafely(() =>
        buildExecutiveDecision({
          nowMs,
          marketState,
          direction: directionByHorizon.get(c.identity.horizon ?? "") ?? null,
          entry,
          exit: null,
          allocationContext: c.exec.allocationContext,
          marketContext: c.exec.marketContext,
          laneId: c.identity.laneId,
          symbolOrBasketId: c.identity.symbolOrBasketId,
          laneEligibleIncumbent: c.exec.laneEligibleIncumbent,
          directionHurdlePassed: c.exec.directionHurdlePassed,
          executionReinforcement: c.exec.executionReinforcement,
          killLatched: c.exec.killLatched,
          riskBlockedReason: c.exec.riskBlockedReason,
          identityDiscriminator: `entry:${c.identity.signalId ?? c.identity.symbolOrBasketId}`,
        }),
      );
      if (exec === null) {
        metrics.brainErrors += 1;
        continue;
      }
      entryExecutiveDecisions.push(exec);
      identityByExecutiveDecisionId.set(exec.decisionId, {
        signalId: c.identity.signalId,
        positionId: c.identity.positionId,
      });
    }

    // Positive exact-fill reinforcement now changes a deterministic, journaled SHADOW rank.  This
    // is intentionally before the observer/journal handoff, so every downstream report sees the
    // rank that was actually used for the shadow recommendation.
    executiveDecisions.push(...rankFourBrainShadowEntries(entryExecutiveDecisions));

    for (const c of gathered.exitCandidates) {
      const exit = runBrainSafely(() => decideExit(c.input));
      if (exit === null) {
        metrics.brainErrors += 1;
        continue;
      }
      metrics.byBrainAction[`exit:${exit.action}`] = (metrics.byBrainAction[`exit:${exit.action}`] ?? 0) + 1;
      const inv = checkExitInvariants(exit, { side: c.input.side, hardStopPrice: c.input.hardStopPrice, hardExitTriggered: c.exec.hardExitTriggered });
      if (!inv.ok) metrics.invariantFailures += inv.violations.length;
      const exec = runBrainSafely(() =>
        buildExecutiveDecision({
          nowMs,
          marketState,
          direction: null,
          entry: null,
          exit,
          allocationContext: c.exec.allocationContext,
          marketContext: c.exec.marketContext,
          laneId: c.identity.laneId,
          symbolOrBasketId: c.identity.symbolOrBasketId,
          laneEligibleIncumbent: c.exec.laneEligibleIncumbent,
          killLatched: c.exec.killLatched,
          riskBlockedReason: c.exec.riskBlockedReason,
          hardExitTriggered: c.exec.hardExitTriggered,
          identityDiscriminator: `exit:${c.identity.positionId ?? c.identity.symbolOrBasketId}`,
        }),
      );
      if (exec === null) {
        metrics.brainErrors += 1;
        continue;
      }
      executiveDecisions.push(exec);
      identityByExecutiveDecisionId.set(exec.decisionId, {
        signalId: c.identity.signalId,
        positionId: c.identity.positionId,
      });
    }
    metrics.inferenceMs = perf() - i0;

    // ── Journal (report-only; never fails the cycle; dedup decision IDs on retry). ────────────────
    const j0 = perf();
    const ctx = deps.journalContext ? deps.journalContext(gathered) : {};
    for (const exec of executiveDecisions) {
      const invExec = checkExecutiveInvariants(exec);
      if (!invExec.ok) metrics.invariantFailures += invExec.violations.length;
      if (!seenDecisionIds.has(exec.decisionId)) {
        seenDecisionIds.add(exec.decisionId);
        metrics.byCandidateStatus[exec.candidateStatus] = (metrics.byCandidateStatus[exec.candidateStatus] ?? 0) + 1;
        metrics.decisions += 1;
        const identity = identityByExecutiveDecisionId.get(exec.decisionId);
        try {
          deps.journalAppend(buildExecutiveDecisionRecord(exec, {
            ...ctx,
            invariantViolations: invExec.violations,
            signalId: identity?.signalId ?? null,
            positionId: identity?.positionId ?? null,
          }));
        } catch {
          metrics.journalErrors += 1;
        }
        // A journal disk error must not suppress exact review attachment. This remains advisory
        // and each observer failure is isolated from the next ExecutiveDecision.
        try {
          deps.onExecutiveDecision?.(exec, {
            signalId: identity?.signalId ?? null,
            positionId: identity?.positionId ?? null,
          });
        } catch {
          metrics.reviewAttachmentErrors += 1;
        }
      } else {
        metrics.duplicateDecisionIds += 1;
      }
    }
    // Always journal a market snapshot (so the tick is auditable even with zero candidates).
    try {
      deps.journalAppend({
        kind: "MARKET_SNAPSHOT",
        reportOnly: true,
        tickId: deps.tickId,
        instanceId: gathered.instanceId,
        asOfMs: nowMs,
        marketState,
        directions,
        diagnostics: gathered.diagnostics,
        marketReadings: gathered.marketReadings,
      });
    } catch {
      metrics.journalErrors += 1;
    }
    metrics.journalMs = perf() - j0;

    metrics.completed = 1;
    safeEmit(deps, metrics);
    return { ran: true, reason: "ok", marketState, directions, executiveDecisions, metrics };
  } catch {
    // Fail OPEN — an unexpected exception must never break the incumbent cycle that schedules this tick.
    safeEmit(deps, metrics);
    return { ran: false, reason: "exception", marketState: null, directions: [], executiveDecisions: [], metrics };
  } finally {
    inFlight = false;
  }
}

export { fourBrainMode };
