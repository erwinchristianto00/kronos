/**
 * Lane-context journal — production runtime glue (Track 1, Stage 2 call-sites). Holds the per-process singletons
 * (production fs, single-flight, metrics, lazy writer-lock) and the paper-order→outcome adapter, and exposes the
 * three call-site entry points as one-liners: `runLaneResolutionScan`, `journalLaneSnapshots`,
 * `recordExecLifecycle`. EVERY entry point is fail-open (never throws into the caller) and does ZERO filesystem
 * I/O when mode is off / instance blocked. Nothing here mutates a paper order, edge-memory, allocation, beta,
 * position, stop, or kill state, or makes an execution call.
 */
import { createProductionJournalFs } from "./lane-context-journal-fs.js";
import { runResolutionScan, resolveLaneJournalActivation, laneJournalPaths, emptyScanMetrics, planSnapshotBatch, parseJsonlTail, type ScanMetrics, type LaneContextSnapshotInput } from "./lane-context-journal-binding.js";
import { type ClosedOutcomeInput } from "./lane-outcome-processor.js";
import { LANE_CONTEXT_SCHEMA_VERSION, type LaneContextSnapshot } from "./lane-context-journal.js";
import { recordLifecycle, isLifecycleLoggingEnabled, type ExecutionLifecycleEvent } from "./execution-lifecycle-log.js";

/** Base journal dir, read lazily from the env each call (default "data") so the same singleton is redirectable in
 *  tests and responds to a per-invocation env — behaviour-identical to a constant in production (env=process.env). */
const baseDir = (env: NodeJS.ProcessEnv = process.env): string => (env.LANE_CONTEXT_JOURNAL_DIR ?? "data").toString();
const CONFIG = { ttlMs: 30 * 60_000, overlapWindowMs: 10 * 60_000, detectionMarginMs: 10 * 60_000, maxConsumed: 50_000, recoverTailLines: 50_000, journalMaxBytes: 8 * 1024 * 1024 };
// Must cover the longest lane hold in current-guard-variant-matrix.ts (CG_WIDE_LONG_RUNNER, maxHoldHours=144 ⇒
// 6 days) — the pre-open snapshot for a max-held trade is still ~6 days old by the time resolution runs. At the
// snapshot tick cadence (5min, app.ts) x ~13-16 lanes/tick, 6 days ≈ 288*6*16 ≈ 27.6k lines; 50k (same bound as
// CONFIG.recoverTailLines) leaves ~1.8x headroom for lane-count growth without scrolling the entry decision out.
const SNAPSHOT_LOOKBACK_LINES = 50_000;

const prod = createProductionJournalFs();
const scanSingleFlight = { inFlight: false };
/** scanMetrics + the snapshot-tail tripwire, both surfaced together as one metrics object. */
interface RuntimeScanMetrics extends ScanMetrics {
  /** Snapshot tail hit SNAPSHOT_LOOKBACK_LINES (capped) AND its oldest record is still not older than the
   *  outcome's openedAtMs ⇒ the true pre-open decision may sit further back than this read reached — mirrors
   *  the resolutions journal's `recoveryTailInsufficient` tripwire for the snapshot journal. */
  snapshotTailInsufficient: number;
}
export const scanMetrics: RuntimeScanMetrics = { ...emptyScanMetrics(), snapshotTailInsufficient: 0 };
export const snapshotMetrics = { ticks: 0, lanes: 0, duplicateBatches: 0, journalErrors: 0, writeLatencyMsTotal: 0 };
export const lifecycleMetrics = { events: 0, byEvent: {} as Record<string, number>, journalErrors: 0 };
let writerLockOk = false;
// null ⇒ never failed (either never checked yet, or the last check succeeded). A genuine acquisition is cached
// forever (no re-check needed); only a FAILURE is retried, after this cooldown, so a transient boot-time fault
// (data dir not yet mounted, momentary permission error) doesn't permanently disable journaling for the process's
// entire uptime once the underlying condition clears.
let writerLockLastFailedAtMs: number | null = null;
const WRITER_LOCK_RETRY_COOLDOWN_MS = 5 * 60_000;

/** True when the lane-context journal is armed for this instance (shadow mode + 3101/3102) — used to gate the
 * snapshot ticker's registration. `journalLaneSnapshots` re-checks internally, so this is belt-and-suspenders. */
export function laneJournalActive(env: NodeJS.ProcessEnv = process.env): boolean {
  try { return resolveLaneJournalActivation(env).active; } catch { return false; }
}

/** Test hook — reset the per-process singletons so integration tests start clean. */
export function _resetLaneRuntimeForTests(): void {
  writerLockOk = false; writerLockLastFailedAtMs = null; scanSingleFlight.inFlight = false;
  Object.assign(scanMetrics, emptyScanMetrics(), { snapshotTailInsufficient: 0 });
  Object.assign(snapshotMetrics, { ticks: 0, lanes: 0, duplicateBatches: 0, journalErrors: 0, writeLatencyMsTotal: 0 });
  Object.assign(lifecycleMetrics, { events: 0, byEvent: {}, journalErrors: 0 });
}

