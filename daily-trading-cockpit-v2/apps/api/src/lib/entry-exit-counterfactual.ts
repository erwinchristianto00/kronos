/**
 * Entry / Exit counterfactual reconstruction (Track 2, report-only). For a decision at path[0] (a CLOSED candle),
 * evaluates each Entry action (ENTER_NOW / WAIT_PULLBACK / WAIT_BREAKOUT / WAIT_CONFIRMATION / SKIP) and each Exit
 * action (HOLD / EXIT_NOW / SCALE_OUT / TRAIL / incumbent TP-SL) over the FORWARD candle path, and returns the
 * per-action outcome metrics. Pure + deterministic. Touches no live state, orders, or beta.
 *
 * CAUSALITY: the DECISION is made at path[0] (no forward info); each action's OUTCOME is computed from the forward
 * path (path[1..]) — legitimate, since it's what WOULD have happened, not a decision input. Because OHLC candles
 * do not reveal intrabar order, when a bar touches BOTH the stop and a favorable target we assume the ADVERSE
 * touch first (conservative). We therefore do NOT claim exact reversal timing — only stop-vs-target outcomes under
 * this explicit worst-case-within-bar rule. Sub-bar precision requires trade-level (Tier-B) or L2 data.
 */

export interface PathCandle { openTime: number; open: number; high: number; low: number; close: number; }
export type Direction = "LONG" | "SHORT";

export interface TradeParams {
  direction: Direction;
  riskDistance: number; // price units (e.g. RISK_ATR_MULT * ATR) — the R denominator
  horizonBars: number;
  costRoundTripR: number; // total round-trip execution cost in R (from the emulator/calibration)
}

export interface TradeOutcome {
  entered: boolean;
  entryBar: number | null; entryPrice: number | null; exitBar: number | null; exitPrice: number | null;
  grossR: number | null; netR: number | null;
  mfeR: number | null; maeR: number | null; timeToMfeBars: number | null;
  stoppedOut: boolean;
  /** True when the OUTCOME hinged on a bar that touched BOTH the stop and a ≥+1R favorable extreme — exact
   *  intrabar ordering is unknowable from OHLC, so this row is AMBIGUOUS_INTRABAR (resolved adverse-first). */
  ambiguousIntrabar: boolean;
}

const NOT_ENTERED: TradeOutcome = { entered: false, entryBar: null, entryPrice: null, exitBar: null, exitPrice: null, grossR: null, netR: null, mfeR: null, maeR: null, timeToMfeBars: null, stoppedOut: false, ambiguousIntrabar: false };

/**
 * Simulate a trade from `entryBar`/`entryPrice`, with a hard stop at riskDistance and a time-exit at
 * entryBar+horizon. Conservative intrabar rule: adverse (stop) checked before favorable within each bar.
 */
export function simulateTrade(path: PathCandle[], entryBar: number, entryPrice: number, p: TradeParams): TradeOutcome {
  if (!(p.riskDistance > 0) || entryBar < 0 || entryBar >= path.length) return NOT_ENTERED;
  const dir = p.direction === "LONG" ? 1 : -1;
  const stopPrice = entryPrice - dir * p.riskDistance;
  const lastBar = Math.min(path.length - 1, entryBar + p.horizonBars);
  let mfeR = 0, maeR = 0, timeToMfe = 0;
  const rOf = (price: number) => (dir * (price - entryPrice)) / p.riskDistance;
  for (let b = entryBar + 1; b <= lastBar; b += 1) {
    const c = path[b]!;
    const adverse = dir === 1 ? c.low : c.high; // worst-case price this bar
    const favorable = dir === 1 ? c.high : c.low;
    const adverseR = rOf(adverse);
    if (adverseR < maeR) maeR = adverseR;
    // conservative: stop first. Flag ambiguity when this same bar ALSO reached ≥+1R favorable (both touched).
    if ((dir === 1 && c.low <= stopPrice) || (dir === -1 && c.high >= stopPrice)) {
      const favThisBar = rOf(favorable);
      return { entered: true, entryBar, entryPrice, exitBar: b, exitPrice: stopPrice, grossR: -1, netR: -1 - p.costRoundTripR, mfeR, maeR: -maeR, timeToMfeBars: timeToMfe, stoppedOut: true, ambiguousIntrabar: favThisBar >= 1 };
    }
    const favR = rOf(favorable);
    if (favR > mfeR) { mfeR = favR; timeToMfe = b - entryBar; }
  }
  const exitPrice = path[lastBar]!.close;
  const grossR = rOf(exitPrice);
  return { entered: true, entryBar, entryPrice, exitBar: lastBar, exitPrice, grossR, netR: grossR - p.costRoundTripR, mfeR, maeR: -maeR, timeToMfeBars: timeToMfe, stoppedOut: false, ambiguousIntrabar: false };
}

