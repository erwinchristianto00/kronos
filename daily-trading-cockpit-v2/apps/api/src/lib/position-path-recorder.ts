/**
 * DENSE PER-TICK R-PATH RECORDER (2026-07-22, REPORT-ONLY).
 *
 * WHY: exit-brain-shadow.ts's 2026-07-21 inventory found NO store persists a dense per-tick R
 * path for any trade — LiveIntent keeps only timestampless maxFavorableR/maxAdverseR peaks and
 * ShadowPosition a 4-point skeleton — so its counterfactual evaluator (which needs
 * ≥ minEvaluableTicks recorded ticks to walk a retrace policy honestly) classifies essentially
 * every resolved trade INSUFFICIENT_PATH_DATA. This module records the missing data: one
 * {t: epochMs, r: signed mark-R} sample per engine/executor tick for every OPEN position, and a
 * bounded handoff buffer of CLOSED paths for the Exit Brain shadow sweep to consume.
 *
 * WRITERS (both optional-injection, absent ⇒ byte-for-byte old behavior):
 *   - live-execution-engine.ts manageLifecycle(): one tick per OPEN intent per engine tick
 *     (key `intent:<paperOrderId>:<createdAt>` — same identity scheme as the CORTEX real
 *     attribution sweep), marked closed by a per-tick sweep over terminal intents.
 *   - single-symbol-lane-executor.ts monitorOpenPositions(): one tick per OPEN position per
 *     executor tick (key `ssle:<laneId>:<positionId>`), marked closed at both close
 *     finalizations (stop-fill settle + policy/manual close).
 *
 * HARD SAFETY RULE (same as cortex-real-attribution.ts): this is bookkeeping about trading,
 * never part of it. Every public method is wrapped so it never throws into a caller; a corrupt
 * or unwritable store degrades to "path recording restarts", never to a trading effect.
 *
 * BOUNDS + THINNING (all caps hard):
 *   - ≤ MAX_TICKS_PER_POSITION (600) ticks per position. At the engine's ~25s tick cadence that
 *     is ~4h of fully dense history. When an append would exceed the cap, the OLDER HALF of the
 *     buffer is decimated in place — every 2nd tick of the first 300 is kept (index 0, the entry
 *     observation, always survives), freeing 150 slots while the newest 300 ticks stay dense.
 *     Each further overflow halves progressively older history again (geometric coarsening), so
 *     a multi-day position keeps a recent dense window plus an ever-coarser long tail — exactly
 *     the shape a retrace policy needs (recent retraces matter most).
 *   - ≤ MAX_OPEN_POSITIONS (200) concurrently tracked positions. A NEW key past the cap is
 *     dropped (recordTick returns false) rather than evicting a live path; pruneExpired() drops
 *     open paths with no tick for STALE_OPEN_MS so leaked keys (crashed writers) cannot pin the
 *     cap forever.
 *   - ≤ MAX_CLOSED_PATHS (300) closed paths retained newest-last (FIFO) as the handoff window
 *     for the Exit Brain shadow sweep (which books each tradeId exactly once, so a path only
 *     needs to survive until the next 7-min sweep — 300/14d is generous); pruneExpired() also
 *     drops closed paths older than CLOSED_RETENTION_MS.
 *
 * Persistence follows the repo's hardened store idiom: compact JSON, atomic tmp+rename, bounded
 * state, corrupt file ⇒ empty restart. `deferSave` + flush() batches a whole tick's appends into
 * one write; flush() is a no-op while clean, so idle ticks cost nothing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { ExitBrainPathTick } from "./exit-brain-policy.js";
import type { ExitBrainResolvedTrade } from "./exit-brain-shadow.js";

/** Hard per-position tick cap — see the header's thinning note. */
export const MAX_TICKS_PER_POSITION = 600;
/** Hard cap on concurrently tracked OPEN positions. */
export const MAX_OPEN_POSITIONS = 200;
/** Closed-path handoff window (newest-last FIFO). */
export const MAX_CLOSED_PATHS = 300;
/** An OPEN path with no tick for this long is presumed leaked (writer crashed/restarted without
 *  ever marking it closed) and dropped by pruneExpired() — its close was never observed, so it
 *  must NOT be offered as a resolved trade. */
export const STALE_OPEN_MS = 48 * 3_600_000;
/** Closed paths older than this are dropped by pruneExpired() even below the FIFO cap. */
export const CLOSED_RETENTION_MS = 14 * 24 * 3_600_000;