/** Loose paper-order shape (only the fields the adapter reads). */
export interface PaperOrderLike {
  paperOrderId: string; selectedLaneId?: string; symbol?: string; direction?: "LONG" | "SHORT";
  paperStatus: string; openedAt?: string; closedAtMs?: number | null; resolvedAtMs?: number | null;
  grossR?: number | null; costR?: number | null; netR?: number | null; closeReason?: string | null; closeIntrabarAmbiguous?: boolean;
}
function toClosedOutcome(o: PaperOrderLike): ClosedOutcomeInput {
  const terminal = o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS";
  const openedAtMs = o.openedAt ? Date.parse(o.openedAt) : NaN;
  return {
    outcomeId: o.paperOrderId, laneId: o.selectedLaneId ?? "?", symbolOrBasketId: o.symbol ?? "?", direction: o.direction ?? "LONG",
    openedAtMs: Number.isFinite(openedAtMs) ? openedAtMs : 0,
    closedAtMs: typeof o.closedAtMs === "number" ? o.closedAtMs : null, // PERSISTED market close ts (Track 1a) — never a draft
    resolvedAtMs: typeof o.resolvedAtMs === "number" ? o.resolvedAtMs : null,
    grossR: o.grossR ?? null, costR: o.costR ?? null, netR: o.netR ?? null,
    closeReason: o.closeReason ?? null, closeIntrabarAmbiguous: o.closeIntrabarAmbiguous ?? false,
    featureSchemaVersion: LANE_CONTEXT_SCHEMA_VERSION, terminal,
  };
}

function ensureWriterLock(dir: string, instanceId: string, nowMs: number): boolean {
  if (writerLockOk) return true; // genuinely acquired ⇒ never needs re-checking
  if (writerLockLastFailedAtMs != null && nowMs - writerLockLastFailedAtMs < WRITER_LOCK_RETRY_COOLDOWN_MS) return false;
  try { prod.fs.ensureDir(dir); prod.cleanupStaleTemp(dir); writerLockOk = prod.acquireWriterLock(dir, instanceId, nowMs).acquired; }
  catch { writerLockOk = false; }
  writerLockLastFailedAtMs = writerLockOk ? null : nowMs;
  return writerLockOk;
}

/** Read recent lane-context snapshots from the snapshot journal for attribution (identity-filtered by the caller). */
function snapshotDecisionsFor(paths: ReturnType<typeof laneJournalPaths>, o: ClosedOutcomeInput): LaneContextSnapshot[] {
  try {
    const rawLines = prod.fs.readTailLines(paths.snapshots, SNAPSHOT_LOOKBACK_LINES);
    const parsed = parseJsonlTail(rawLines);
    const records = parsed.records as unknown as LaneContextSnapshot[];
    // SURFACE a potential un-recovered gap: the tail hit the line cap (more history may exist beyond it) AND its
    // oldest record is still not older than the outcome's open time ⇒ a matching pre-open decision could sit
    // further back than this read reached — mirrors runResolutionScan's recoveryTailInsufficient tripwire.
    if (rawLines.length >= SNAPSHOT_LOOKBACK_LINES) {
      const oldestAsOf = records.reduce<number | null>((min, r) => (r && Number.isFinite(r.asOfMs) ? (min == null ? r.asOfMs : Math.min(min, r.asOfMs)) : min), null);
      if (oldestAsOf != null && oldestAsOf >= o.openedAtMs) scanMetrics.snapshotTailInsufficient += 1;
    }
    return records.filter((s) => s && s.laneId === o.laneId && s.symbolOrBasketId === o.symbolOrBasketId && s.direction === o.direction);
  } catch { return []; }
}

/**
 * RESOLUTION call-site: invoke AFTER `resolvePaperOrders` has persisted terminal transitions. Observes the
 * persisted `closedAtMs`/`resolvedAtMs`; never mutates an order; fail-open (a throw is swallowed → the resolver is
 * unaffected). Cheap + idempotent per cycle: mode off / blocked instance → zero I/O + no timer.
 */
export function runLaneResolutionScan(orders: PaperOrderLike[], nowMs: number, env: NodeJS.ProcessEnv = process.env): { ran: boolean; reason: string } {
  try {
    const act = resolveLaneJournalActivation(env);
    if (!act.active) return { ran: false, reason: act.reason }; // ZERO I/O
    const dir = baseDir(env);
    const paths = laneJournalPaths(act.instanceId, dir);
    if (!ensureWriterLock(paths.dir, act.instanceId, nowMs)) { scanMetrics.scansSkipped += 1; return { ran: false, reason: "writer-lock-unavailable" }; }
    const closedOutcomes = orders.map(toClosedOutcome);
    const r = runResolutionScan({
      env, baseDir: dir, fs: prod.fs, nowMs, singleFlightGuard: scanSingleFlight,
      readOutcomes: (since) => closedOutcomes.filter((o) => o.resolvedAtMs == null || o.resolvedAtMs >= since),
      decisionsFor: (o) => snapshotDecisionsFor(paths, o), metrics: scanMetrics, ...CONFIG,
    });
    return { ran: r.ran, reason: r.reason };
  } catch { return { ran: false, reason: "runtime-failed-open" }; } // NEVER throws into the resolver
}

