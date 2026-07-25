/**
 * CRISIS MODE CYCLE (wiring layer, 2026-07-22) — TESTNET/RESEARCH REPORT-ONLY.
 *
 * WHAT THIS IS: the one cycle that ties together the three pure/I-O modules built earlier today —
 *   lib/geopolitical-conflict-feed.ts       (fetch GDELT events → ConflictIntensity)
 *   lib/geopolitical-escalation-classifier.ts (ConflictIntensity → 0-100 EscalationClassification)
 *   lib/crisis-mode-controller.ts           (EscalationClassification + market-shock confirmation →
 *                                             CrisisModeEvaluation: active/inactive, bounded tilt,
 *                                             bounded exit-tolerance override)
 * into one ~7-minute tick (same shared ticker every other 2026-07-21/22 shadow lane rides — see
 * routes/shadow.ts's operator-brief resolve=1 block), and persists a bounded audit log entry every
 * time the `active` state flips, plus an always-current status snapshot the report route reads.
 *
 * THIS MODULE APPLIES NOTHING TO REAL CAPITAL. It fetches public news events, computes a score,
 * evaluates crisis mode, and writes to its OWN store. It never calls RegimeAutopilot.setAllocations,
 * never touches any executor's sizing, never mutates exit-brain-policy.ts's real params. The
 * allocationTiltPct / exitToleranceOverride fields on every persisted entry are DATA — evidence of
 * what crisis-mode-controller.ts computed — not an instruction that got carried out. See
 * lib/crisis-mode-instance-guard.ts for the gate any FUTURE application code must check first (that
 * gate hard-blocks the live/mainnet instance unconditionally; nothing in this repo calls it yet).
 *
 * SHIPS OFF BY DEFAULT (deliberate deviation from this repo's usual default-running `_DISABLED`
 * kill-switch convention, same documented-deviation discipline as
 * geopolitical-escalation-classifier.ts's own default-off LLM gate): CRISIS_MODE_DISABLED must be
 * explicitly set to "0" before this cycle does ANYTHING — no fetch, no scoring, no evaluation, no
 * store writes. Unset (the default on every instance, including a freshly-rsynced live box) means
 * fully dormant. This is intentional: crisis-mode is new, untested against real market events, and
 * the operator must explicitly opt in per instance after reviewing behavior — the same staged path
 * CORTEX and four-brain took before either was trusted to run anywhere.
 *
 * Distinct from crisis-mode-controller.ts's OWN CRISIS_MODE_CONTROLLER_DISABLED_FLAG (default
 * RUNNING, forces evaluateCrisisMode's output to INACTIVE when set) — that is a softer,
 * finer-grained override that only affects the pure evaluation step itself. This module's
 * CRISIS_MODE_DISABLED is the coarser, cycle-level gate: with it unset, the cycle never even runs,
 * so the controller's own kill switch is moot.
 */

import type { NvidiaChatConfig } from "./nvidia-chat-client.js";
import {
  computeConflictIntensity,
  buildConflictFeedReport,
  runGeopoliticalConflictFeedCycle,
  type ConflictIntensity,
  type FetchConflictEventsOptions,
  type GeopoliticalConflictFeedStore,
  type GeopoliticalFeedReport,
} from "./geopolitical-conflict-feed.js";
import {
  classifyEscalation,
  requestLlmCorroboration,
  GEOPOLITICAL_ESCALATION_LLM_MAX_EVENTS,
  DEFAULT_ESCALATION_SCORE_PARAMS,
  type EscalationClassification,
  type EscalationScoreParams,
  type LlmCorroborationResult,
} from "./geopolitical-escalation-classifier.js";
import {
  evaluateCrisisMode,
  DEFAULT_CRISIS_MODE_PARAMS,
  CRISIS_MODE_CONTROLLER_DISABLED_FLAG,
  isCrisisModeActionEnabled,
  type CrisisModeEvaluation,
  type CrisisModeEvidence,
  type CrisisModeMarketShockSignals,
  type CrisisModeParams,
  type CrisisExitToleranceOverride,
} from "./crisis-mode-controller.js";
import {
  resolveCrisisModeInstanceId,
  isCrisisModeLiveInstance,
  isCrisisModeLiveExecutionAllowed,
  canApplyCrisisModeActions,
} from "./crisis-mode-instance-guard.js";
import type { BtcShockAssessment, BlsCycleMeta } from "./btc-leadlag-snap-edge.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function envNumPos(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// ── config ────────────────────────────────────────────────────────────────

