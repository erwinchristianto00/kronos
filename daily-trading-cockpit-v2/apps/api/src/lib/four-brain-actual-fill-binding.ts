/**
 * Four-Brain actual-fill binding (testnet cohort).
 *
 * A Four-Brain entry decision and an exchange fill used to meet only later through a
 * lane/symbol/time-window heuristic.  That was useful as a legacy recovery path, but it is not
 * causal enough to learn from: one close can be associated with a nearby but unrelated shadow
 * decision.  This store makes the current path explicit:
 *
 *   executive ENTER_NOW (exact signal id) -> confirmed executor fill -> settled net P&L / risk
 *
 * The binding never places, blocks, sizes, or closes an order.  It is only a durable audit link
 * consumed by the outcome reconciler.  Missing identity, unconfirmed entry/exit, or incomplete
 * settlement is terminally marked unmeasured rather than being filled in with a simulation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  EntryAction,
  ExecutiveCandidateStatus,
  ExecutiveDecision,
} from "./four-brain-types.js";

const VERSION = 4;
const MAX_CANDIDATES = 8_000;
const MAX_BINDINGS = 4_000;
const CANDIDATE_RETENTION_MS = 6 * 60 * 60_000;

export type FourBrainActualFillSource = "ENGINE" | "SINGLE_SYMBOL" | "CROSS_SECTIONAL";
export type FourBrainActualFillBindingStatus = "OPEN" | "CLOSED_MEASURED" | "CLOSED_UNMEASURED" | "UNBOUND";
/**
 * DIRECT is the only cohort that can ever feed Entry-Brain readiness/reinforcement.
 * EXECUTOR_OBSERVED is an exact, pre-fill shadow observation of an executor-controlled order;
 * it is useful calibration evidence but must never be presented as a Four-Brain trade.
 */
export type FourBrainActualFillCohort = "FOUR_BRAIN_DIRECT" | "EXECUTOR_OBSERVED" | null;
type CanonicalRegimeFamily = "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN";

export interface FourBrainActualFillCandidate {
  decisionId: string;
  asOfMs: number;
  validUntilMs: number;
  laneId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  signalId: string;
  expectedNetR: number | null;
  canonicalRegimeFamily: CanonicalRegimeFamily | null;
  scannerRegime: string | null;
  marketContextSnapshotId: string | null;
  /**
   * Only PRE_ENTRY_EXECUTOR was captured on the executor path immediately before submit.
   * Older/scheduled candidates remain visible for audit but are never eligible to bind a new
   * fill as Four-Brain-direct evidence.
   */
  captureSource: "PRE_ENTRY_EXECUTOR" | "LEGACY_UNVERIFIED";
}

/**
 * Exact decision context for an executor-owned fill. It is deliberately a separate type and
 * state collection from FourBrainActualFillCandidate: the decision may be WAIT/SKIP, so treating
 * it as a direct Four-Brain recommendation would be a causal attribution error.
 */
export interface FourBrainObservedExecutorDecision extends FourBrainActualFillCandidate {
  entryAction: EntryAction;
  candidateStatus: ExecutiveCandidateStatus;
  /** Wall-clock capture time, not signal as-of time. It must precede the real fill. */
  recordedAtMs: number;
}

export interface FourBrainActualFillBinding {
  bindingKey: string;
  source: FourBrainActualFillSource;
  laneId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  signalId: string;
  openedAtMs: number;
  entryPrice: number | null;
  entryPriceConfirmed: boolean;
  riskUsd: number | null;
  /** Populated only for a VALID ENTER_NOW decision that existed before the confirmed fill. */
  decision: FourBrainActualFillCandidate | null;
  /** Populated only as an executor-observed context; never a direct Four-Brain recommendation. */
  observedDecision: FourBrainObservedExecutorDecision | null;
  cohort: FourBrainActualFillCohort;
  status: FourBrainActualFillBindingStatus;
  closedAtMs: number | null;
  realizedNetR: number | null;
  closeSettlementConfirmed: boolean | null;
  terminalReason: string | null;
}

export interface FourBrainActualFillBindingState {
  version: number;
  candidates: FourBrainActualFillCandidate[];
  observedCandidates: FourBrainObservedExecutorDecision[];
  bindings: FourBrainActualFillBinding[];
  /** Historical scheduled-shadow funnel. Retained for audit, never treated as an executor opportunity. */
  entryAdmissionAudit: FourBrainEntryAdmissionAuditState;
  /** Exact executor pre-entry funnel, started fresh at the v4 rollout. */
  preEntryAdmissionAudit: FourBrainEntryAdmissionAuditState;
}

/**
 * Counts the Entry-Brain path before an exchange fill happens. These are diagnostics only: they
 * explain whether an exact-fill cohort is empty because no candidate was admitted, because the
 * signal identity was absent, or because a real fill arrived without an earlier exact candidate.
 */