/**
 * SNAPSHOT call-site: invoke at the decision tick with the CURRENT in-memory lane context (all active incumbent
 * lanes). Values are frozen as-captured. A duplicate lane identity rejects the batch (no partial write). Fail-open
 * + independent journal — a snapshot failure cannot suppress resolution, and vice versa.
 */
export function journalLaneSnapshots(asOfMs: number, lanes: LaneContextSnapshotInput[], env: NodeJS.ProcessEnv = process.env): { ran: boolean; reason: string; count: number } {
  try {
    const act = resolveLaneJournalActivation(env);
    if (!act.active) return { ran: false, reason: act.reason, count: 0 }; // ZERO I/O
    const paths = laneJournalPaths(act.instanceId, baseDir(env));
    if (!ensureWriterLock(paths.dir, act.instanceId, nowMsSafe(asOfMs))) return { ran: false, reason: "writer-lock-unavailable", count: 0 };
    const batch = planSnapshotBatch(act.instanceId, asOfMs, lanes);
    if (!batch.ok) { snapshotMetrics.duplicateBatches += 1; return { ran: false, reason: batch.reason, count: 0 }; }
    try {
      prod.fs.rotateIfNeeded(paths.snapshots, CONFIG.journalMaxBytes, CONFIG.recoverTailLines);
      prod.fs.appendLines(paths.snapshots, batch.snapshots.map((s) => JSON.stringify(s)));
      snapshotMetrics.ticks += 1; snapshotMetrics.lanes += batch.snapshots.length;
    } catch { snapshotMetrics.journalErrors += 1; return { ran: false, reason: "snapshot-append-failed-open", count: 0 }; }
    return { ran: true, reason: "ok", count: batch.snapshots.length };
  } catch { return { ran: false, reason: "runtime-failed-open", count: 0 }; }
}
const nowMsSafe = (fallback: number): number => (Number.isFinite(fallback) ? fallback : 0);

/**
 * LIFECYCLE call-site: invoke at a natural order-lifecycle point. Default-OFF (`EXEC_LIFECYCLE_TIMESTAMPS=1`),
 * fail-open, synchronous, no exchange call, no mutation. Blocked on live 3103 (via the activation gate) even if
 * the lifecycle flag is on. Local (`eventAtMs`) + exchange (`exchangeEventAtMs`) timestamps kept separate.
 */
export function recordExecLifecycle(rec: Omit<ExecutionLifecycleEvent, "schemaVersion" | "instanceId">, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (!isLifecycleLoggingEnabled(env)) return false; // default-OFF ⇒ zero I/O
    // Reuse the single activation gate (lifecycle has its own enable flag, so synth-inject shadow mode if unset).
    // `act.active` encodes the whole rule: 3101/3102 shadow, OR live 3103 ONLY under COLLECT_ONLY (report-only);
    // mode-off / plain-3103-blocked / unknown-instance are all inactive ⇒ we return false. Authority is untouched:
    // this only appends a journal line — proven not to alter the real-money order path (authority-spy test).
    const act = resolveLaneJournalActivation(env.LANE_CONTEXT_JOURNAL_MODE ? env : { ...env, LANE_CONTEXT_JOURNAL_MODE: "shadow" });
    if (!act.active) return false;
    if (act.instanceId !== "3101" && act.instanceId !== "3102" && act.instanceId !== "3103") return false; // belt: only known instances
    const paths = laneJournalPaths(act.instanceId, baseDir(env));
    // Same writer-lock gate as the resolution + snapshot call-sites — a concurrent second process for this
    // instanceId (pm2 restart race, crash zombie) must be SURFACED (refuse to write), not silently interleaved.
    if (!ensureWriterLock(paths.dir, act.instanceId, nowMsSafe(rec.eventAtMs))) return false;
    const lifecyclePath = `${paths.dir}/lifecycle.jsonl`;
    const wrote = recordLifecycle(
      // Rotation-bounded JSONL append (same discipline as the snapshot journal) so lifecycle.jsonl cannot grow
      // unbounded across a long measurement window — consistent with every sibling journal in this subsystem.
      (ev) => { try { prod.fs.ensureDir(paths.dir); prod.fs.rotateIfNeeded(lifecyclePath, CONFIG.journalMaxBytes, CONFIG.recoverTailLines); prod.fs.appendLines(lifecyclePath, [JSON.stringify({ ...ev, instanceId: act.instanceId })]); } catch { lifecycleMetrics.journalErrors += 1; throw new Error("append-failed"); } },
      { ...rec, instanceId: act.instanceId },
      { enabled: true }, // gate already checked above
    );
    if (wrote) { lifecycleMetrics.events += 1; lifecycleMetrics.byEvent[rec.event] = (lifecycleMetrics.byEvent[rec.event] ?? 0) + 1; }
    return wrote;
  } catch { return false; } // NEVER throws into the execution path
}
