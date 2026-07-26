/**
 * SIMULATED PAPER R-PATH STORE (2026-07-26, REPORT-ONLY).
 *
 * WHY: exit-brain-shadow.ts can only score a resolved trade whose recorded path carries at least
 * DEFAULT_EXIT_BRAIN_PARAMS.minEvaluableTicks (6) R observations. The only genuinely dense paths on
 * disk today are position-path-recorder.ts's REAL per-tick samples, written solely by the live
 * engine + single-symbol executors (measured on testnet: 286 dense paths, 233 evaluable = 81.5%).
 * Everything else the cycle sees is a 2-/4-point shadow-position SKELETON, which
 * exit-brain-policy.ts's own doc explains cannot be walked honestly — so coverage can only be raised
 * by producing MORE genuinely dense paths, never by lowering the tick floor.
 *
 * Paper orders ARE already walked candle-by-candle (paper-execution-router.ts → walkVariantPath),
 * but that walk only ever surfaced SUMMARY stats. current-guard-variant-matrix.ts's OPT-IN
 * `collectRPath` now returns the per-candle R series it already computes; this store persists that
 * series for RESOLVED paper orders and exposes it to the Exit Brain as a strictly SEPARATE tier.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────────
 * These paths are SIMULATED: a modeled fill + a candle-reconstructed path, not a recording of
 * anything that happened to real money. Task 1 (2026-07-10) measured the candle-walk exit
 * methodology diverging from real fills by −193%. Consumers MUST keep these rows in the SIMULATED
 * evidence tier (exit-brain-shadow.ts's ExitBrainEvidenceTier) and must never add a simulated number
 * to a measured one — the same discipline entry-brain-tier1-realized-resolver.ts (MEASURED) and
 * entry-brain-tier2-simulated-resolver.ts (EXPERIMENTAL_COST_OF_CAUTION) already enforce for the
 * Entry Brain. That is why the reader below hardcodes tier "SIMULATED" on every row it emits, with
 * no option to override it.
 *
 * HARD SAFETY RULE (same as position-path-recorder.ts / cortex-real-attribution.ts): this is
 * bookkeeping about trading, never part of it. Every public method is wrapped so it never throws
 * into a caller; a corrupt or unwritable store degrades to "simulated path collection restarts",
 * never to a trading effect. Nothing here can touch order placement, sizing, allocation or any live
 * gate.
 *
 * BOUNDS (all hard — this codebase has repeated OOM history behind that discipline; mirrors
 * position-path-recorder.ts's own idiom):
 *   - ≤ MAX_TICKS_PER_SIM_PATH (600) points per path, enforced with the SAME extreme-preserving
 *     thinner the walk itself uses (thinRPathPreservingExtremes) so a stored path still folds to the
 *     same running peak/trough the unthinned one would.
 *   - ≤ MAX_SIM_PATHS (300) paths retained newest-last (FIFO) — the handoff window for the Exit
 *     Brain sweep, which books each tradeId exactly once, so a path only needs to survive until the
 *     next ~7-min sweep.
 *   - SIM_PATH_RETENTION_MS (14d) age prune on top of the FIFO cap.
 * There is no unbounded array or map anywhere in this file.
 *
 * Persistence follows the repo's hardened store idiom: compact JSON, atomic tmp+rename, bounded
 * state, corrupt file ⇒ empty restart. `deferSave` + flush() batches a resolver pass's appends into
 * one write; flush() is a no-op while clean.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { thinRPathPreservingExtremes, type VariantRPathPoint } from "./current-guard-variant-matrix.js";
import type { ExitBrainPathTick } from "./exit-brain-policy.js";
import type { ExitBrainResolvedTrade } from "./exit-brain-shadow.js";

/** Hard per-path point cap — mirrors position-path-recorder.ts's MAX_TICKS_PER_POSITION. */
export const MAX_TICKS_PER_SIM_PATH = 600;
/** Newest-last FIFO handoff window — mirrors MAX_CLOSED_PATHS. */
export const MAX_SIM_PATHS = 300;
/** Paths older than this are dropped by pruneExpired() even below the FIFO cap. */
export const SIM_PATH_RETENTION_MS = 14 * 24 * 3_600_000;

/** Compact persisted point: t = epoch ms, r = signed simulated MARK-TO-MARKET R at the candle close
 *  (favorable positive), rounded to 4 decimals — sub-0.0001R resolution is noise and would only
 *  bloat the JSON. `t`/`r` are the same shape and same rounding as PositionPathTick, deliberately,
 *  so the two tiers are directly comparable in kind even though they must never be summed.
 *
 *  `p`/`m` are the walked candle's favorable/adverse EXTREMES (VariantRPathPoint.peakR/troughR) —
 *  the refinements evaluateExitBrainCounterfactual folds into its running peak/trough. They are how
 *  MFE/MAE information survives at one point per candle and MUST be persisted: dropping them would
 *  silently flatten every stored path to its close-marks. Each is OMITTED when it carries no
 *  information the fold would not already get from `r` (p ≤ max(r,0) / m ≥ min(r,0)) — a lossless
 *  size optimization, since the fold starts its peak at 0 and its trough at 0. */