/** Cycle-level kill switch — see module header. Default DISABLED: only "0" turns this on. */
export const CRISIS_MODE_CYCLE_DISABLED_FLAG = "CRISIS_MODE_DISABLED";

export function isCrisisModeCycleDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CRISIS_MODE_CYCLE_DISABLED_FLAG] !== "0";
}

/** Trailing window computeConflictIntensity aggregates over for the "current" escalation read —
 *  deliberately tighter than the feed's own 14-day storage retention (geopolitical-conflict-feed.ts's
 *  GEOPOLITICAL_FEED_MAX_AGE_MS): a military-escalation READ should weight recent activity heavily,
 *  not dilute it against two weeks of quieter background chatter. A documented judgment call, not
 *  fitted to any sample. */
export const CRISIS_MODE_CONFLICT_WINDOW_MS = envNumPos("CRISIS_MODE_CONFLICT_WINDOW_MS", 48 * 3_600_000);

/** How stale a BTC lead-lag shock reading (from btc-leadlag-snap-edge.ts's own cycleMeta) can be and
 *  still count as "currently confirming" for crisis-mode's market-confirmation leg. ~2x the shared
 *  ~7min ticker cadence — a shock detected on the last tick or two still counts as live; one from
 *  hours ago must not silently keep confirming crisis mode forever. See btcShockFromCycleMeta. */
export const CRISIS_MODE_BTC_SHOCK_FRESHNESS_MS = envNumPos("CRISIS_MODE_BTC_SHOCK_FRESHNESS_MS", 15 * 60_000);

// ── BTC shock: read-only derivation from btc-leadlag-snap-edge.ts's OWN cycleMeta ──────────────
//
// This does NOT run BLS's cycle or fetch candles itself — it reads the liveness meta BLS's own
// ~7min cycle already persists (lastShockAt/lastShockZScore/lastShockDirection), exactly the
// "read-only confirmation input, does not run their cycles or touch their stores" contract
// crisis-mode-controller.ts's header documents. A shock is only reported as CURRENTLY confirming
// when it happened within CRISIS_MODE_BTC_SHOCK_FRESHNESS_MS of `nowMs` — an old lastShockAt must
// fail-open to isShock:false, never linger as a stale confirmation.

export function btcShockFromCycleMeta(
  cycleMeta: BlsCycleMeta,
  nowMs: number,
  freshnessMs: number = CRISIS_MODE_BTC_SHOCK_FRESHNESS_MS,
): Pick<BtcShockAssessment, "isShock" | "zScore" | "direction"> | null {
  if (cycleMeta.lastShockAt === null || !finite(cycleMeta.lastShockZScore)) return null;
  const shockAtMs = new Date(cycleMeta.lastShockAt).getTime();
  if (!Number.isFinite(shockAtMs)) return null;
  const fresh = nowMs - shockAtMs <= freshnessMs;
  return {
    isShock: fresh,
    zScore: cycleMeta.lastShockZScore,
    direction: fresh ? cycleMeta.lastShockDirection : null,
  };
}

// ── audit log store (bounded, atomic, dedup-by-id — same idiom as every *-edge.ts store) ───────