export interface FourBrainEntryAdmissionAudit {
  observed: number;
  enterNow: number;
  validEnterNow: number;
  exactCandidatesRecorded: number;
  waiting: number;
  skipped: number;
  other: number;
  missingSignalIdentity: number;
  invalidCandidateMetadata: number;
  lastAtMs: number | null;
  lastAction: string | null;
  lastCandidateStatus: string | null;
}

interface FourBrainEntryAdmissionAuditState extends FourBrainEntryAdmissionAudit {
  /** Bounded de-duplication set: journal/retry duplicates must not inflate the admission funnel. */
  decisionIds: string[];
}

export interface FourBrainActualFillBindingStoreStatus {
  /** Backward-compatible direct cohort counters only. */
  candidates: number;
  open: number;
  measured: number;
  unmeasured: number;
  unbound: number;
  /** Exact executor-owned fills observed by Four-Brain before they opened; never readiness data. */
  executorObserved: {
    candidates: number;
    open: number;
    measured: number;
    unmeasured: number;
    byEntryAction: Partial<Record<EntryAction, number>>;
  };
  /** Legacy scheduled-shadow evaluation counts, retained only for historical audit. */
  entryAdmission: FourBrainEntryAdmissionAudit;
  /** Exact order-path observations recorded before the executor submits an order. */
  preEntryAdmission: FourBrainEntryAdmissionAudit;
  /** Latest lifecycle timestamps for the exact direct cohort.  These are derived from persisted
   * bindings and let the health watchdog distinguish a just-closed fill waiting for reconciliation
   * from a fill that a newer reconciliation silently failed to consume. */
  lifecycle: {
    lastDirectOpenAtMs: number | null;
    lastDirectMeasuredAtMs: number | null;
    lastDirectUnmeasuredAtMs: number | null;
    lastUnboundAtMs: number | null;
  };
  /**
   * Pre-boundary rows stay in the immutable audit trail, but are deliberately
   * excluded from the repaired exact-fill cohort.  They can never be promoted
   * or reconstructed as causal Four-Brain attribution later.
   */
  auditOnlyBeforeCohort: {
    bindings: number;
    unbound: number;
    lastUnboundAtMs: number | null;
  };
  cohortSinceMs: number | null;
}

export interface BindActualFillInput {
  bindingKey: string;
  source: FourBrainActualFillSource;
  laneId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  signalId: string;
  openedAtMs: number;
  entryPrice: number | null;
  entryPriceConfirmed: boolean;
  riskUsd: number | null;
}

export interface CompleteActualFillInput {
  bindingKey: string;
  closedAtMs: number;
  netPnlUsd: number | null;
  settlementConfirmed: boolean;
  reason?: string | null;
}

export interface DirectActualFillOutcome {
  decisionId: string;
  laneId: string;
  symbolOrBasketId: string;
  side: "LONG" | "SHORT";
  asOfMs: number;
  expectedNetR: number | null;
  realizedNetR: number;
  matchedCloseKey: string;
  canonicalRegimeFamily: CanonicalRegimeFamily | null;
  scannerRegime: string | null;
  marketContextSnapshotId: string | null;
}

export interface DirectActualFillUnmeasured {
  decisionId: string;
  laneId: string;
  symbolOrBasketId: string;
  side: "LONG" | "SHORT";
  asOfMs: number;
  expectedNetR: number | null;
  canonicalRegimeFamily: CanonicalRegimeFamily | null;
  scannerRegime: string | null;
  marketContextSnapshotId: string | null;
  reason: string;
}

/**
 * A settled executor fill with a Four-Brain decision captured before entry, retained exclusively
 * for shadow calibration/audit. Consumers must not mix it into DirectActualFillOutcome.
 */