export interface SimulatedPaperPathTick {
  t: number;
  r: number;
  /** Candle favorable extreme in R (≥ 0). Absent ⇒ no refinement beyond `r`. */
  p?: number;
  /** Candle adverse extreme in R (≤ 0). Absent ⇒ no refinement beyond `r`. */
  m?: number;
}

export interface SimulatedPaperPath {
  /** Stable identity of the resolved paper order (its paperOrderId). One record per order, ever. */
  key: string;
  laneId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  /** MARKET timestamp (ms) of the exit candle, straight from the walk's own closedAtMs. */
  closedAtMs: number;
  /** The R the simulated exit realized, in the SAME raw/gross unit as `ticks` (the walk's grossR —
   *  before the paper book's modeled costR). Documented per binding, exactly as
   *  position-path-recorder.ts documents its two writers' differing conventions. */
  closeR: number;
  /** Chronological (non-decreasing t), bounded by MAX_TICKS_PER_SIM_PATH. */
  ticks: SimulatedPaperPathTick[];
  /** Raw points ever offered (pre-thinning) — honest density evidence. */
  rawTickCount: number;
}

interface SimulatedPaperPathState {
  version: number;
  /** Newest-last, bounded to MAX_SIM_PATHS. */
  paths: SimulatedPaperPath[];
}

function emptyState(): SimulatedPaperPathState {
  return { version: 1, paths: [] };
}

function roundR(r: number): number {
  return Math.round(r * 1e4) / 1e4;
}

function sanitizePath(raw: unknown): SimulatedPaperPath | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<SimulatedPaperPath>;
  if (typeof p.key !== "string" || p.key.length === 0) return null;
  if (typeof p.laneId !== "string" || typeof p.symbol !== "string") return null;
  if (p.direction !== "LONG" && p.direction !== "SHORT") return null;
  if (!Number.isFinite(p.closedAtMs) || !Number.isFinite(p.closeR)) return null;
  if (!Array.isArray(p.ticks)) return null;
  const ticks = (p.ticks as unknown[])
    .filter((t): t is SimulatedPaperPathTick => {
      if (!t || typeof t !== "object") return false;
      const tick = t as Partial<SimulatedPaperPathTick>;
      return Number.isFinite(tick.t) && Number.isFinite(tick.r);
    })
    // Rebuild each point so a hand-edited/partial file can never smuggle a non-finite refinement
    // (or an unknown key) into the reader — same "trust nothing on disk" rule the rest of this
    // sanitizer follows.
    .map((t) => ({
      t: t.t,
      r: t.r,
      ...(Number.isFinite(t.p) ? { p: t.p as number } : {}),
      ...(Number.isFinite(t.m) ? { m: t.m as number } : {}),
    }))
    .slice(-MAX_TICKS_PER_SIM_PATH);
  return {
    key: p.key,
    laneId: p.laneId,
    symbol: p.symbol,
    direction: p.direction,
    closedAtMs: p.closedAtMs as number,
    closeR: p.closeR as number,
    ticks,
    rawTickCount: Number.isFinite(p.rawTickCount)
      ? Math.max(ticks.length, Math.floor(p.rawTickCount as number))
      : ticks.length,
  };
}

export interface RecordSimulatedPaperPathInput {
  key: string;
  laneId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  closedAtMs: number;
  closeR: number;
  /** walkVariantPath's opt-in rPath for this order. Null/empty ⇒ nothing is recorded (a path that
   *  could not be walked is never fabricated into one). */
  rPath: VariantRPathPoint[] | null | undefined;
}