export interface CrisisModeAuditLogEntry {
  /** Deterministic per-cycle id (flip-<epochMs>) — dedups a single-flight-guarded double-call. */
  id: string;
  atIso: string;
  atMs: number;
  previousActive: boolean;
  active: boolean;
  reason: string;
  escalationFinalScore: number;
  escalationQuantitativeScore: number;
  allocationTiltPct: number;
  exitToleranceOverride: CrisisExitToleranceOverride | null;
  evidence: CrisisModeEvidence;
  /** Snapshot of canApplyCrisisModeActions(env) AT EMISSION TIME — always false today (see module
   *  header: nothing applies these fields to real capital), kept for forward-looking audit clarity. */
  canApplyActions: boolean;
  instanceId: string;
}

export interface CrisisModeStatusSnapshot {
  atIso: string;
  atMs: number;
  conflictIntensity: ConflictIntensity;
  escalation: EscalationClassification;
  crisisMode: CrisisModeEvaluation;
  marketShockSignals: CrisisModeMarketShockSignals;
  feedFetchError: string | null;
  llmAvailable: boolean;
  canApplyActions: boolean;
  instanceId: string;
}

export interface CrisisModeCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  disabledCycles: number;
  flipsTotal: number;
  activeCyclesTotal: number;
  lastFeedFetchError: string | null;
  lastError: string | null;
}

const EMPTY_CYCLE_META: CrisisModeCycleMeta = {
  lastCycleAt: null,
  cycles: 0,
  disabledCycles: 0,
  flipsTotal: 0,
  activeCyclesTotal: 0,
  lastFeedFetchError: null,
  lastError: null,
};

/** Bounded retention — same "count AND age, whichever is smaller" convention as
 *  GeopoliticalConflictFeedStore. Flip events are rare (only on an active-state change), so a
 *  generous cap costs almost nothing while keeping a long, useful audit history. */
export const CRISIS_MODE_AUDIT_MAX_ENTRIES = envNumPos("CRISIS_MODE_AUDIT_MAX_ENTRIES", 300);
export const CRISIS_MODE_AUDIT_MAX_AGE_MS = envNumPos("CRISIS_MODE_AUDIT_MAX_AGE_MS", 180 * 24 * 3_600_000);

interface CrisisModeAuditState {
  version: number;
  entries: CrisisModeAuditLogEntry[];
  cycleMeta?: CrisisModeCycleMeta;
  lastStatus?: CrisisModeStatusSnapshot | null;
}

export class CrisisModeAuditLogStore {
  private state: CrisisModeAuditState = { version: 1, entries: [], cycleMeta: { ...EMPTY_CYCLE_META }, lastStatus: null };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<CrisisModeAuditState>;
        if (Array.isArray(parsed.entries)) this.state.entries = parsed.entries as CrisisModeAuditLogEntry[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
        if (parsed.lastStatus && typeof parsed.lastStatus === "object") {
          this.state.lastStatus = parsed.lastStatus as CrisisModeStatusSnapshot;
        }
      } catch {
        /* corrupt → start empty, never throw */
      }
    }
  }

  get all(): CrisisModeAuditLogEntry[] {
    return this.state.entries;
  }

  get cycleMeta(): CrisisModeCycleMeta {
    return this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
  }

  get lastStatus(): CrisisModeStatusSnapshot | null {
    return this.state.lastStatus ?? null;
  }

  has(id: string): boolean {
    return this.state.entries.some((e) => e.id === id);
  }

  /** Adds the flip entry if its id isn't already present; returns whether it was added. */
  addEntry(entry: CrisisModeAuditLogEntry): boolean {
    if (this.has(entry.id)) return false;
    this.state.entries.push(entry);
    return true;
  }

  setLastStatus(status: CrisisModeStatusSnapshot): void {
    this.state.lastStatus = status;
  }

  recordCycle(
    atIso: string,
    delta: { disabled: boolean; feedFetchError: string | null; flipped?: boolean; active?: boolean; error?: string },
  ): void {
    const meta = this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
    meta.lastCycleAt = atIso;
    meta.cycles += 1;
    if (delta.disabled) meta.disabledCycles += 1;
    if (delta.flipped) meta.flipsTotal += 1;
    if (delta.active) meta.activeCyclesTotal += 1;
    meta.lastFeedFetchError = delta.feedFetchError;
    meta.lastError = delta.error ?? null;
    this.state.cycleMeta = meta;
  }

  /** Bounded retention: at most CRISIS_MODE_AUDIT_MAX_ENTRIES entries, AND nothing older than
   *  CRISIS_MODE_AUDIT_MAX_AGE_MS relative to the newest stored entry — both caps applied, newest
   *  kept first (same convention as every sibling *-edge.ts store). */
  private prune(): void {
    if (this.state.entries.length === 0) return;
    const newest = this.state.entries.reduce((max, e) => (finite(e.atMs) && e.atMs > max ? e.atMs : max), -Infinity);
    const cutoff = newest - CRISIS_MODE_AUDIT_MAX_AGE_MS;
    const byAge = this.state.entries
      .filter((e) => finite(e.atMs) && e.atMs >= cutoff)
      .sort((a, b) => b.atMs - a.atMs);
    this.state.entries = byAge.slice(0, CRISIS_MODE_AUDIT_MAX_ENTRIES);
  }

  save(): void {
    this.prune();
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
    renameSync(tmp, this.file); // atomic on POSIX
  }
}

