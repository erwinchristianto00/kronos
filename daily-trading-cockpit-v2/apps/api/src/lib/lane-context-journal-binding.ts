/**
 * Lane-context journal — impure binding (Track 1, Stage 2). Wires the PURE resolution processor + snapshot planner
 * into the runtime behind the default-OFF gate, with per-instance isolation, atomic checkpointing, bounded journal
 * rotation, and crash recovery. All filesystem access is injected (`JournalFs`) so every safety property is
 * testable; production passes real fs ops. This module NEVER mutates a paper order (beyond the already-approved
 * additive timestamp fields, which happen in the resolver, not here), edge-memory, allocation, beta, kill state,
 * or makes an execution call.
 *
 * Gate + isolation: activates ONLY when LANE_CONTEXT_JOURNAL_MODE==="shadow" AND the resolved instance is
 * 3101/3102. Live 3103 is hard-blocked by BOTH the resolved id AND the raw serving PORT; an unknown instance
 * FAILS CLOSED (no journal). Mode off / blocked / unknown ⇒ ZERO filesystem I/O for this feature.
 */
import { resolveFourBrainInstanceId, resolveFourBrainLogicalRole, FOUR_BRAIN_LIVE_INSTANCE_PORT, type FourBrainLogicalRole } from "./four-brain-live-gather-bindings.js";
import { resolveLaneContextMode, buildLaneContextSnapshot, type LaneContextSnapshot } from "./lane-context-journal.js";
import { planResolutions, parseCheckpoint, rebuildConsumedFromRecords, type ResolutionCheckpoint, type ClosedOutcomeInput, type ResolutionRecord } from "./lane-outcome-processor.js";
import { stableHash } from "./replay-provenance.js";

export interface LaneJournalActivation {
  /** ALWAYS the honest physical serving port — see FourBrainLogicalRole's own doc comment for why this
   *  must never be relabeled. laneJournalPaths below keys the journal DIRECTORY off this value, so a
   *  spoofed instanceId here would physically misplace a staging mirror's journal inside what looks
   *  like the real 3101/3102's own directory — exactly the bug this field's honesty prevents. */
  instanceId: string;
  logicalRole: FourBrainLogicalRole | null;
  active: boolean;
  reason: string;
  collectOnly: boolean;
}

/**
 * Explicit, default-OFF collect-only gate. This is the ONLY switch that lifts the live-3103 report-only-collection
 * block. It NEVER enables any authority: allocation/order/stop/kill/beta mutation live in other modules that stay
 * blocked; COLLECT_ONLY only permits append-only JOURNALING on the live box (the operator's hard rule
 * COLLECT_ONLY=true ⇒ REPORT_ONLY, CORTEX_LIVE_BETA=0). Accepts "1"/"true" (case-insensitive); anything else ⇒ OFF.
 */
export function resolveCollectOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.COLLECT_ONLY ?? "").toString().trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Resolve activation. 3101/3102 activate on shadow mode; an instance whose own physical id is outside
 * that pair activates ONLY under an explicit resolveFourBrainLogicalRole grant (2026-08-05 identity-
 * spoofing fix — instanceId is never relabeled to claim to be 3101/3102, see LaneJournalActivation's
 * own doc comment). Live 3103 stays HARD-blocked EXCEPT under an explicit COLLECT_ONLY flag, which
 * activates report-only collection ONLY (its own isolated "3103" journal namespace) — checked first,
 * against the physical id/port only, so no role grant can ever reach it.
 */