export interface ObservedExecutorActualFillOutcome {
  decisionId: string;
  laneId: string;
  symbolOrBasketId: string;
  side: "LONG" | "SHORT";
  action: EntryAction;
  candidateStatus: ExecutiveCandidateStatus;
  asOfMs: number;
  recordedAtMs: number;
  expectedNetR: number | null;
  realizedNetR: number;
  matchedCloseKey: string;
  canonicalRegimeFamily: CanonicalRegimeFamily | null;
  scannerRegime: string | null;
  marketContextSnapshotId: string | null;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonEmpty = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const canonical = (value: unknown): CanonicalRegimeFamily | null =>
  value === "BULLISH" || value === "BEARISH" || value === "MIXED" || value === "UNKNOWN" ? value : null;
const entryAction = (value: unknown): EntryAction | null =>
  value === "ENTER_NOW" || value === "WAIT_PULLBACK" || value === "WAIT_BREAKOUT" || value === "WAIT_CONFIRMATION" || value === "SKIP"
    ? value
    : null;
const candidateStatus = (value: unknown): ExecutiveCandidateStatus | null =>
  value === "VALID" || value === "FLAT" || value === "WAIT" || value === "SKIP" || value === "BLOCKED_BY_RISK" || value === "MISSING_DATA" || value === "INCUMBENT_ONLY"
    ? value
    : null;
const cohort = (value: unknown): FourBrainActualFillCohort =>
  value === "FOUR_BRAIN_DIRECT" || value === "EXECUTOR_OBSERVED" ? value : null;

function normalizedIdentity(laneId: string, symbol: string, side: string, signalId: string): string {
  return `${laneId.trim().toUpperCase()}::${symbol.trim().toUpperCase()}::${side}::${signalId.trim()}`;
}

function isPreEntryDirectBinding(binding: FourBrainActualFillBinding): boolean {
  return binding.cohort === "FOUR_BRAIN_DIRECT" && binding.decision?.captureSource === "PRE_ENTRY_EXECUTOR";
}

const count = (value: unknown): number => isFiniteNumber(value) && value >= 0 ? Math.floor(value) : 0;

function emptyEntryAdmissionAudit(): FourBrainEntryAdmissionAuditState {
  return {
    observed: 0,
    enterNow: 0,
    validEnterNow: 0,
    exactCandidatesRecorded: 0,
    waiting: 0,
    skipped: 0,
    other: 0,
    missingSignalIdentity: 0,
    invalidCandidateMetadata: 0,
    lastAtMs: null,
    lastAction: null,
    lastCandidateStatus: null,
    decisionIds: [],
  };
}

function parseEntryAdmissionAudit(value: unknown): FourBrainEntryAdmissionAuditState {
  if (!value || typeof value !== "object") return emptyEntryAdmissionAudit();
  const item = value as Record<string, unknown>;
  return {
    observed: count(item.observed),
    enterNow: count(item.enterNow),
    validEnterNow: count(item.validEnterNow),
    exactCandidatesRecorded: count(item.exactCandidatesRecorded),
    waiting: count(item.waiting),
    skipped: count(item.skipped),
    other: count(item.other),
    missingSignalIdentity: count(item.missingSignalIdentity),
    invalidCandidateMetadata: count(item.invalidCandidateMetadata),
    lastAtMs: isFiniteNumber(item.lastAtMs) ? item.lastAtMs : null,
    lastAction: nonEmpty(item.lastAction),
    lastCandidateStatus: nonEmpty(item.lastCandidateStatus),
    decisionIds: Array.isArray(item.decisionIds)
      ? item.decisionIds.map(nonEmpty).filter((id): id is string => id !== null).slice(-MAX_CANDIDATES)
      : [],
  };
}

export function fourBrainActualFillBindingFilePath(dataDir = "data"): string {
  return resolve(dataDir, "four-brain-actual-fill-bindings.json");
}

function emptyState(): FourBrainActualFillBindingState {
  return {
    version: VERSION,
    candidates: [],
    observedCandidates: [],
    bindings: [],
    entryAdmissionAudit: emptyEntryAdmissionAudit(),
    preEntryAdmissionAudit: emptyEntryAdmissionAudit(),
  };
}

function parseCandidate(value: unknown): FourBrainActualFillCandidate | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const decisionId = nonEmpty(item.decisionId);
  const laneId = nonEmpty(item.laneId);
  const symbol = nonEmpty(item.symbol);
  const signalId = nonEmpty(item.signalId);
  if (!decisionId || !laneId || !symbol || !signalId || !isFiniteNumber(item.asOfMs) || !isFiniteNumber(item.validUntilMs)) return null;
  if (item.side !== "LONG" && item.side !== "SHORT") return null;
  return {
    decisionId,
    asOfMs: item.asOfMs,
    validUntilMs: item.validUntilMs,
    laneId,
    symbol,
    side: item.side,
    signalId,
    expectedNetR: isFiniteNumber(item.expectedNetR) ? item.expectedNetR : null,
    canonicalRegimeFamily: canonical(item.canonicalRegimeFamily),
    scannerRegime: nonEmpty(item.scannerRegime),
    marketContextSnapshotId: nonEmpty(item.marketContextSnapshotId),
    // Pre-v4 candidate rows were scheduled-shadow observations. Preserve them for audit, but
    // do not let them causally attach to a later executor fill after this rollout.
    captureSource: item.captureSource === "PRE_ENTRY_EXECUTOR" ? "PRE_ENTRY_EXECUTOR" : "LEGACY_UNVERIFIED",
  };
}

function parseObservedExecutorDecision(value: unknown): FourBrainObservedExecutorDecision | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const base = parseCandidate(item);
  const action = entryAction(item.entryAction);
  const status = candidateStatus(item.candidateStatus);
  if (!base || !action || !status || !isFiniteNumber(item.recordedAtMs)) return null;
  return { ...base, entryAction: action, candidateStatus: status, recordedAtMs: item.recordedAtMs };
}