export type EntryAction = "ENTER_NOW" | "WAIT_PULLBACK" | "WAIT_BREAKOUT" | "WAIT_CONFIRMATION" | "SKIP";
export interface EntryParams extends TradeParams { waitWindowBars: number; pullbackFrac: number; breakoutFrac: number; confirmBars: number; }
export interface EntryResult {
  action: EntryAction; outcome: TradeOutcome;
  chaseCostR: number | null; // entry price move vs ENTER_NOW, in R, signed adverse (+ = paid up)
  entryEfficiency: number | null; // netR / mfeR (how much of the favorable excursion was kept)
  opportunityCostR?: number | null; // SKIP only: the netR ENTER_NOW would have earned
}

/** Evaluate all five Entry actions for a decision at path[0]. refPrice = path[0].close. */
export function evaluateEntryActions(path: PathCandle[], p: EntryParams): EntryResult[] {
  const ref = path[0]!.close; const dir = p.direction === "LONG" ? 1 : -1;
  const win = Math.min(p.waitWindowBars, path.length - 1);
  const eff = (o: TradeOutcome) => (o.netR != null && o.mfeR != null && o.mfeR > 0 ? o.netR / o.mfeR : null);
  const chase = (o: TradeOutcome) => (o.entryPrice != null ? (dir * (o.entryPrice - ref)) / p.riskDistance : null);

  const now = simulateTrade(path, 0, ref, p);

  // WAIT_PULLBACK: first bar within window whose ADVERSE extreme reaches ref − pullback (LONG) / ref + pullback (SHORT).
  let pull: TradeOutcome = NOT_ENTERED;
  const pullTarget = ref - dir * p.pullbackFrac * p.riskDistance;
  for (let b = 1; b <= win; b += 1) { const c = path[b]!; if ((dir === 1 && c.low <= pullTarget) || (dir === -1 && c.high >= pullTarget)) { pull = simulateTrade(path, b, pullTarget, p); break; } }

  // WAIT_BREAKOUT: first bar whose FAVORABLE extreme reaches ref + breakout (LONG) / ref − breakout (SHORT).
  let brk: TradeOutcome = NOT_ENTERED;
  const brkTarget = ref + dir * p.breakoutFrac * p.riskDistance;
  for (let b = 1; b <= win; b += 1) { const c = path[b]!; if ((dir === 1 && c.high >= brkTarget) || (dir === -1 && c.low <= brkTarget)) { brk = simulateTrade(path, b, brkTarget, p); break; } }

  // WAIT_CONFIRMATION: enter at close[confirmBars] only if it confirms direction (closed beyond ref).
  let conf: TradeOutcome = NOT_ENTERED;
  const cb = Math.min(p.confirmBars, path.length - 1);
  if (cb >= 1 && dir * (path[cb]!.close - ref) > 0) conf = simulateTrade(path, cb, path[cb]!.close, p);

  return [
    { action: "ENTER_NOW", outcome: now, chaseCostR: 0, entryEfficiency: eff(now) },
    { action: "WAIT_PULLBACK", outcome: pull, chaseCostR: chase(pull), entryEfficiency: eff(pull) },
    { action: "WAIT_BREAKOUT", outcome: brk, chaseCostR: chase(brk), entryEfficiency: eff(brk) },
    { action: "WAIT_CONFIRMATION", outcome: conf, chaseCostR: chase(conf), entryEfficiency: eff(conf) },
    { action: "SKIP", outcome: NOT_ENTERED, chaseCostR: null, entryEfficiency: null, opportunityCostR: now.netR },
  ];
}

export type ExitAction = "HOLD" | "EXIT_NOW" | "SCALE_OUT" | "TRAIL" | "INCUMBENT_TP_SL";
export interface ExitParams extends TradeParams { trailFrac: number; tpR: number; }
export interface ExitResult {
  action: ExitAction; finalNetR: number | null; capturedMfe: number | null; givebackR: number | null;
  avoidedLossR: number | null; prematureExitCostR: number | null; exitBar: number | null;
}

/**
 * Evaluate Exit actions for a position ALREADY entered at path[0].close. HOLD is the baseline (time/stop exit);
 * the others are measured against it (avoidedLoss when EXIT beats HOLD; prematureExitCost when HOLD beats EXIT).
 */