let singleton: CrisisModeAuditLogStore | null = null;
export function getCrisisModeAuditLogStore(dataDir = "data"): CrisisModeAuditLogStore {
  if (!singleton) singleton = new CrisisModeAuditLogStore(resolve(dataDir, "crisis-mode-audit-log.json"));
  return singleton;
}
export function _resetCrisisModeAuditLogStoreForTests(): void {
  singleton = null;
}

// ── cycle ────────────────────────────────────────────────────────────────

export interface CrisisModeCycleOptions {
  feedStore: GeopoliticalConflictFeedStore;
  auditStore: CrisisModeAuditLogStore;
  now: number;
  /** BTC lead-lag + RCS market-confirmation inputs, assembled by the caller from already-running
   *  lanes' own stores/reports (see btcShockFromCycleMeta + regime-axis-timeline.ts's
   *  buildRegimeAxisTimeline — same pattern every other RC/RCS/CE cycle call site already uses). */
  marketShockSignals: CrisisModeMarketShockSignals;
  windowMs?: number;
  fetchOpts?: FetchConflictEventsOptions;
  nvidiaConfig?: NvidiaChatConfig | null;
  llmFetchImpl?: typeof fetch;
  params?: CrisisModeParams;
  scoreParams?: EscalationScoreParams;
  env?: NodeJS.ProcessEnv;
}

export interface CrisisModeCycleResult {
  disabled: boolean;
  feedFetched: number;
  feedAdded: number;
  feedError: string | null;
  llmAvailable: boolean;
  flipped: boolean;
  active: boolean;
  finalScore: number;
}

/**
 * One cycle: honors CRISIS_MODE_DISABLED (default disabled — see module header), then
 *   1. fetches conflict events (GEOPOLITICAL_FEED_DISABLED honored internally, fail-open, never
 *      throws — see runGeopoliticalConflictFeedCycle);
 *   2. aggregates ConflictIntensity over CRISIS_MODE_CONFLICT_WINDOW_MS;
 *   3. optionally corroborates via LLM (GEOPOLITICAL_ESCALATION_LLM_ENABLED honored internally,
 *      default off, never throws — see requestLlmCorroboration);
 *   4. classifies escalation (pure, LLM-ceilinged) and evaluates crisis mode against the supplied
 *      market-shock confirmation inputs (pure, dual-gated — see crisis-mode-controller.ts);
 *   5. persists a bounded audit-log entry ONLY when `active` flips, plus an always-current status
 *      snapshot every cycle regardless of a flip (so the report route never needs to re-run I/O).
 * Never throws — every internal step already fails open to an inert/safe value.
 */