export function resolveLaneJournalActivation(env: NodeJS.ProcessEnv = process.env): LaneJournalActivation {
  const instanceId = resolveFourBrainInstanceId(env);
  const collectOnly = resolveCollectOnly(env);
  if (resolveLaneContextMode(env.LANE_CONTEXT_JOURNAL_MODE) !== "shadow") return { instanceId, logicalRole: null, active: false, reason: "mode-off", collectOnly };
  // Live 3103 (resolved id OR raw serving port): blocked by default; report-only collection ONLY under COLLECT_ONLY.
  if (instanceId === FOUR_BRAIN_LIVE_INSTANCE_PORT || (env.PORT ?? "").toString().trim() === FOUR_BRAIN_LIVE_INSTANCE_PORT) {
    if (collectOnly) return { instanceId: "3103", logicalRole: null, active: true, reason: "collect-only-3103", collectOnly: true };
    return { instanceId: "3103", logicalRole: null, active: false, reason: "live-3103-blocked", collectOnly };
  }
  if (instanceId === "3101" || instanceId === "3102") return { instanceId, logicalRole: null, active: true, reason: "shadow-active", collectOnly };
  const logicalRole = resolveFourBrainLogicalRole(env);
  if (logicalRole === null) return { instanceId, logicalRole: null, active: false, reason: "unknown-instance-fail-closed", collectOnly };
  return { instanceId, logicalRole, active: true, reason: "shadow-active", collectOnly };
}

export interface LaneJournalPaths { dir: string; resolutions: string; checkpoint: string; snapshots: string; }
/** Per-instance isolated paths — the canonical instance identity is IN the path, not just the cwd. */
export function laneJournalPaths(instanceId: string, baseDir: string): LaneJournalPaths {
  const dir = `${baseDir}/lane-context/${instanceId}`;
  return { dir, resolutions: `${dir}/resolutions.jsonl`, checkpoint: `${dir}/resolution-checkpoint.json`, snapshots: `${dir}/snapshots.jsonl` };
}

export interface JournalFs {
  ensureDir(dir: string): void;
  readText(path: string): string | null;
  writeAtomic(path: string, data: string): void; // tmp + rename
  appendLines(path: string, lines: string[]): void;
  readTailLines(path: string, maxLines: number): string[]; // bounded — reads active + rotated segments, newest-first
  rotateIfNeeded(path: string, maxBytes: number, keepTailLines: number): void; // rename active→segment when oversize
  /** Delete rotated segments FULLY older than `safeBeforeResolvedAtMs` (i.e. covered by the durable checkpoint).
   *  A segment whose newest record is ≥ the bound is RETAINED (recovery evidence). Optional — a fs without it
   *  simply never prunes (safe, just grows more). Returns segments deleted. */
  pruneCoveredSegments?(path: string, safeBeforeResolvedAtMs: number, resolvedAtMsOf: (line: string) => number | null): number;
}

/** Parse a JSONL tail: skip malformed lines, count them, return the valid records (with resolvedAtMs for recovery). */
export function parseJsonlTail(lines: string[]): { records: Array<{ outcomeId?: string; resolvedAtMs?: number }>; malformed: number } {
  const records: Array<{ outcomeId?: string; resolvedAtMs?: number }> = [];
  let malformed = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    try { records.push(JSON.parse(l)); } catch { malformed += 1; }
  }
  return { records, malformed };
}

export interface ValidationResult { ok: boolean; issues: string[]; }
/** Pre-append validation (spec §6). Ordering openedAt≤closedAt≤resolvedAt; finite ts; R finite-or-null; identity
 *  present; arithmetic net≈gross+cost within tolerance. Never fabricates — a violation is REPORTED, and the caller
 *  downgrades a violating record to a rejected status (never a gold label). */
export function validateResolutionRecord(r: ResolutionRecord, expectedInstanceId: string, tol = 1e-6): ValidationResult {
  const issues: string[] = [];
  const fin = (v: number | null | undefined) => typeof v === "number" && Number.isFinite(v);
  if (!fin(r.closedAtMs)) issues.push("closedAtMs-not-finite");
  if (!fin(r.resolvedAtMs)) issues.push("resolvedAtMs-not-finite");
  if (fin(r.openedAtMs) && fin(r.closedAtMs) && !(r.openedAtMs <= (r.closedAtMs as number))) issues.push("opened>closed");
  if (fin(r.closedAtMs) && fin(r.resolvedAtMs) && !((r.closedAtMs as number) <= r.resolvedAtMs)) issues.push("closed>resolved");
  for (const [k, v] of [["grossR", r.grossR], ["costR", r.costR], ["netR", r.netR]] as const) if (v != null && !fin(v)) issues.push(`${k}-not-finite`);
  if (!r.laneId || !r.symbolOrBasketId || !r.direction) issues.push("identity-missing");
  if (r.instanceId !== expectedInstanceId) issues.push("instance-mismatch");
  if (r.grossR != null && r.costR != null && r.netR != null && Math.abs(r.netR - (r.grossR + r.costR)) > tol) issues.push("arithmetic-mismatch");
  return { ok: issues.length === 0, issues };
}