function decisionContext(
  executive: ExecutiveDecision,
  identity: { signalId: string | null },
  captureSource: FourBrainActualFillCandidate["captureSource"] = "LEGACY_UNVERIFIED",
): FourBrainActualFillCandidate | null {
  const entry = executive.entry;
  const decisionId = nonEmpty(executive.decisionId);
  const signalId = nonEmpty(identity.signalId);
  const laneId = nonEmpty(executive.laneId);
  const symbol = nonEmpty(executive.symbolOrBasketId);
  const side = entry?.side;
  if (!entry || !decisionId || !signalId || !laneId || !symbol || (side !== "LONG" && side !== "SHORT")) return null;
  if (!isFiniteNumber(executive.asOfMs) || !isFiniteNumber(entry.validUntilMs)) return null;
  return {
    decisionId,
    asOfMs: executive.asOfMs,
    validUntilMs: entry.validUntilMs,
    laneId,
    symbol,
    side,
    signalId,
    expectedNetR: isFiniteNumber(entry.expectedNetR) ? entry.expectedNetR : null,
    canonicalRegimeFamily: canonical(executive.marketState?.authority?.canonicalRegimeFamily),
    scannerRegime: nonEmpty(executive.marketState?.authority?.scannerRegime),
    marketContextSnapshotId: nonEmpty(executive.marketContext?.marketContextSnapshotId),
    captureSource,
  };
}

function parseBinding(value: unknown): FourBrainActualFillBinding | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const bindingKey = nonEmpty(item.bindingKey);
  const laneId = nonEmpty(item.laneId);
  const symbol = nonEmpty(item.symbol);
  const signalId = nonEmpty(item.signalId);
  if (!bindingKey || !laneId || !symbol || !signalId || !isFiniteNumber(item.openedAtMs)) return null;
  if (item.side !== "LONG" && item.side !== "SHORT") return null;
  if (item.source !== "ENGINE" && item.source !== "SINGLE_SYMBOL" && item.source !== "CROSS_SECTIONAL") return null;
  if (item.status !== "OPEN" && item.status !== "CLOSED_MEASURED" && item.status !== "CLOSED_UNMEASURED" && item.status !== "UNBOUND") return null;
  const decision = parseCandidate(item.decision);
  const observedDecision = parseObservedExecutorDecision(item.observedDecision);
  const parsedCohort = cohort(item.cohort);
  // v1/v2 direct bindings had no explicit cohort. Preserve only their original causal evidence;
  // never reinterpret historical UNBOUND rows as observed evidence after the fact.
  const bindingCohort = parsedCohort
    ?? (decision && item.status !== "UNBOUND" ? "FOUR_BRAIN_DIRECT" : observedDecision && item.status !== "UNBOUND" ? "EXECUTOR_OBSERVED" : null);
  return {
    bindingKey,
    source: item.source,
    laneId,
    symbol,
    side: item.side,
    signalId,
    openedAtMs: item.openedAtMs,
    entryPrice: isFiniteNumber(item.entryPrice) ? item.entryPrice : null,
    entryPriceConfirmed: item.entryPriceConfirmed === true,
    riskUsd: isFiniteNumber(item.riskUsd) && item.riskUsd > 0 ? item.riskUsd : null,
    decision: bindingCohort === "FOUR_BRAIN_DIRECT" ? decision : null,
    observedDecision: bindingCohort === "EXECUTOR_OBSERVED" ? observedDecision : null,
    cohort: bindingCohort,
    status: item.status,
    closedAtMs: isFiniteNumber(item.closedAtMs) ? item.closedAtMs : null,
    realizedNetR: isFiniteNumber(item.realizedNetR) ? item.realizedNetR : null,
    closeSettlementConfirmed: typeof item.closeSettlementConfirmed === "boolean" ? item.closeSettlementConfirmed : null,
    terminalReason: nonEmpty(item.terminalReason),
  };
}

function loadState(dataDir: string): FourBrainActualFillBindingState {
  const file = fourBrainActualFillBindingFilePath(dataDir);
  if (!existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    // v1/v2 had causal candidates/bindings already. Keep them intact and start the new
    // executor-observed cohort from zero rather than inventing historical observations.
    if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== VERSION) return emptyState();
    return {
      version: VERSION,
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates.map(parseCandidate).filter((item): item is FourBrainActualFillCandidate => item !== null) : [],
      observedCandidates: (parsed.version === 3 || parsed.version === VERSION) && Array.isArray(parsed.observedCandidates)
        ? parsed.observedCandidates.map(parseObservedExecutorDecision).filter((item): item is FourBrainObservedExecutorDecision => item !== null)
        : [],
      bindings: Array.isArray(parsed.bindings) ? parsed.bindings.map(parseBinding).filter((item): item is FourBrainActualFillBinding => item !== null) : [],
      entryAdmissionAudit: parsed.version === 1 ? emptyEntryAdmissionAudit() : parseEntryAdmissionAudit(parsed.entryAdmissionAudit),
      // v1-v3 aggregate periodic shadow-cycle evaluations. Preserve the audit facts, but never
      // relabel them as exact pre-order observations.
      preEntryAdmissionAudit: parsed.version === VERSION
        ? parseEntryAdmissionAudit(parsed.preEntryAdmissionAudit)
        : emptyEntryAdmissionAudit(),
    };
  } catch {
    return emptyState();
  }
}