export class SimulatedPaperPathStore {
  private readonly file: string;
  private state: SimulatedPaperPathState;
  private keySet: Set<string>;
  private dirty = false;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "paper-simulated-paths.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
    this.keySet = new Set(this.state.paths.map((p) => p.key));
  }

  get path(): string {
    return this.file;
  }

  private _load(): SimulatedPaperPathState {
    try {
      if (!existsSync(this.file)) return emptyState();
      const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { paths?: unknown }).paths)) {
        const paths = ((parsed as Partial<SimulatedPaperPathState>).paths as unknown[])
          .map(sanitizePath)
          .filter((p): p is SimulatedPaperPath => p !== null)
          .slice(-MAX_SIM_PATHS);
        return { version: 1, paths };
      }
    } catch {
      // corrupt/partial — restart from empty; simulated path collection restarts, trading unaffected
    }
    return emptyState();
  }

  /** Visible for tests. */
  getState(): SimulatedPaperPathState {
    return this.state;
  }

  has(key: string): boolean {
    try {
      return typeof key === "string" && this.keySet.has(key);
    } catch {
      return false;
    }
  }

  /**
   * Persist one RESOLVED paper order's simulated R path. Idempotent per key (a re-offer is a silent
   * no-op, never a duplicate row). Returns true only when actually recorded THIS call. Never throws.
   *
   * Drops (returns false, writes nothing) rather than fabricating: a missing/empty rPath, a
   * non-finite closedAtMs/closeR, or a blank identity. A terminal point at (closedAtMs, closeR) is
   * appended when the last walked point precedes the close, so the stored path always ends where the
   * simulated trade ended — the same rule resolvedTradesFromRecordedPaths applies to real paths.
   */
  recordResolvedPath(input: RecordSimulatedPaperPathInput, opts?: { deferSave?: boolean }): boolean {
    try {
      const { key, laneId, symbol, direction, closedAtMs, closeR } = input;
      if (typeof key !== "string" || key.length === 0) return false;
      if (typeof laneId !== "string" || laneId.length === 0) return false;
      if (typeof symbol !== "string" || symbol.length === 0) return false;
      if (direction !== "LONG" && direction !== "SHORT") return false;
      if (!Number.isFinite(closedAtMs) || !Number.isFinite(closeR)) return false;
      if (this.keySet.has(key)) return false;

      const raw = Array.isArray(input.rPath) ? input.rPath : [];
      const points = raw.filter((p) => p && Number.isFinite(p.tsMs) && Number.isFinite(p.currentR));
      if (points.length === 0) return false;

      const rawTickCount = points.length;
      // Defensive second enforcement of the per-path cap: the walk already caps at
      // VARIANT_R_PATH_MAX_POINTS, but a store must never trust its caller for its own bound.
      const capped = thinRPathPreservingExtremes(points, MAX_TICKS_PER_SIM_PATH);
      const ticks: SimulatedPaperPathTick[] = capped.map((p) => {
        const r = roundR(p.currentR);
        const peak = Number.isFinite(p.peakR ?? Number.NaN) ? roundR(p.peakR as number) : null;
        const trough = Number.isFinite(p.troughR ?? Number.NaN) ? roundR(p.troughR as number) : null;
        return {
          t: p.tsMs,
          r,
          // Omit a refinement that cannot move a consumer's running peak/trough (which start at 0).
          ...(peak !== null && peak > Math.max(r, 0) ? { p: peak } : {}),
          ...(trough !== null && trough < Math.min(r, 0) ? { m: trough } : {}),
        };
      });
      const lastT = ticks[ticks.length - 1]!.t;
      if (closedAtMs > lastT) ticks.push({ t: closedAtMs, r: roundR(closeR) });

      this.state.paths.push({
        key,
        laneId,
        symbol,
        direction,
        closedAtMs,
        closeR: roundR(closeR),
        ticks,
        rawTickCount,
      });
      this.keySet.add(key);
      if (this.state.paths.length > MAX_SIM_PATHS) {
        const evicted = this.state.paths.splice(0, this.state.paths.length - MAX_SIM_PATHS);
        for (const p of evicted) this.keySet.delete(p.key);
      }
      this.dirty = true;
      if (!opts?.deferSave) this._save();
      return true;
    } catch {
      return false; // report-only bookkeeping never throws into a trading path
    }
  }

  /** Stored paths, oldest-first (the Exit Brain sweep's SIMULATED handoff feed). Never throws. */
  listPaths(): SimulatedPaperPath[] {
    try {
      return [...this.state.paths];
    } catch {
      return [];
    }
  }

  /** Drop paths older than SIM_PATH_RETENTION_MS. Never throws. */
  pruneExpired(nowMs = Date.now(), opts?: { deferSave?: boolean }): { dropped: number } {
    try {
      const before = this.state.paths.length;
      const kept = this.state.paths.filter((p) => nowMs - p.closedAtMs <= SIM_PATH_RETENTION_MS);
      const dropped = before - kept.length;
      if (dropped > 0) {
        const keptKeys = new Set(kept.map((p) => p.key));
        for (const key of [...this.keySet]) if (!keptKeys.has(key)) this.keySet.delete(key);
        this.state.paths = kept;
        this.dirty = true;
        if (!opts?.deferSave) this._save();
      }
      return { dropped };
    } catch {
      return { dropped: 0 };
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

let singleton: SimulatedPaperPathStore | null = null;
let singletonDir: string | null = null;
/**
 * Single shared instance. Unlike getPositionPathRecorder()'s "first dataDir wins" getter, this one
 * REBUILDS when asked for a different directory: the writer derives its dataDir from the paper
 * store's own location (`dirname(store.path)` — the same idiom recordHeatShadowSnapshot already
 * uses in the paper resolver) while the Exit Brain reader asks for the default "data". In production
 * both resolve to the same absolute path, so exactly one instance exists; under tests each tmp dir
 * gets its own instance instead of silently sharing (or polluting) the repo's real ./data store.
 * Safe because every write persists immediately — a swap re-reads from disk, it never loses state.
 */
export function getSimulatedPaperPathStore(dataDir = "data"): SimulatedPaperPathStore {
  const resolved = resolve(dataDir);
  if (!singleton || singletonDir !== resolved) {
    singleton = new SimulatedPaperPathStore(dataDir);
    singletonDir = resolved;
  }
  return singleton;
}
export function _resetSimulatedPaperPathStoreForTests(): void {
  singleton = null;
  singletonDir = null;
}

/**
 * The data dir a simulated-path store belongs next to, given the PAPER store it describes. Both the
 * writer (paper-execution-router.ts) and the Exit Brain reader (routes/shadow.ts) derive their dir
 * through THIS one function from the SAME paper store, so they can never end up pointing at
 * different files — including if the paper store is ever relocated (e.g. the realtime-short-mirror
 * store at data/realtime-short). `paperStorePath` is that store's own `.path`.
 */
export function simulatedPaperPathDirFor(paperStorePath: string): string {
  try {
    if (typeof paperStorePath !== "string" || paperStorePath.length === 0) return "data";
    // A plain directory (no filename) is accepted as-is; otherwise strip the store's own file name.
    return basename(paperStorePath).endsWith(".json") ? dirname(paperStorePath) : paperStorePath;
  } catch {
    return "data";
  }
}

// ── Exit Brain reader adapter (SIMULATED tier) ───────────────────────────────

/**
 * Maps stored simulated paper paths to exit-brain-shadow's ExitBrainResolvedTrade shape.
 *
 * EVERY emitted row is hardcoded `tier: "SIMULATED"` — there is deliberately no parameter to change
 * that. These rows are candle-walk reconstructions, and the whole point of the tier discriminator is
 * that they can never be silently counted as measured evidence.
 *
 * R-CONVENTION NOTE (document-per-binding, same as position-path-recorder.ts's reader): both
 * `actualExitR` and the tick series are the walk's RAW/GROSS R — before the paper book's modeled
 * costR. That keeps the counterfactual internally consistent (the policy side is raw mark-R too),
 * and it is a DIFFERENT unit from resolvedTradesFromShadowPositions' realizedNetR — which is another
 * reason these must not be pooled with the measured tier.
 *
 * tradeId is prefixed `sim:` so it can never collide with the `pp:` (recorded real path) or `sp:`
 * (shadow position) namespaces in the shared dedup ledger.
 *
 * Pure; exported for tests.
 */
export function resolvedTradesFromSimulatedPaperPaths(paths: SimulatedPaperPath[]): ExitBrainResolvedTrade[] {
  const out: ExitBrainResolvedTrade[] = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    if (!path || typeof path.key !== "string" || !Array.isArray(path.ticks) || path.ticks.length === 0) continue;
    if (!Number.isFinite(path.closedAtMs) || !Number.isFinite(path.closeR)) continue;
    if (typeof path.laneId !== "string" || typeof path.symbol !== "string") continue;
    if (path.direction !== "LONG" && path.direction !== "SHORT") continue;

    const ticks: ExitBrainPathTick[] = path.ticks
      .filter((t) => t && Number.isFinite(t.t) && Number.isFinite(t.r))
      // p/m map straight onto ExitBrainPathTick's optional peakR/troughR — the walked candle's
      // extremes, which the evaluator folds into its running peak/trough. Without them a one-point-
      // per-candle path would hand the policy only its close-marks and hide every intra-candle MFE.
      .map((t) => ({
        tsMs: t.t,
        currentR: t.r,
        ...(Number.isFinite(t.p) ? { peakR: t.p as number } : {}),
        ...(Number.isFinite(t.m) ? { troughR: t.m as number } : {}),
      }));
    if (ticks.length === 0) continue;

    out.push({
      tradeId: `sim:${path.key}`,
      laneId: path.laneId,
      symbol: path.symbol,
      direction: path.direction,
      closedAtIso: new Date(path.closedAtMs).toISOString(),
      actualExitR: path.closeR,
      ticks,
      tier: "SIMULATED",
    });
  }
  return out;
}