export async function runCrisisModeCycle(opts: CrisisModeCycleOptions): Promise<CrisisModeCycleResult> {
  const env = opts.env ?? process.env;
  const nowIso = new Date(opts.now).toISOString();

  if (isCrisisModeCycleDisabled(env)) {
    opts.auditStore.recordCycle(nowIso, { disabled: true, feedFetchError: null });
    opts.auditStore.save();
    return { disabled: true, feedFetched: 0, feedAdded: 0, feedError: null, llmAvailable: false, flipped: false, active: false, finalScore: 0 };
  }

  const feedResult = await runGeopoliticalConflictFeedCycle({ store: opts.feedStore, now: opts.now, fetchOpts: opts.fetchOpts });

  const windowMs = opts.windowMs ?? CRISIS_MODE_CONFLICT_WINDOW_MS;
  const intensity = computeConflictIntensity(opts.feedStore.all, opts.now, windowMs);

  let llmResult: LlmCorroborationResult | null = null;
  try {
    const recentEvents = [...opts.feedStore.all]
      .sort((a, b) => b.dateMs - a.dateMs)
      .slice(0, GEOPOLITICAL_ESCALATION_LLM_MAX_EVENTS);
    llmResult = await requestLlmCorroboration(recentEvents, opts.nvidiaConfig ?? null, { fetchImpl: opts.llmFetchImpl, env });
  } catch {
    llmResult = null; // requestLlmCorroboration never throws in practice; defensive anyway
  }

  const classification = classifyEscalation(intensity, llmResult, opts.scoreParams ?? DEFAULT_ESCALATION_SCORE_PARAMS);
  const evaluation = evaluateCrisisMode(classification, opts.marketShockSignals, opts.params ?? DEFAULT_CRISIS_MODE_PARAMS, env);
  const instanceId = resolveCrisisModeInstanceId(env);
  const canApply = canApplyCrisisModeActions(env);

  // "No prior observation" (fresh store, corrupt file swallowed on load, test reset) is NOT a flip
  // — a flip requires a REAL previous state to differ from. Fabricating one from null previously
  // inflated flipsTotal/audit-log on every cold start, even when active stayed false→false.
  const hasPriorStatus = opts.auditStore.lastStatus !== null;
  const prevActive = opts.auditStore.lastStatus?.crisisMode.active ?? null;
  const flipped = hasPriorStatus && prevActive !== evaluation.active;
  if (flipped) {
    opts.auditStore.addEntry({
      id: `flip-${opts.now}`,
      atIso: nowIso,
      atMs: opts.now,
      previousActive: prevActive ?? false,
      active: evaluation.active,
      reason: evaluation.reason,
      escalationFinalScore: classification.finalScore,
      escalationQuantitativeScore: classification.quantitativeScore,
      allocationTiltPct: evaluation.allocationTiltPct,
      exitToleranceOverride: evaluation.exitToleranceOverride,
      evidence: evaluation.evidence,
      canApplyActions: canApply,
      instanceId,
    });
  }

  opts.auditStore.setLastStatus({
    atIso: nowIso,
    atMs: opts.now,
    conflictIntensity: intensity,
    escalation: classification,
    crisisMode: evaluation,
    marketShockSignals: opts.marketShockSignals,
    feedFetchError: feedResult.error,
    llmAvailable: classification.llmAvailable,
    canApplyActions: canApply,
    instanceId,
  });
  opts.auditStore.recordCycle(nowIso, { disabled: false, feedFetchError: feedResult.error, flipped, active: evaluation.active });
  opts.auditStore.save();

  return {
    disabled: false,
    feedFetched: feedResult.fetched,
    feedAdded: feedResult.added,
    feedError: feedResult.error,
    llmAvailable: classification.llmAvailable,
    flipped,
    active: evaluation.active,
    finalScore: classification.finalScore,
  };
}

