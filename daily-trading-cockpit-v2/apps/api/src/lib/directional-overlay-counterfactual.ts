/**
 * Shadow counterfactual for the XSEC directional lanes: "what would this position have returned if
 * the regime overlay had NOT closed it, and only the lane's own exits applied?"
 *
 * 2026-08-15. Measured on the first 12 closes: 8 of 12 were closed by
 * `DIRECTIONAL_REVERSAL_CONFIRMED:*` (the overlay), averaging −0.059R, while the 4 that reached the
 * lane's own MFE exits averaged +0.43R. A one-off replay of those 8 on real 5m candles returned
 * +0.218R — every one of them positive, with ZERO stops hit. That is suggestive and nothing more:
 * n=8, ~5 independent episodes, two calendar days, and zero stops means the sample contains no
 * genuine reversal at all. This module exists to collect the same comparison FORWARD, at sample
 * sizes that can actually settle it, without touching execution.
 *
 * REPORT-ONLY BY CONSTRUCTION: nothing here places, cancels, or closes an order, and no execution
 * path imports it. It has no imports of its own so it can be dropped onto an older instance with a
 * single route registration.
 */

export type Direction = "LONG" | "SHORT";

export interface DirectionalClosedPosition {
  positionId: string;
  symbol: string;
  direction: Direction;
  qty: number;
  entryPrice: number;
  stopPrice: number;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  netPnlUsd: number | null;
  feeEstimateUsd?: number | null;
  entryCommissionUsd?: number | null;
  entryLegFoldedIntoPnl?: boolean | null;
  status?: string;
}

/** One 5m bar: [openTimeMs, open, high, low, close]. */
export type Bar = { openTimeMs: number; open: number; high: number; low: number; close: number };

export interface OwnExitParams {
  armR: number;
  givebackFraction: number;
  profitLockNetReturn: number;
  staticTpMaxNetReturn: number;
  maxHoldHours: number;
}

export const DEFAULT_OWN_EXIT: OwnExitParams = {
  armR: 0.2,
  givebackFraction: 0.3,
  profitLockNetReturn: 0.005,
  staticTpMaxNetReturn: 0.0065,
  maxHoldHours: 24,
};

export function ownExitParamsFromEnv(env: NodeJS.ProcessEnv = process.env): OwnExitParams {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number.parseFloat(raw ?? "");
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    armR: num(env.CROSS_SECTIONAL_DIRECTIONAL_MFE_ARM_R, DEFAULT_OWN_EXIT.armR),
    givebackFraction: num(env.CROSS_SECTIONAL_DIRECTIONAL_MFE_GIVEBACK_FRACTION, DEFAULT_OWN_EXIT.givebackFraction),
    profitLockNetReturn: num(env.CROSS_SECTIONAL_DIRECTIONAL_MFE_PROFIT_LOCK_NET_RETURN, DEFAULT_OWN_EXIT.profitLockNetReturn),
    staticTpMaxNetReturn: num(env.CROSS_SECTIONAL_DIRECTIONAL_STATIC_TP_MAX_NET_RETURN, DEFAULT_OWN_EXIT.staticTpMaxNetReturn),
    maxHoldHours: num(env.CROSS_SECTIONAL_DIRECTIONAL_MAX_HOLD_HOURS, DEFAULT_OWN_EXIT.maxHoldHours),
  };
}

/** The overlay is the ONLY close reason this counterfactual applies to. */
export function isOverlayClose(closeReason: string | null | undefined): boolean {
  return typeof closeReason === "string" && closeReason.startsWith("DIRECTIONAL_REVERSAL_CONFIRMED");
}

/**
 * Round-trip cost in R for one position.
 *
 * `costBps` is the MEASURED exchange round trip (7.99 bps on testnet: taker 4 bps × 2 sides),
 * not a model constant — see the directional stores' own `feeSource: "EXCHANGE"` rows.
 */