export interface ScanMetrics {
  scansAttempted: number; scansCompleted: number; scansSkipped: number;
  outcomesScanned: number; planned: number; appended: number; deduped: number;
  rejectedByReason: Record<string, number>; checkpointLoads: number; checkpointCorrupt: number;
  checkpointWrites: number; checkpointWriteFailures: number; appendFailures: number; malformedJournalLines: number;
  /** SURFACED tripwires: the recovery tail did not reach below the floor (potential un-recovered gap), the
   *  consumed window exceeded maxConsumed, and outcomes seen strictly below the floor (delayed-persist detection). */
  recoveryTailInsufficient: number; consumedOverflow: number; belowFloorDetected: number;
}
export const emptyScanMetrics = (): ScanMetrics => ({ scansAttempted: 0, scansCompleted: 0, scansSkipped: 0, outcomesScanned: 0, planned: 0, appended: 0, deduped: 0, rejectedByReason: {}, checkpointLoads: 0, checkpointCorrupt: 0, checkpointWrites: 0, checkpointWriteFailures: 0, appendFailures: 0, malformedJournalLines: 0, recoveryTailInsufficient: 0, consumedOverflow: 0, belowFloorDetected: 0 });

export interface ResolutionScanDeps {
  env: NodeJS.ProcessEnv;
  baseDir: string;
  fs: JournalFs;
  nowMs: number;
  singleFlightGuard: { inFlight: boolean };
  readOutcomes: (sinceResolvedAtMs: number) => ClosedOutcomeInput[];
  decisionsFor: (o: ClosedOutcomeInput) => LaneContextSnapshot[];
  metrics: ScanMetrics;
  ttlMs: number;
  overlapWindowMs: number;
  /** Read strictly OLDER than the floor by this margin, so genuinely-late sub-floor outcomes reach the planner and
   *  are COUNTED (belowFloorDetected) instead of silently dropped. Planner floor stays at watermark − overlap. */
  detectionMarginMs: number;
  maxConsumed: number;
  recoverTailLines: number;
  journalMaxBytes: number;
}
export interface ScanResult { ran: boolean; reason: string; appended: number; corrupt: boolean; }

/**
 * One resolution scan. Order: gate → single-flight → load checkpoint → recover consumed from journal tail → read
 * bounded outcomes (watermark − overlap) → plan → validate → APPEND → only-then atomic checkpoint. Append failure
 * does NOT advance the checkpoint (outcome stays eligible). Fail-open throughout; never throws into the caller.
 */