/** Single-flight guard — same idiom as every sibling *CycleGuarded wrapper (e.g.
 *  runGeopoliticalConflictFeedCycleGuarded, runLiqRecoilCycleGuarded): an overlapping tick (a slow
 *  GDELT fetch or LLM call stretching past the ~7min ticker period) must never double-fire. */
let crisisModeCycleInFlight = false;
export async function runCrisisModeCycleGuarded(opts: CrisisModeCycleOptions): Promise<CrisisModeCycleResult | null> {
  if (crisisModeCycleInFlight) return null;
  crisisModeCycleInFlight = true;
  try {
    return await runCrisisModeCycle(opts);
  } catch (error) {
    try {
      opts.auditStore.recordCycle(new Date(opts.now).toISOString(), {
        disabled: false,
        feedFetchError: null,
        error: (error as Error).message,
      });
      opts.auditStore.save();
    } catch {
      /* never let liveness bookkeeping break the caller */
    }
    return null;
  } finally {
    crisisModeCycleInFlight = false;
  }
}

// ── report (transparent — every field traceable, no black-box number) ──────────────────────────

export interface CrisisModeReport {
  generatedAt: string;
  /** Cycle-level kill switch status — see CRISIS_MODE_CYCLE_DISABLED_FLAG. */
  cycleDisabled: boolean;
  /** crisis-mode-controller.ts's own softer kill switch (forces evaluation to INACTIVE). */
  controllerDisabled: boolean;
  instanceId: string;
  isLiveInstance: boolean;
  actionEnabled: boolean;
  liveExecutionAllowed: boolean;
  /** Always false today (no application code exists yet) unless an operator has explicitly set
   *  BOTH default-false gates AND this is not the live instance — see crisis-mode-instance-guard.ts. */
  canApplyActions: boolean;
  /** The latest cycle's full evaluation — null only if the cycle has never run (feature just
   *  enabled, or still disabled). */
  status: CrisisModeStatusSnapshot | null;
  /** Raw evidence: every conflict event behind the escalation score, per-event CAMEO/Goldstein. */
  conflictFeedReport: GeopoliticalFeedReport;
  /** Most recent active-state flips, newest first. */
  recentAuditLog: CrisisModeAuditLogEntry[];
  cycleMeta: CrisisModeCycleMeta;
}

export function buildCrisisModeReport(opts: {
  feedStore: GeopoliticalConflictFeedStore;
  auditStore: CrisisModeAuditLogStore;
  now: number;
  windowMs?: number;
  env?: NodeJS.ProcessEnv;
}): CrisisModeReport {
  const env = opts.env ?? process.env;
  const windowMs = opts.windowMs ?? CRISIS_MODE_CONFLICT_WINDOW_MS;
  return {
    generatedAt: new Date(opts.now).toISOString(),
    cycleDisabled: isCrisisModeCycleDisabled(env),
    controllerDisabled: env[CRISIS_MODE_CONTROLLER_DISABLED_FLAG] === "1",
    instanceId: resolveCrisisModeInstanceId(env),
    isLiveInstance: isCrisisModeLiveInstance(env),
    actionEnabled: isCrisisModeActionEnabled(env),
    liveExecutionAllowed: isCrisisModeLiveExecutionAllowed(env),
    canApplyActions: canApplyCrisisModeActions(env),
    status: opts.auditStore.lastStatus,
    conflictFeedReport: buildConflictFeedReport(opts.feedStore.all, opts.now, windowMs, opts.feedStore.cycleMeta),
    recentAuditLog: [...opts.auditStore.all].sort((a, b) => b.atMs - a.atMs).slice(0, 20),
    cycleMeta: opts.auditStore.cycleMeta,
  };
}