/** Durable, exact identity store. Every mutating method is idempotent and never throws. */
export class FourBrainActualFillBindingStore {
  private state: FourBrainActualFillBindingState;

  constructor(private readonly dataDir = "data") {
    this.state = loadState(dataDir);
  }

  private save(): void {
    try {
      const file = fourBrainActualFillBindingFilePath(this.dataDir);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf8");
      renameSync(tmp, file);
    } catch {
      // Binding loss degrades to no Tier-1 learning; it may never interrupt a live order lifecycle.
    }
  }

  private prune(nowMs: number): void {
    const candidateCutoff = nowMs - CANDIDATE_RETENTION_MS;
    this.state.candidates = this.state.candidates
      .filter((candidate) => candidate.validUntilMs >= candidateCutoff)
      .slice(-MAX_CANDIDATES);
    this.state.observedCandidates = this.state.observedCandidates
      .filter((candidate) => candidate.validUntilMs >= candidateCutoff)
      .slice(-MAX_CANDIDATES);
    this.state.bindings = this.state.bindings.slice(-MAX_BINDINGS);
  }

  /** Record every entry decision once, before filtering it down to an exact eligible candidate. */
  private observeEntryAdmission(
    executive: ExecutiveDecision,
    identity: { signalId: string | null },
    audit: FourBrainEntryAdmissionAuditState,
  ): boolean {
    const entry = executive.entry;
    const decisionId = nonEmpty(executive.decisionId);
    if (!entry || !decisionId) return false;
    if (audit.decisionIds.includes(decisionId)) return false;
    audit.decisionIds.push(decisionId);
    if (audit.decisionIds.length > MAX_CANDIDATES) audit.decisionIds.splice(0, audit.decisionIds.length - MAX_CANDIDATES);
    audit.observed += 1;
    audit.lastAtMs = isFiniteNumber(executive.asOfMs) ? executive.asOfMs : null;
    audit.lastAction = nonEmpty(entry.action);
    audit.lastCandidateStatus = nonEmpty(executive.candidateStatus);
    if (entry.action === "ENTER_NOW") audit.enterNow += 1;
    else if (entry.action === "WAIT_PULLBACK" || entry.action === "WAIT_BREAKOUT" || entry.action === "WAIT_CONFIRMATION") audit.waiting += 1;
    else if (entry.action === "SKIP") audit.skipped += 1;
    else audit.other += 1;

    const validEnterNow = entry.action === "ENTER_NOW" && executive.candidateStatus === "VALID";
    if (!validEnterNow) return true;
    audit.validEnterNow += 1;
    const signalId = nonEmpty(identity.signalId);
    const laneId = nonEmpty(executive.laneId);
    const symbol = nonEmpty(executive.symbolOrBasketId);
    const side = entry.side;
    if (!signalId) audit.missingSignalIdentity += 1;
    if (!signalId || !laneId || !symbol || (side !== "LONG" && side !== "SHORT") || !isFiniteNumber(executive.asOfMs) || !isFiniteNumber(entry.validUntilMs)) {
      audit.invalidCandidateMetadata += 1;
    }
    return true;
  }

  /**
   * Capture every well-identified decision before an executor fill can happen, but keep two
   * intentionally separate cohorts:
   * - VALID ENTER_NOW: Four-Brain direct causal candidate, eligible for later reinforcement.
   * - every other action/status: executor-observed calibration context only.
   */
  observeExecutiveDecision(
    executive: ExecutiveDecision,
    identity: { signalId: string | null },
    options: { source?: "SCHEDULED_SHADOW" | "PRE_ENTRY_EXECUTOR" } = {},
  ): void {
    try {
      const audit = options.source === "PRE_ENTRY_EXECUTOR"
        ? this.state.preEntryAdmissionAudit
        : this.state.entryAdmissionAudit;
      const admissionObserved = this.observeEntryAdmission(executive, identity, audit);
      const isPreEntryExecutor = options.source === "PRE_ENTRY_EXECUTOR";
      const candidate = decisionContext(
        executive,
        identity,
        isPreEntryExecutor ? "PRE_ENTRY_EXECUTOR" : "LEGACY_UNVERIFIED",
      );
      const isDirect = executive.entry?.action === "ENTER_NOW" && executive.candidateStatus === "VALID";
      // A scheduled shadow tick can document its ENTER_NOW finding, but it was not attached to an
      // executor action. It must never be promoted to direct actual-fill evidence retroactively.
      if (candidate && isDirect && isPreEntryExecutor) {
        const index = this.state.candidates.findIndex((item) => item.decisionId === candidate.decisionId);
        if (index >= 0) this.state.candidates[index] = candidate;
        else this.state.candidates.push(candidate);
        if (admissionObserved) audit.exactCandidatesRecorded += 1;
        this.prune(candidate.asOfMs);
        this.save();
        return;
      }

      const action = entryAction(executive.entry?.action);
      const status = candidateStatus(executive.candidateStatus);
      if (candidate && action && status) {
        const observed: FourBrainObservedExecutorDecision = {
          ...candidate,
          entryAction: action,
          candidateStatus: status,
          recordedAtMs: Date.now(),
        };
        const index = this.state.observedCandidates.findIndex((item) => item.decisionId === observed.decisionId);
        if (index >= 0) this.state.observedCandidates[index] = observed;
        else this.state.observedCandidates.push(observed);
        this.prune(Math.max(observed.asOfMs, observed.recordedAtMs));
      }
      if (admissionObserved || candidate) this.save();
    } catch {
      // Shadow observation is optional; no side effects on the caller.
    }
  }