export function runResolutionScan(deps: ResolutionScanDeps): ScanResult {
  const act = resolveLaneJournalActivation(deps.env);
  if (!act.active) return { ran: false, reason: act.reason, appended: 0, corrupt: false }; // ZERO fs I/O
  deps.metrics.scansAttempted += 1;
  if (deps.singleFlightGuard.inFlight) { deps.metrics.scansSkipped += 1; return { ran: false, reason: "in-flight", appended: 0, corrupt: false }; }
  deps.singleFlightGuard.inFlight = true;
  try {
    const paths = laneJournalPaths(act.instanceId, deps.baseDir);
    deps.fs.ensureDir(paths.dir);
    const parsed = parseCheckpoint(deps.fs.readText(paths.checkpoint), act.instanceId);
    deps.metrics.checkpointLoads += 1;
    if (parsed.corrupt) deps.metrics.checkpointCorrupt += 1;
    // recover consumed ids from the bounded journal tail (crash-after-append safety). Retain by resolvedAtMs ≥ floor
    // (NOT a count truncation), covering the whole reprocess window.
    const floor = parsed.checkpoint.highWatermarkResolvedAtMs - deps.overlapWindowMs;
    const tail = parseJsonlTail(deps.fs.readTailLines(paths.resolutions, deps.recoverTailLines));
    deps.metrics.malformedJournalLines += tail.malformed;
    const tailWithTs = tail.records.filter((r) => r.outcomeId && typeof r.resolvedAtMs === "number").map((r) => ({ outcomeId: r.outcomeId!, resolvedAtMs: r.resolvedAtMs! }));
    // SURFACE a potential un-recovered gap: the tail was full AND its oldest record is still ≥ floor ⇒ we may not
    // have read far enough back to cover the window.
    const oldestTail = tailWithTs.length ? Math.min(...tailWithTs.map((r) => r.resolvedAtMs)) : null;
    if (oldestTail != null && oldestTail >= floor && tail.records.length >= deps.recoverTailLines) deps.metrics.recoveryTailInsufficient += 1;
    const recovered = rebuildConsumedFromRecords(tailWithTs, floor);
    const mergedMap = new Map<string, number>();
    for (const c of parsed.checkpoint.consumed) if (c.r >= floor) mergedMap.set(c.id, c.r);
    for (const c of recovered) mergedMap.set(c.id, c.r);
    const checkpoint: ResolutionCheckpoint = { ...parsed.checkpoint, consumed: [...mergedMap].map(([id, r]) => ({ id, r })) };

    // Read from a strictly-OLDER bound than the floor so genuinely-late sub-floor outcomes reach the planner and are
    // counted (belowFloorDetected) rather than silently dropped. The planner floor stays at watermark − overlap.
    const outcomes = deps.readOutcomes(checkpoint.highWatermarkResolvedAtMs - deps.overlapWindowMs - deps.detectionMarginMs);
    deps.metrics.outcomesScanned += outcomes.length;
    const plan = planResolutions(outcomes, deps.decisionsFor, checkpoint, { ttlMs: deps.ttlMs, reprocessWindowMs: deps.overlapWindowMs, maxConsumed: deps.maxConsumed, instanceId: act.instanceId, nowMs: deps.nowMs });
    deps.metrics.planned += plan.emit.length;
    deps.metrics.belowFloorDetected += plan.metrics.skippedBelowWatermarkWindow;
    if (plan.metrics.consumedOverflow) deps.metrics.consumedOverflow += 1;

    // validate + tag; a validation failure downgrades to a rejected status (never gold), but is still recorded.
    const toAppend = plan.emit.map((rec) => {
      const v = validateResolutionRecord(rec, act.instanceId);
      if (!v.ok) { rec.attributionStatus = "UNSAFE_OUTCOME"; (rec as ResolutionRecord & { validationIssues?: string[] }).validationIssues = v.issues; }
      deps.metrics.rejectedByReason[rec.attributionStatus] = (deps.metrics.rejectedByReason[rec.attributionStatus] ?? 0) + (rec.attributionStatus === "ATTRIBUTED" ? 0 : 1);
      return rec;
    });

    if (toAppend.length > 0) {
      try {
        deps.fs.rotateIfNeeded(paths.resolutions, deps.journalMaxBytes, deps.recoverTailLines);
        deps.fs.appendLines(paths.resolutions, toAppend.map((r) => JSON.stringify(r)));
        deps.metrics.appended += toAppend.length;
      } catch {
        deps.metrics.appendFailures += 1;
        return { ran: true, reason: "append-failed-checkpoint-not-advanced", appended: 0, corrupt: parsed.corrupt }; // checkpoint NOT written
      }
    }
    // ONLY after a successful append: atomically advance the checkpoint.
    let checkpointCommitted = false;
    try { deps.fs.writeAtomic(paths.checkpoint, JSON.stringify(plan.nextCheckpoint)); deps.metrics.checkpointWrites += 1; checkpointCommitted = true; }
    catch { deps.metrics.checkpointWriteFailures += 1; } // fail open — next run re-reads the old checkpoint + recovers from journal
    // Prune rotated segments ONLY when the checkpoint is durably committed AND fully covers them (never before).
    if (checkpointCommitted && deps.fs.pruneCoveredSegments) {
      try {
        deps.fs.pruneCoveredSegments(paths.resolutions, plan.nextCheckpoint.highWatermarkResolvedAtMs - deps.overlapWindowMs, (line) => {
          try { const v = (JSON.parse(line) as { resolvedAtMs?: number }).resolvedAtMs; return typeof v === "number" ? v : null; } catch { return null; }
        });
      } catch { /* fail open — pruning is an optimization, never a correctness dependency */ }
      // Sibling snapshots journal: rotated the same way (rotateIfNeeded in journalLaneSnapshots) but was NEVER
      // pruned, so old segments accumulated on disk without bound for the lifetime of shadow mode. Mirror the
      // resolutions convention exactly, keyed off the snapshot's own `asOfMs` instead of `resolvedAtMs`: a
      // snapshot can only ever be ATTRIBUTED to an outcome whose openedAtMs is within `ttlMs` AFTER its asOfMs (see
      // attributeOutcome's TTL_EXPIRED check) — so once the checkpoint watermark shows every outcome up to
      // (watermark − overlap) has already been processed, any snapshot older than (watermark − overlap − ttlMs)
      // can no longer be attributed to a future resolution and is safe to drop.
      try {
        deps.fs.pruneCoveredSegments(paths.snapshots, plan.nextCheckpoint.highWatermarkResolvedAtMs - deps.overlapWindowMs - deps.ttlMs, (line) => {
          try { const v = (JSON.parse(line) as { asOfMs?: number }).asOfMs; return typeof v === "number" ? v : null; } catch { return null; }
        });
      } catch { /* fail open — pruning is an optimization, never a correctness dependency */ }
    }
    deps.metrics.scansCompleted += 1;
    return { ran: true, reason: "ok", appended: toAppend.length, corrupt: parsed.corrupt };
  } catch {
    return { ran: false, reason: "scan-error-failed-open", appended: 0, corrupt: false }; // never throws into the caller
  } finally {
    deps.singleFlightGuard.inFlight = false;
  }
}