export function evaluateExitActions(path: PathCandle[], p: ExitParams): ExitResult[] {
  const entry = path[0]!.close; const dir = p.direction === "LONG" ? 1 : -1;
  const rOf = (price: number) => (dir * (price - entry)) / p.riskDistance;
  const hold = simulateTrade(path, 0, entry, p);
  const holdNet = hold.netR ?? 0; const mfe = hold.mfeR ?? 0;

  // EXIT_NOW: exit at next bar's close.
  const exitNowBar = Math.min(1, path.length - 1);
  const exitNowNet = rOf(path[exitNowBar]!.close) - p.costRoundTripR;

  // SCALE_OUT: half at next bar, half at HOLD's exit.
  const scaleNet = 0.5 * (rOf(path[exitNowBar]!.close)) + 0.5 * (hold.grossR ?? 0) - p.costRoundTripR;

  // TRAIL: exit when price retraces trailFrac·risk from the running peak (chandelier), else HOLD's exit.
  // CONSERVATIVE adverse-first: test this bar's retrace against the peak established by PRIOR bars FIRST, and only
  // then let this bar's favorable extreme arm the peak higher — the same discipline as simulateTrade/INCUMBENT_TP_SL
  // (a bar's own high must not arm a trail that the same bar's low then trips).
  let trailNet = holdNet, trailBar = hold.exitBar;
  { let peak = 0; const last = Math.min(path.length - 1, p.horizonBars);
    for (let b = 1; b <= last; b += 1) { const c = path[b]!;
      const curR = rOf(dir === 1 ? c.low : c.high); // adverse extreme, tested against the prior-bar peak
      // Hard stop at −1R applies unconditionally, even before any peak has armed — a real stop order fires
      // regardless of whether the trailing mechanism has anything to trail yet (matches INCUMBENT_TP_SL below).
      if (curR <= -1) { trailNet = -1 - p.costRoundTripR; trailBar = b; break; }
      if (peak > 0 && curR <= peak - p.trailFrac) { trailNet = (peak - p.trailFrac) - p.costRoundTripR; trailBar = b; break; }
      const favR = rOf(dir === 1 ? c.high : c.low); if (favR > peak) peak = favR; // arm the peak AFTER the retrace test
    } }

  // INCUMBENT_TP_SL: fixed take-profit at tpR·risk, stop at 1·risk (conservative stop-first).
  let tpslNet = holdNet, tpslBar = hold.exitBar;
  { const last = Math.min(path.length - 1, p.horizonBars);
    for (let b = 1; b <= last; b += 1) { const c = path[b]!;
      const advR = rOf(dir === 1 ? c.low : c.high); const favR = rOf(dir === 1 ? c.high : c.low);
      if (advR <= -1) { tpslNet = -1 - p.costRoundTripR; tpslBar = b; break; }
      if (favR >= p.tpR) { tpslNet = p.tpR - p.costRoundTripR; tpslBar = b; break; } } }

  const mk = (action: ExitAction, net: number, bar: number | null): ExitResult => ({
    action, finalNetR: r4(net), capturedMfe: mfe > 0 ? r4(net / mfe) : null, givebackR: r4(mfe - net),
    avoidedLossR: r4(Math.max(0, net - holdNet)), prematureExitCostR: r4(Math.max(0, holdNet - net)), exitBar: bar,
  });
  return [
    mk("HOLD", holdNet, hold.exitBar),
    mk("EXIT_NOW", exitNowNet, exitNowBar),
    mk("SCALE_OUT", scaleNet, hold.exitBar),
    mk("TRAIL", trailNet, trailBar),
    mk("INCUMBENT_TP_SL", tpslNet, tpslBar),
  ];
}

function r4(v: number | null): number | null { return v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4; }

/** Aggregate a set of per-decision entry results into mean metrics per action (report-only). */
export function aggregateEntry(results: EntryResult[][]): Record<string, { n: number; enteredRate: number; meanNetR: number | null; stopOutRate: number | null; meanMaeR: number | null; meanTimeToMfe: number | null; meanChaseR: number | null; meanEfficiency: number | null }> {
  const actions: EntryAction[] = ["ENTER_NOW", "WAIT_PULLBACK", "WAIT_BREAKOUT", "WAIT_CONFIRMATION", "SKIP"];
  const out: Record<string, any> = {};
  const avg = (xs: (number | null)[]) => { const u = xs.filter((v): v is number => v != null && Number.isFinite(v)); return u.length ? u.reduce((a, b) => a + b, 0) / u.length : null; };
  for (const a of actions) {
    const rs = results.map((r) => r.find((x) => x.action === a)!).filter(Boolean);
    const entered = rs.filter((r) => r.outcome.entered);
    out[a] = {
      n: rs.length, enteredRate: rs.length ? entered.length / rs.length : 0,
      meanNetR: r4(avg(entered.map((r) => r.outcome.netR))), stopOutRate: entered.length ? entered.filter((r) => r.outcome.stoppedOut).length / entered.length : null,
      meanMaeR: r4(avg(entered.map((r) => r.outcome.maeR))), meanTimeToMfe: r4(avg(entered.map((r) => r.outcome.timeToMfeBars))),
      meanChaseR: r4(avg(entered.map((r) => r.chaseCostR))), meanEfficiency: r4(avg(entered.map((r) => r.entryEfficiency))),
    };
  }
  return out;
}