  /** Bind a confirmed executor entry to the latest still-valid decision with the SAME signal identity. */
  bindActualFill(input: BindActualFillInput): void {
    try {
      const bindingKey = nonEmpty(input.bindingKey);
      const laneId = nonEmpty(input.laneId);
      const symbol = nonEmpty(input.symbol);
      const signalId = nonEmpty(input.signalId);
      if (!bindingKey || !laneId || !symbol || !signalId || !isFiniteNumber(input.openedAtMs)) return;
      if (input.side !== "LONG" && input.side !== "SHORT") return;
      const existing = this.state.bindings.find((binding) => binding.bindingKey === bindingKey);
      if (existing) return;
      const identity = normalizedIdentity(laneId, symbol, input.side, signalId);
      const directCandidate = this.state.candidates
        .filter((item) => item.captureSource === "PRE_ENTRY_EXECUTOR")
        .filter((item) => normalizedIdentity(item.laneId, item.symbol, item.side, item.signalId) === identity)
        .filter((item) => item.asOfMs <= input.openedAtMs && item.validUntilMs >= input.openedAtMs)
        .sort((left, right) => right.asOfMs - left.asOfMs)[0] ?? null;
      // An observed context is only valid when it was durably recorded before the actual fill.
      // This makes a late shadow tick ineligible and prevents retrospective attribution.
      const observedCandidate = directCandidate ? null : this.state.observedCandidates
        .filter((item) => normalizedIdentity(item.laneId, item.symbol, item.side, item.signalId) === identity)
        .filter((item) => item.recordedAtMs <= input.openedAtMs && item.asOfMs <= input.openedAtMs && item.validUntilMs >= input.openedAtMs)
        .sort((left, right) => right.recordedAtMs - left.recordedAtMs)[0] ?? null;
      const bindingCohort: FourBrainActualFillCohort = directCandidate
        ? "FOUR_BRAIN_DIRECT"
        : observedCandidate ? "EXECUTOR_OBSERVED" : null;
      this.state.bindings.push({
        bindingKey,
        source: input.source,
        laneId,
        symbol,
        side: input.side,
        signalId,
        openedAtMs: input.openedAtMs,
        entryPrice: isFiniteNumber(input.entryPrice) && input.entryPrice > 0 ? input.entryPrice : null,
        entryPriceConfirmed: input.entryPriceConfirmed === true,
        riskUsd: isFiniteNumber(input.riskUsd) && input.riskUsd > 0 ? input.riskUsd : null,
        decision: directCandidate,
        observedDecision: observedCandidate,
        cohort: bindingCohort,
        status: bindingCohort ? "OPEN" : "UNBOUND",
        closedAtMs: null,
        realizedNetR: null,
        closeSettlementConfirmed: null,
        terminalReason: bindingCohort ? null : "NO_EXACT_EXECUTIVE_ENTER_NOW_AT_FILL",
      });
      this.prune(input.openedAtMs);
      this.save();
    } catch {
      // Direct-fill telemetry must never alter the order path.
    }
  }

  /** Complete an exact binding only from settled exchange economics. */
  completeActualFill(input: CompleteActualFillInput): void {
    try {
      const binding = this.state.bindings.find((item) => item.bindingKey === input.bindingKey);
      if (!binding || binding.status !== "OPEN") return;
      const closedAtMs = isFiniteNumber(input.closedAtMs) ? input.closedAtMs : Date.now();
      const measured =
        input.settlementConfirmed === true &&
        binding.entryPriceConfirmed === true &&
        isFiniteNumber(binding.riskUsd) && binding.riskUsd > 0 &&
        isFiniteNumber(input.netPnlUsd);
      binding.closedAtMs = closedAtMs;
      binding.closeSettlementConfirmed = input.settlementConfirmed === true;
      binding.realizedNetR = measured ? input.netPnlUsd! / binding.riskUsd! : null;
      binding.status = measured ? "CLOSED_MEASURED" : "CLOSED_UNMEASURED";
      binding.terminalReason = measured
        ? (input.reason ?? null)
        : (input.reason ?? "ACTUAL_FILL_SETTLEMENT_OR_RISK_UNCONFIRMED");
      this.prune(closedAtMs);
      this.save();
    } catch {
      // Closing settlement remains solely the executor's responsibility.
    }
  }