// ── Forward-only snapshot tap ──────────────────────────────────────────────────────────────────
export interface LaneContextSnapshotInput {
  laneId: string; symbolOrBasketId: string; direction: "LONG" | "SHORT" | "BOTH" | "NEUTRAL";
  regimeFamily: string | null; axisScore: number | null; transitionRisk: number | null;
  longEdge: number | null; shortEdge: number | null; edgeMemory: number | null; edgeMemoryN: number | null;
  conviction: number | null; controllerMode: string | null; incumbentEligible: boolean; vetoed: boolean; vetoReason: string | null;
  staticWeightPct: number; cortexFinalPct: number | null; sourceStatuses: Record<string, "FRESH" | "STALE" | "MISSING" | "ERROR">;
}
/** Deterministic snapshot id — stable per (instance, asOf, lane, symbol, direction, schema). */
export function snapshotIdFor(instanceId: string, asOfMs: number, laneId: string, symbolOrBasketId: string, direction: string, schemaVersion: string): string {
  return stableHash([instanceId, asOfMs, laneId, symbolOrBasketId, direction, schemaVersion]).slice(0, 32);
}
export interface SnapshotBatchResult { ok: boolean; reason: string; snapshots: Array<LaneContextSnapshot & { snapshotId: string }>; }

/**
 * Build the decision-tick snapshot batch from the CURRENT in-memory context. Values are captured as-provided
 * (buildLaneContextSnapshot never reads a store), so a later edge-memory mutation cannot alter a recorded
 * snapshot. Every active incumbent lane appears exactly once — a DUPLICATE lane identity rejects the WHOLE batch
 * (fail-safe, no partial write). Unknown/unsupported lanes stay visible (via sourceStatuses/incumbentEligible),
 * never dropped.
 */
export function planSnapshotBatch(instanceId: string, asOfMs: number, lanes: LaneContextSnapshotInput[]): SnapshotBatchResult {
  const seen = new Set<string>();
  for (const l of lanes) {
    const key = `${l.laneId}|${l.symbolOrBasketId}|${l.direction}`;
    if (seen.has(key)) return { ok: false, reason: `duplicate-lane:${key}`, snapshots: [] };
    seen.add(key);
  }
  const snapshots = lanes.map((l) => {
    const decisionId = snapshotIdFor(instanceId, asOfMs, l.laneId, l.symbolOrBasketId, l.direction, "lane-context-1");
    return { ...buildLaneContextSnapshot({ decisionId, asOfMs, instanceId, ...l }), snapshotId: decisionId };
  });
  return { ok: true, reason: "ok", snapshots };
}