/** Compact persisted tick: t = epoch ms, r = signed current R (favorable positive), rounded to
 *  4 decimals — sub-0.0001R resolution is noise and would only bloat the JSON. */
export interface PositionPathTick {
  t: number;
  r: number;
}

export interface PositionPathMeta {
  laneId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  /** Stable source-signal identity. Optional so historical path files remain readable. */
  signalId?: string | null;
  /** Which writer recorded this path (documents the R convention of closeR — see markClosed). */
  source: "engine" | "executor";
}

export interface PositionPath {
  key: string;
  /** Frozen from the FIRST recordTick that supplied it; null only for legacy/degenerate rows —
   *  the exit-brain adapter skips meta-less paths rather than fabricating identity. */
  meta: PositionPathMeta | null;
  /** Chronological (non-decreasing t), bounded by MAX_TICKS_PER_POSITION via thinning. */
  ticks: PositionPathTick[];
  /** Raw ticks ever offered (pre-thinning, pre-out-of-order-drop) — honest density evidence. */
  rawTickCount: number;
  /** How many older-half decimation passes have run on this path. */
  thinned: number;
  closedAtMs: number | null;
  /** Final R at close. Writer-supplied when computable (engine: realizedPnlUsd/effectiveRiskUsd,
   *  i.e. NET realized R; executor: mark-R at the confirmed exit price, i.e. RAW R — document per
   *  binding, same convention note as exit-brain-shadow's reader), else the last tick's r. */
  closeR: number | null;
}

interface PositionPathRecorderState {
  version: number;
  open: Record<string, PositionPath>;
  /** Newest-last, bounded to MAX_CLOSED_PATHS. */
  closed: PositionPath[];
}

function emptyState(): PositionPathRecorderState {
  return { version: 1, open: {}, closed: [] };
}

function roundR(r: number): number {
  return Math.round(r * 1e4) / 1e4;
}

/** Older-half decimation (see header): keeps every 2nd tick of the older half (index 0 always),
 *  the entire newer half untouched. Pure; exported for tests. */
export function thinOlderHalf(ticks: PositionPathTick[]): PositionPathTick[] {
  const half = Math.floor(ticks.length / 2);
  const keptOld: PositionPathTick[] = [];
  for (let i = 0; i < half; i += 2) keptOld.push(ticks[i]!);
  return [...keptOld, ...ticks.slice(half)];
}

function sanitizeMeta(raw: unknown): PositionPathMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<PositionPathMeta>;
  if (
    typeof m.laneId !== "string" ||
    typeof m.symbol !== "string" ||
    (m.direction !== "LONG" && m.direction !== "SHORT") ||
    (m.source !== "engine" && m.source !== "executor")
  ) {
    return null;
  }
  return {
    laneId: m.laneId,
    symbol: m.symbol,
    direction: m.direction,
    ...(typeof m.signalId === "string" && m.signalId.length > 0 ? { signalId: m.signalId } : {}),
    source: m.source,
  };
}

function sanitizePath(raw: unknown): PositionPath | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<PositionPath>;
  if (typeof p.key !== "string" || p.key.length === 0 || !Array.isArray(p.ticks)) return null;
  const ticks = (p.ticks as unknown[])
    .filter((t): t is PositionPathTick => {
      if (!t || typeof t !== "object") return false;
      const tick = t as Partial<PositionPathTick>;
      return Number.isFinite(tick.t) && Number.isFinite(tick.r);
    })
    .slice(-MAX_TICKS_PER_POSITION);
  return {
    key: p.key,
    meta: sanitizeMeta(p.meta),
    ticks,
    rawTickCount: Number.isFinite(p.rawTickCount) ? Math.max(ticks.length, Math.floor(p.rawTickCount as number)) : ticks.length,
    thinned: Number.isFinite(p.thinned) ? Math.max(0, Math.floor(p.thinned as number)) : 0,
    closedAtMs: Number.isFinite(p.closedAtMs) ? (p.closedAtMs as number) : null,
    closeR: Number.isFinite(p.closeR) ? (p.closeR as number) : null,
  };
}