  listClosedMeasuredOutcomes(): DirectActualFillOutcome[] {
    return this.state.bindings.flatMap((binding) => {
      const d = binding.decision;
      if (!isPreEntryDirectBinding(binding) || !d || binding.status !== "CLOSED_MEASURED" || !isFiniteNumber(binding.realizedNetR)) return [];
      return [{
        decisionId: d.decisionId,
        laneId: d.laneId,
        symbolOrBasketId: d.symbol,
        side: d.side,
        asOfMs: d.asOfMs,
        expectedNetR: d.expectedNetR,
        realizedNetR: binding.realizedNetR,
        matchedCloseKey: `actual-fill:${binding.bindingKey}:${binding.openedAtMs}`,
        canonicalRegimeFamily: d.canonicalRegimeFamily,
        scannerRegime: d.scannerRegime,
        marketContextSnapshotId: d.marketContextSnapshotId,
      }];
    });
  }

  listClosedUnmeasuredOutcomes(): DirectActualFillUnmeasured[] {
    return this.state.bindings.flatMap((binding) => {
      const d = binding.decision;
      if (!isPreEntryDirectBinding(binding) || !d || binding.status !== "CLOSED_UNMEASURED") return [];
      return [{
        decisionId: d.decisionId,
        laneId: d.laneId,
        symbolOrBasketId: d.symbol,
        side: d.side,
        asOfMs: d.asOfMs,
        expectedNetR: d.expectedNetR,
        canonicalRegimeFamily: d.canonicalRegimeFamily,
        scannerRegime: d.scannerRegime,
        marketContextSnapshotId: d.marketContextSnapshotId,
        reason: binding.terminalReason ?? "ACTUAL_FILL_UNMEASURED",
      }];
    });
  }

  hasOpenBindingForDecisionId(decisionId: string): boolean {
    return this.state.bindings.some((binding) =>
      isPreEntryDirectBinding(binding) && binding.status === "OPEN" && binding.decision?.decisionId === decisionId,
    );
  }

  /**
   * Executor-owned actual fills observed in advance by Four-Brain. This is deliberately not
   * consumed by the outcome reconciler, readiness, ranking reinforcement, or the live bridge.
   */
  listClosedObservedExecutorOutcomes(): ObservedExecutorActualFillOutcome[] {
    return this.state.bindings.flatMap((binding) => {
      const d = binding.observedDecision;
      if (binding.cohort !== "EXECUTOR_OBSERVED" || !d || binding.status !== "CLOSED_MEASURED" || !isFiniteNumber(binding.realizedNetR)) return [];
      return [{
        decisionId: d.decisionId,
        laneId: d.laneId,
        symbolOrBasketId: d.symbol,
        side: d.side,
        action: d.entryAction,
        candidateStatus: d.candidateStatus,
        asOfMs: d.asOfMs,
        recordedAtMs: d.recordedAtMs,
        expectedNetR: d.expectedNetR,
        realizedNetR: binding.realizedNetR,
        matchedCloseKey: `executor-observed:${binding.bindingKey}:${binding.openedAtMs}`,
        canonicalRegimeFamily: d.canonicalRegimeFamily,
        scannerRegime: d.scannerRegime,
        marketContextSnapshotId: d.marketContextSnapshotId,
      }];
    });
  }