export function positionCostR(p: Pick<DirectionalClosedPosition, "qty" | "entryPrice" | "stopPrice">, costBps: number): number | null {
  const riskUsd = Math.abs((p.entryPrice - p.stopPrice) * p.qty);
  if (!(riskUsd > 0)) return null;
  const notional = Math.abs(p.qty * p.entryPrice);
  return (costBps / 10000) * notional / riskUsd;
}

/**
 * The position's REALISED netR, corrected for the ledger's half-cost undercount.
 *
 * `netPnlUsd` subtracts only `feeEstimateUsd` (the exit commission). `entryCommissionUsd` is
 * recorded separately and, when `entryLegFoldedIntoPnl` is false, was never subtracted — measured
 * 2026-08-15 as 4.00 bps against 3.99 bps, i.e. the ledger reports HALF the real cost. Correcting
 * here keeps the comparison honest; the fix belongs in the executor.
 */
export function realisedNetR(p: DirectionalClosedPosition): number | null {
  const riskUsd = Math.abs((p.entryPrice - p.stopPrice) * p.qty);
  if (!(riskUsd > 0) || p.netPnlUsd == null || !Number.isFinite(p.netPnlUsd)) return null;
  const unbookedEntryFee = p.entryLegFoldedIntoPnl === true ? 0 : (p.entryCommissionUsd ?? 0);
  return (p.netPnlUsd - unbookedEntryFee) / riskUsd;
}

export interface OwnExitResult {
  netR: number;
  grossR: number;
  exitReason: "STOP" | "STATIC_TP" | "PROFIT_LOCK" | "MFE_GIVEBACK" | "MAX_HOLD";
  holdHours: number;
  stopHit: boolean;
}

/**
 * Replay the lane's OWN exits over real bars, ignoring the overlay entirely.
 *
 * Deliberately CLOSE-triggered, never intrabar-extreme triggered: the executor samples on a poll
 * cadence and cannot see a wick it never observed. (Checked both ways on the first 8 positions —
 * the intrabar variant scored WORSE, +0.157R vs +0.218R, because premature trailing fires on wicks.
 * Close-only is both the conservative modelling choice and the more favourable one, so the result
 * does not depend on this assumption.)
 *
 * The STOP is the one exception: a stop is a resting exchange order, so it fills on the wick.
 * Checking it FIRST within each bar is the pessimistic ordering.
 */
export function replayOwnExit(bars: readonly Bar[], p: Pick<DirectionalClosedPosition, "direction" | "entryPrice" | "stopPrice">, params: OwnExitParams, costR: number): OwnExitResult | null {
  if (!bars.length) return null;
  const { entryPrice: entry, stopPrice: stop, direction } = p;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !(entry > 0)) return null;
  const isShort = direction === "SHORT";
  const rOf = (px: number): number => (isShort ? entry - px : px - entry) / risk;
  const retOf = (px: number): number => (isShort ? entry - px : px - entry) / entry;

  const firstMs = bars[0]!.openTimeMs;
  const deadline = firstMs + params.maxHoldHours * 3600e3;
  let peakR = 0;

  const done = (px: number, reason: OwnExitResult["exitReason"], atMs: number): OwnExitResult => ({
    grossR: rOf(px),
    netR: rOf(px) - costR,
    exitReason: reason,
    holdHours: (atMs - firstMs) / 3600e3,
    stopHit: reason === "STOP",
  });

  let lastInWindow = bars[0]!;
  for (const bar of bars) {
    if (bar.openTimeMs > deadline) break;
    lastInWindow = bar;
    // 1) stop — resting order, fills on the wick, checked first (pessimistic)
    if ((isShort && bar.high >= stop) || (!isShort && bar.low <= stop)) return done(stop, "STOP", bar.openTimeMs);
    // 2-4) lane exits — CLOSE-triggered only
    const closeRet = retOf(bar.close);
    if (closeRet >= params.staticTpMaxNetReturn) return done(bar.close, "STATIC_TP", bar.openTimeMs);
    if (closeRet >= params.profitLockNetReturn) return done(bar.close, "PROFIT_LOCK", bar.openTimeMs);
    const barPeak = Math.max(peakR, rOf(bar.close));
    if (barPeak >= params.armR && rOf(bar.close) <= barPeak * (1 - params.givebackFraction)) {
      return done(bar.close, "MFE_GIVEBACK", bar.openTimeMs);
    }
    peakR = barPeak;
  }
  // Bar terakhir yang MASIH di dalam jendela max-hold. Sebelumnya ini memakai bars[last], yang
  // bisa sudah melewati tenggat sehingga holdHours melampaui maxHoldHours — ditangkap oleh
  // tesnya sendiri (holdHours 25 pada maxHoldHours 24).
  return done(lastInWindow.close, "MAX_HOLD", lastInWindow.openTimeMs);
}

