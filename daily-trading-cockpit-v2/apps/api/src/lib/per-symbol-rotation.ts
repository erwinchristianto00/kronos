/**
 * Per-symbol auto-rotating allow-set (the "don't get stuck on a bad symbol" brain of the headline
 * gate, step 2b).
 *
 * The per-symbol × lane BOOK edge report (per-symbol-lane-book-edge.ts) already scores every
 * (symbol × lane × direction) cell on the realized paper book and tags it promotable /
 * testnetCandidate. This turns that into a rolling ALLOW-SET: the (symbol, direction) pairs whose
 * best lane currently clears the bar, each mapped to that best lane. Because it is recomputed from
 * the LIVE book every cycle, the set ROTATES automatically — a symbol whose book decays below the
 * bar drops out on the next recompute, and a newly-proven symbol enters. No static list to go stale.
 *
 * Modes gate how strict the confirmation must be:
 *   - TESTNET        → admit testnetCandidate + promotable (earn headline confirmation).
 *   - LIVE_CONFIRMED → admit only promotable (headline-confirmed) — the safe live default.
 *   - LIVE_CREDIBLE  → admit testnetCandidate + promotable on live too (operator's explicit
 *                      aggressive choice: trade diagnostic-credible edge on real money, bounded by
 *                      all existing rails — kill-switch, $-risk, loss-cut, cluster cap).
 *
 * maxSymbols caps how many pairs are admitted (top by book netAvgR) so a good report can't flood
 * the book past the position caps. Pure: caller passes the report; nothing is mutated or executed.
 */

import type { PerSymbolLaneBookEdgeReport, PsleBestLane } from "./per-symbol-lane-book-edge.js";

export type SymbolRotationMode = "TESTNET" | "LIVE_CONFIRMED" | "LIVE_CREDIBLE";

export interface SymbolRotationEntry {
  symbol: string;
  direction: "LONG" | "SHORT";
  laneId: string;
  netAvgR: number;
  stage: "PROMOTABLE" | "TESTNET_CANDIDATE";
}

export interface SymbolRotationSet {
  mode: SymbolRotationMode;
  maxSymbols: number;
  entries: SymbolRotationEntry[];
  /** `${SYMBOL}:${DIRECTION}` for O(1) admission checks. */
  allowedKeys: Set<string>;
  /** `${SYMBOL}:${DIRECTION}` → laneId, so admission routes the symbol to its best proven lane. */
  laneBySymbolDirection: Map<string, string>;
}

export interface SymbolRotationOptions {
  mode: SymbolRotationMode;
  /** Cap on admitted pairs (top by netAvgR). Default 8 (aligned with the total position cap). */
  maxSymbols?: number;
}

export function rotationKey(symbol: string, direction: "LONG" | "SHORT"): string {
  return `${symbol.toUpperCase()}:${direction}`;
}

/** Which best-lane stages a mode admits. */
function stageAdmitted(mode: SymbolRotationMode, stage: PsleBestLane["stage"]): stage is "PROMOTABLE" | "TESTNET_CANDIDATE" {
  if (stage === "PROMOTABLE") return true; // every mode admits headline-confirmed
  if (stage === "TESTNET_CANDIDATE") return mode === "TESTNET" || mode === "LIVE_CREDIBLE";
  return false; // NONE
}

export function buildSymbolRotationSet(
  report: PerSymbolLaneBookEdgeReport,
  opts: SymbolRotationOptions,
): SymbolRotationSet {
  const maxSymbols = opts.maxSymbols ?? 8;
  const candidates = report.bestLanePerSymbol
    .filter((s): s is PsleBestLane & { direction: "LONG" | "SHORT"; bestLaneId: string; bestNetAvgR: number } =>
      stageAdmitted(opts.mode, s.stage) &&
      (s.direction === "LONG" || s.direction === "SHORT") &&
      typeof s.bestLaneId === "string" &&
      typeof s.bestNetAvgR === "number",
    )
    // Best edge first, then take the top maxSymbols — a strong report can't flood past the caps.
    .sort((a, b) => b.bestNetAvgR - a.bestNetAvgR)
    .slice(0, maxSymbols);

  const entries: SymbolRotationEntry[] = candidates.map((s) => ({
    symbol: s.symbol,
    direction: s.direction,
    laneId: s.bestLaneId,
    netAvgR: s.bestNetAvgR,
    stage: s.stage === "PROMOTABLE" ? "PROMOTABLE" : "TESTNET_CANDIDATE",
  }));

  const allowedKeys = new Set<string>();
  const laneBySymbolDirection = new Map<string, string>();
  for (const e of entries) {
    const key = rotationKey(e.symbol, e.direction);
    allowedKeys.add(key);
    laneBySymbolDirection.set(key, e.laneId);
  }

  return { mode: opts.mode, maxSymbols, entries, allowedKeys, laneBySymbolDirection };
}

/** True when this (symbol, direction) is currently in the rotating allow-set. */
export function rotationAllows(set: SymbolRotationSet, symbol: string, direction: "LONG" | "SHORT"): boolean {
  return set.allowedKeys.has(rotationKey(symbol, direction));
}