  getStatus(options: { sinceMs?: number | null } = {}): FourBrainActualFillBindingStoreStatus {
    const cohortSinceMs = isFiniteNumber(options.sinceMs) ? options.sinceMs : null;
    const inCohort = (atMs: number): boolean => cohortSinceMs === null || atMs >= cohortSinceMs;
    const counts = {
      candidates: this.state.candidates.filter((candidate) =>
        candidate.captureSource === "PRE_ENTRY_EXECUTOR" && inCohort(candidate.asOfMs),
      ).length,
      open: 0,
      measured: 0,
      unmeasured: 0,
      unbound: 0,
    };
    const lifecycle: FourBrainActualFillBindingStoreStatus["lifecycle"] = {
      lastDirectOpenAtMs: null,
      lastDirectMeasuredAtMs: null,
      lastDirectUnmeasuredAtMs: null,
      lastUnboundAtMs: null,
    };
    const executorObserved: FourBrainActualFillBindingStoreStatus["executorObserved"] = {
      candidates: this.state.observedCandidates.filter((candidate) => inCohort(candidate.asOfMs)).length,
      open: 0,
      measured: 0,
      unmeasured: 0,
      byEntryAction: {},
    };
    for (const candidate of this.state.observedCandidates) {
      if (!inCohort(candidate.asOfMs)) continue;
      executorObserved.byEntryAction[candidate.entryAction] = (executorObserved.byEntryAction[candidate.entryAction] ?? 0) + 1;
    }
    const auditOnlyBeforeCohort: FourBrainActualFillBindingStoreStatus["auditOnlyBeforeCohort"] = {
      bindings: 0,
      unbound: 0,
      lastUnboundAtMs: null,
    };
    for (const binding of this.state.bindings) {
      if (!inCohort(binding.openedAtMs)) {
        auditOnlyBeforeCohort.bindings += 1;
        if (binding.status === "UNBOUND" || binding.cohort === null) {
          auditOnlyBeforeCohort.unbound += 1;
          auditOnlyBeforeCohort.lastUnboundAtMs = Math.max(
            auditOnlyBeforeCohort.lastUnboundAtMs ?? 0,
            binding.closedAtMs ?? binding.openedAtMs,
          ) || null;
        }
        continue;
      }
      if (isPreEntryDirectBinding(binding)) {
        if (binding.status === "OPEN") {
          counts.open += 1;
          lifecycle.lastDirectOpenAtMs = Math.max(lifecycle.lastDirectOpenAtMs ?? 0, binding.openedAtMs) || null;
        } else if (binding.status === "CLOSED_MEASURED") {
          counts.measured += 1;
          lifecycle.lastDirectMeasuredAtMs = Math.max(lifecycle.lastDirectMeasuredAtMs ?? 0, binding.closedAtMs ?? binding.openedAtMs) || null;
        } else if (binding.status === "CLOSED_UNMEASURED") {
          counts.unmeasured += 1;
          lifecycle.lastDirectUnmeasuredAtMs = Math.max(lifecycle.lastDirectUnmeasuredAtMs ?? 0, binding.closedAtMs ?? binding.openedAtMs) || null;
        } else {
          counts.unbound += 1;
          lifecycle.lastUnboundAtMs = Math.max(lifecycle.lastUnboundAtMs ?? 0, binding.closedAtMs ?? binding.openedAtMs) || null;
        }
      } else if (binding.cohort === "EXECUTOR_OBSERVED") {
        if (binding.status === "OPEN") executorObserved.open += 1;
        else if (binding.status === "CLOSED_MEASURED") executorObserved.measured += 1;
        else if (binding.status === "CLOSED_UNMEASURED") executorObserved.unmeasured += 1;
      } else if (binding.cohort === "FOUR_BRAIN_DIRECT") {
        // Legacy direct-shaped rows are preserved in the on-disk audit but are intentionally
        // excluded from the new causal cohort. They are neither a new unbound fill nor evidence.
      } else {
        counts.unbound += 1;
        lifecycle.lastUnboundAtMs = Math.max(lifecycle.lastUnboundAtMs ?? 0, binding.closedAtMs ?? binding.openedAtMs) || null;
      }
    }
    const audit = this.state.entryAdmissionAudit;
    const preEntryAudit = this.state.preEntryAdmissionAudit;
    return {
      ...counts,
      executorObserved,
      entryAdmission: {
        observed: audit.observed,
        enterNow: audit.enterNow,
        validEnterNow: audit.validEnterNow,
        exactCandidatesRecorded: audit.exactCandidatesRecorded,
        waiting: audit.waiting,
        skipped: audit.skipped,
        other: audit.other,
        missingSignalIdentity: audit.missingSignalIdentity,
        invalidCandidateMetadata: audit.invalidCandidateMetadata,
        lastAtMs: audit.lastAtMs,
        lastAction: audit.lastAction,
        lastCandidateStatus: audit.lastCandidateStatus,
      },
      preEntryAdmission: {
        observed: preEntryAudit.observed,
        enterNow: preEntryAudit.enterNow,
        validEnterNow: preEntryAudit.validEnterNow,
        exactCandidatesRecorded: preEntryAudit.exactCandidatesRecorded,
        waiting: preEntryAudit.waiting,
        skipped: preEntryAudit.skipped,
        other: preEntryAudit.other,
        missingSignalIdentity: preEntryAudit.missingSignalIdentity,
        invalidCandidateMetadata: preEntryAudit.invalidCandidateMetadata,
        lastAtMs: preEntryAudit.lastAtMs,
        lastAction: preEntryAudit.lastAction,
        lastCandidateStatus: preEntryAudit.lastCandidateStatus,
      },
      lifecycle,
      auditOnlyBeforeCohort,
      cohortSinceMs,
    };
  }
}

const stores = new Map<string, FourBrainActualFillBindingStore>();

export function getFourBrainActualFillBindingStore(dataDir = "data"): FourBrainActualFillBindingStore {
  const key = resolve(dataDir);
  const existing = stores.get(key);
  if (existing) return existing;
  const store = new FourBrainActualFillBindingStore(dataDir);
  stores.set(key, store);
  return store;
}

export function _resetFourBrainActualFillBindingStoresForTests(): void {
  stores.clear();
}