export interface CounterfactualRow {
  positionId: string;
  symbol: string;
  direction: Direction;
  openedAt: string;
  closedAt: string | null;
  actualNetR: number;
  counterfactualNetR: number;
  deltaR: number;
  counterfactualExit: OwnExitResult["exitReason"];
  counterfactualHoldHours: number;
  stopHit: boolean;
}

export interface CounterfactualSummary {
  n: number;
  independentEpisodes: number;
  distinctDays: number;
  actualMeanR: number | null;
  counterfactualMeanR: number | null;
  deltaMeanR: number | null;
  stopsHit: number;
  exitMix: Record<string, number>;
  /** Honest ceiling on what this sample can support. */
  verdict: string;
}

/** Overlapping [open, close] windows collapse to ONE episode — rows are not observations. */
export function countIndependentEpisodes(rows: ReadonlyArray<{ openedAt: string; closedAt: string | null }>): number {
  const spans = rows
    .map((r) => ({ o: Date.parse(r.openedAt), c: Date.parse(r.closedAt ?? r.openedAt) }))
    .filter((s) => Number.isFinite(s.o))
    .sort((a, b) => a.o - b.o);
  let episodes = 0;
  let end = -Infinity;
  for (const s of spans) {
    if (s.o >= end) { episodes += 1; end = s.c; } else { end = Math.max(end, s.c); }
  }
  return episodes;
}

export function summariseCounterfactual(rows: readonly CounterfactualRow[]): CounterfactualSummary {
  const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const episodes = countIndependentEpisodes(rows);
  const days = new Set(rows.map((r) => r.openedAt.slice(0, 10))).size;
  const exitMix: Record<string, number> = {};
  for (const r of rows) exitMix[r.counterfactualExit] = (exitMix[r.counterfactualExit] ?? 0) + 1;
  const stopsHit = rows.filter((r) => r.stopHit).length;

  let verdict: string;
  if (rows.length === 0) verdict = "no overlay-closed positions yet";
  else if (episodes < 20 || days < 7) {
    verdict = `NOT DECIDABLE — ${episodes} independent episodes over ${days} day(s); needs ~20 episodes across ≥7 days, including a trending regime`;
  } else if (stopsHit === 0) {
    verdict = `INCOMPLETE — ${episodes} episodes but ZERO stops hit, so this sample contains no genuine reversal; the overlay's actual job is untested`;
  } else {
    verdict = `${episodes} independent episodes over ${days} days with ${stopsHit} stop(s) hit — sample is broad enough to weigh`;
  }

  return {
    n: rows.length,
    independentEpisodes: episodes,
    distinctDays: days,
    actualMeanR: mean(rows.map((r) => r.actualNetR)),
    counterfactualMeanR: mean(rows.map((r) => r.counterfactualNetR)),
    deltaMeanR: mean(rows.map((r) => r.deltaR)),
    stopsHit,
    exitMix,
    verdict,
  };
}