export class PositionPathRecorder {
  private readonly file: string;
  private state: PositionPathRecorderState;
  private dirty = false;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "position-paths.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
  }

  get path(): string {
    return this.file;
  }

  private _load(): PositionPathRecorderState {
    try {
      if (!existsSync(this.file)) return emptyState();
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
      if (parsed && typeof parsed === "object" && typeof (parsed as { open?: unknown }).open === "object") {
        const raw = parsed as Partial<PositionPathRecorderState>;
        const open: Record<string, PositionPath> = {};
        for (const value of Object.values(raw.open ?? {})) {
          const path = sanitizePath(value);
          if (path && path.closedAtMs === null && Object.keys(open).length < MAX_OPEN_POSITIONS) open[path.key] = path;
        }
        const closed = (Array.isArray(raw.closed) ? raw.closed : [])
          .map(sanitizePath)
          .filter((p): p is PositionPath => p !== null && p.closedAtMs !== null)
          .slice(-MAX_CLOSED_PATHS);
        return { version: 1, open, closed };
      }
    } catch {
      // corrupt/partial — restart from empty; path recording restarts, trading unaffected
    }
    return emptyState();
  }

  /** Visible for tests. */
  getState(): PositionPathRecorderState {
    return this.state;
  }

  isTrackingOpen(key: string): boolean {
    try {
      return typeof key === "string" && key in this.state.open;
    } catch {
      return false;
    }
  }

  /** Append one (tsMs, currentR) sample to the position's open path. Never throws. Returns true
   *  only when the tick was actually appended: silently drops non-finite inputs, out-of-order
   *  timestamps (tsMs < last tick's t), and NEW keys past MAX_OPEN_POSITIONS. `meta` is frozen
   *  from the first call that supplies it. */
  recordTick(
    key: string,
    tsMs: number,
    currentR: number,
    opts?: { meta?: PositionPathMeta; deferSave?: boolean },
  ): boolean {
    try {
      if (typeof key !== "string" || key.length === 0) return false;
      if (!Number.isFinite(tsMs) || !Number.isFinite(currentR)) return false;
      let path = this.state.open[key];
      if (!path) {
        if (Object.keys(this.state.open).length >= MAX_OPEN_POSITIONS) return false;
        path = { key, meta: sanitizeMeta(opts?.meta), ticks: [], rawTickCount: 0, thinned: 0, closedAtMs: null, closeR: null };
        this.state.open[key] = path;
      } else if (path.meta === null && opts?.meta) {
        path.meta = sanitizeMeta(opts.meta);
      }
      path.rawTickCount += 1;
      const last = path.ticks[path.ticks.length - 1];
      if (last && tsMs < last.t) return false; // out-of-order — chronology is the reader's contract
      path.ticks.push({ t: tsMs, r: roundR(currentR) });
      if (path.ticks.length > MAX_TICKS_PER_POSITION) {
        path.ticks = thinOlderHalf(path.ticks);
        path.thinned += 1;
      }
      this.dirty = true;
      if (!opts?.deferSave) this._save();
      return true;
    } catch {
      return false; // report-only bookkeeping never throws into a trading path
    }
  }

  /** Move an open path into the bounded closed handoff buffer. No-op (false, no write) for keys
   *  not currently tracked — callers may sweep every terminal position idempotently. `finalR`
   *  documents the close in the writer's own R convention (see PositionPath.closeR); absent, the
   *  last recorded tick's r stands in. Never throws. */
  markClosed(key: string, tsMs: number, opts?: { finalR?: number; deferSave?: boolean }): boolean {
    try {
      const path = typeof key === "string" ? this.state.open[key] : undefined;
      if (!path) return false;
      const lastTick = path.ticks[path.ticks.length - 1];
      path.closedAtMs = Number.isFinite(tsMs) ? tsMs : (lastTick?.t ?? Date.now());
      path.closeR = Number.isFinite(opts?.finalR) ? roundR(opts!.finalR as number) : (lastTick?.r ?? null);
      delete this.state.open[key];
      this.state.closed.push(path);
      if (this.state.closed.length > MAX_CLOSED_PATHS) {
        this.state.closed = this.state.closed.slice(-MAX_CLOSED_PATHS);
      }
      this.dirty = true;
      if (!opts?.deferSave) this._save();
      return true;
    } catch {
      return false;
    }
  }

  /** The position's recorded path (open first, then the closed handoff buffer). Never throws. */
  getPath(key: string): PositionPath | null {
    try {
      const open = this.state.open[key];
      if (open) return open;
      for (let i = this.state.closed.length - 1; i >= 0; i -= 1) {
        if (this.state.closed[i]!.key === key) return this.state.closed[i]!;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Closed paths, oldest-first (the Exit Brain sweep's handoff feed). Never throws. */
  listClosedPaths(): PositionPath[] {
    try {
      return [...this.state.closed];
    } catch {
      return [];
    }
  }

  /** Drop leaked open paths (no tick for STALE_OPEN_MS — their close was never observed, so they
   *  are NOT moved to closed) and closed paths beyond CLOSED_RETENTION_MS. Never throws. */
  pruneExpired(nowMs = Date.now(), opts?: { deferSave?: boolean }): { droppedOpen: number; droppedClosed: number } {
    try {
      let droppedOpen = 0;
      for (const [key, path] of Object.entries(this.state.open)) {
        const lastT = path.ticks[path.ticks.length - 1]?.t;
        if (lastT === undefined || nowMs - lastT > STALE_OPEN_MS) {
          delete this.state.open[key];
          droppedOpen += 1;
        }
      }
      const before = this.state.closed.length;
      this.state.closed = this.state.closed.filter((p) => p.closedAtMs !== null && nowMs - p.closedAtMs <= CLOSED_RETENTION_MS);
      const droppedClosed = before - this.state.closed.length;
      if (droppedOpen > 0 || droppedClosed > 0) {
        this.dirty = true;
        if (!opts?.deferSave) this._save();
      }
      return { droppedOpen, droppedClosed };
    } catch {
      return { droppedOpen: 0, droppedClosed: 0 };
    }
  }

  /** Persist now if anything changed since the last write (for batch writers using deferSave).
   *  A no-op while clean. Never throws. */
  flush(): void {
    if (this.dirty) this._save();
  }

  private _save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      // persistence failures must never break the caller
    }
  }
}

let singleton: PositionPathRecorder | null = null;
export function getPositionPathRecorder(dataDir = "data"): PositionPathRecorder {
  if (!singleton) singleton = new PositionPathRecorder(dataDir);
  return singleton;
}
export function _resetPositionPathRecorderForTests(): void {
  singleton = null;
}

// ── Exit Brain reader adapter ────────────────────────────────────────────────

/**
 * Maps CLOSED recorded paths to exit-brain-shadow's ExitBrainResolvedTrade shape — the DENSE
 * counterpart of resolvedTradesFromShadowPositions' 4-point skeletons. v1 source note (documented
 * choice, see exit-brain-shadow.ts's inventory): the recorder's writers are the REAL-execution
 * paths (engine intents + single-symbol executor positions), a different trade universe from the
 * shadow-position skeleton source — routes/shadow.ts merges both, dense trades taking priority on
 * any tradeId collision. Rules (all honesty-preserving):
 *   - meta-less paths are skipped (never fabricate lane/symbol/direction identity);
 *   - paths without a finite closedAtMs or usable exit R are skipped;
 *   - actualExitR = closeR (writer-supplied — engine: NET realized R; executor: raw mark-R at the
 *     confirmed exit price) falling back to the last tick's r;
 *   - a terminal tick at (closedAtMs, actualExitR) is appended when the last recorded tick
 *     precedes the close, so the walked path always ends where the trade actually ended.
 * Pure; exported for tests.
 */
export function resolvedTradesFromRecordedPaths(paths: PositionPath[]): ExitBrainResolvedTrade[] {
  const out: ExitBrainResolvedTrade[] = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    if (!path || !path.meta || !Array.isArray(path.ticks) || path.ticks.length === 0) continue;
    if (!Number.isFinite(path.closedAtMs)) continue;
    const lastTick = path.ticks[path.ticks.length - 1]!;
    const actualExitR = Number.isFinite(path.closeR) ? (path.closeR as number) : lastTick.r;
    if (!Number.isFinite(actualExitR)) continue;

    const ticks: ExitBrainPathTick[] = path.ticks
      .filter((t) => Number.isFinite(t.t) && Number.isFinite(t.r))
      .map((t) => ({ tsMs: t.t, currentR: t.r }));
    if (ticks.length === 0) continue;
    if ((path.closedAtMs as number) > ticks[ticks.length - 1]!.tsMs) {
      ticks.push({ tsMs: path.closedAtMs as number, currentR: actualExitR });
    }

    out.push({
      tradeId: `pp:${path.key}`,
      laneId: path.meta.laneId,
      symbol: path.meta.symbol,
      direction: path.meta.direction,
      closedAtIso: new Date(path.closedAtMs as number).toISOString(),
      actualExitR,
      ticks,
    });
  }
  return out;
}
