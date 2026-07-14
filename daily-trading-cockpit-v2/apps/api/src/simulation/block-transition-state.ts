/**
 * Causal block transition-state descriptors (Market Digital Twin, Phase 2B). For compatibility-conditioned block
 * selection we must describe (a) the TERMINAL state at the end of the just-placed block and (b) the INITIAL state at
 * the start of a candidate block — using ONLY information causally available before the join. The terminal state uses
 * a lookback window ending at the last placed candle; the candidate initial state uses ONLY the candidate block's
 * FROZEN prefix (its first `prefixLen` candles), NEVER its full future path. All features are level-invariant or
 * calibration-normalized so they are comparable across the return-space reconstruction. Pure + deterministic.
 *
 * Candle-only corpus ⇒ funding + mark-basis are UNSUPPORTED (null, never fabricated).
 */
import type { CommonMarketFrame } from "./simulation-types.js";
import { mean, std, logReturns } from "./calibration-metrics.js";

export const TERMINAL_LOOKBACK = 24; // candles of causal history summarized at a block's END
export const CANDIDATE_PREFIX_LEN = 6; // FROZEN prefix of a candidate block used to judge its START (registered)

export interface BlockTransitionState {
  regimeFamily: string | null;
  volatilityShort: number; // realized vol over the last ~6 candles of the window
  volatilityMedium: number; // realized vol over the whole window
  volumeZScore: number; // window mean volume vs calibration baseline
  recentReturn: number; // per-candle MEAN log return (window-length-comparable across the 24-lookback vs 6-prefix windows)
  trendSlope: number; // OLS slope of log-price over the window (per candle)
  wickBodyProfile: number[]; // [upperWickFrac, lowerWickFrac, bodyFrac] means over the window
  fundingRate: number | null; // UNSUPPORTED (candle-only)
  markBasisBps: number | null; // UNSUPPORTED (candle-only)
  btcEthCorrelation: number | null; // contemporaneous corr of BTC/ETH returns over the window
  ethBetaToBtc: number | null; // OLS beta of ETH returns on BTC returns over the window
  hourOfDay: number; // UTC hour at the boundary candle
  weekend: boolean; // UTC weekday/weekend at the boundary candle
}

export interface CalibrationVolumeBaseline { volumeMean: number; volumeStd: number; }

/** Volume baseline from CALIBRATION ONLY (used for the volume z-score feature). */
export function computeCalibrationVolumeBaseline(frames: readonly CommonMarketFrame[], symbol: string): CalibrationVolumeBaseline {
  const vols = frames.map((f) => f.symbols[symbol]?.candle.value?.volume).filter((v): v is number => typeof v === "number");
  return { volumeMean: mean(vols) ?? 0, volumeStd: (std(vols) ?? 1) || 1 };
}

const closesIn = (frames: readonly CommonMarketFrame[], from: number, to: number, sym: string): number[] => {
  const out: number[] = [];
  for (let i = from; i < to; i += 1) { const c = frames[i]?.symbols[sym]?.candle.value?.close; if (typeof c === "number") out.push(c); }
  return out;
};

/**
 * TIME-ALIGNED closes for TWO symbols: only frames where BOTH have a valid close are kept, so the returned arrays are
 * index-synchronized (btc[k] and eth[k] are the same candle time). This prevents an asymmetric feed gap from silently
 * misaligning the BTC/ETH dependence features. (The real corpus is gapless — this is a correctness guard.)
 */
const pairedClosesIn = (frames: readonly CommonMarketFrame[], from: number, to: number, a: string, b: string): { a: number[]; b: number[] } => {
  const av: number[] = []; const bv: number[] = [];
  for (let i = from; i < to; i += 1) {
    const ca = frames[i]?.symbols[a]?.candle.value?.close; const cb = frames[i]?.symbols[b]?.candle.value?.close;
    if (typeof ca === "number" && typeof cb === "number") { av.push(ca); bv.push(cb); }
  }
  return { a: av, b: bv };
};

/** OLS slope of y on index 0..n-1 (per-step). null if <2 points. */
function olsSlope(y: number[]): number | null {
  const n = y.length; if (n < 2) return null;
  const mx = (n - 1) / 2; const my = mean(y) ?? 0;
  let num = 0, den = 0;
  for (let i = 0; i < n; i += 1) { num += (i - mx) * (y[i]! - my); den += (i - mx) ** 2; }
  return den > 0 ? num / den : null;
}
/** OLS beta of y on x (both same length). null if degenerate. */
function olsBeta(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length); if (n < 3) return null;
  const mx = mean(x.slice(0, n)) ?? 0; const my = mean(y.slice(0, n)) ?? 0;
  let num = 0, den = 0;
  for (let i = 0; i < n; i += 1) { num += (x[i]! - mx) * (y[i]! - my); den += (x[i]! - mx) ** 2; }
  return den > 0 ? num / den : null;
}
function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length); if (n < 3) return null;
  const ma = mean(a.slice(0, n))!, mb = mean(b.slice(0, n))!; let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

/**
 * Summarize the window [from, to) of `frames` into a transition state, anchored at `boundaryIndex` (the candle whose
 * hour-of-day/weekend define the join instant). `btc`/`eth` are the two symbol ids for the dependence features.
 */
export function describeWindow(frames: readonly CommonMarketFrame[], from: number, to: number, boundaryIndex: number, baseline: CalibrationVolumeBaseline, btc: string, eth: string): BlockTransitionState {
  // BTC-only features from BTC closes; DEPENDENCE features from TIME-ALIGNED BTC/ETH pairs (no cross-symbol misalign).
  const btcClose = closesIn(frames, from, to, btc);
  const btcR = logReturns(btcClose);
  const paired = pairedClosesIn(frames, from, to, btc, eth);
  const pairedBtcR = logReturns(paired.a); const ethR = logReturns(paired.b);
  const shortWin = btcR.slice(Math.max(0, btcR.length - 6));
  // volume + wick/body over the BTC window
  const vols: number[] = []; const upper: number[] = []; const lower: number[] = []; const body: number[] = [];
  for (let i = from; i < to; i += 1) {
    const c = frames[i]?.symbols[btc]?.candle.value; if (!c) continue;
    vols.push(c.volume);
    const range = c.high - c.low;
    if (range > 0) { upper.push((c.high - Math.max(c.open, c.close)) / range); lower.push((Math.min(c.open, c.close) - c.low) / range); body.push(Math.abs(c.close - c.open) / range); }
  }
  const bIdx = Math.min(Math.max(boundaryIndex, 0), frames.length - 1);
  const boundaryMs = frames[bIdx]?.asOfMs ?? 0;
  const dow = new Date(boundaryMs).getUTCDay();
  const volMean = mean(vols) ?? 0;
  const cumRet = btcR.reduce((a, v) => a + v, 0);
  const volShort = std(shortWin) ?? 0; const volMed = std(btcR) ?? 0;
  const trend = olsSlope(btcClose.map((c) => Math.log(Math.max(1e-9, c)))) ?? 0;
  const drift = btcR.length ? cumRet / btcR.length : 0;
  return {
    regimeFamily: drift > volMed * 0.15 ? "UPTREND" : drift < -volMed * 0.15 ? "DOWNTREND" : "RANGE",
    volatilityShort: volShort,
    volatilityMedium: volMed,
    volumeZScore: (volMean - baseline.volumeMean) / baseline.volumeStd,
    recentReturn: drift, // per-candle mean log return (window-length-comparable across terminal vs prefix windows)
    trendSlope: trend,
    wickBodyProfile: [mean(upper) ?? 0, mean(lower) ?? 0, mean(body) ?? 0],
    fundingRate: null,
    markBasisBps: null,
    btcEthCorrelation: pearson(pairedBtcR, ethR),
    ethBetaToBtc: olsBeta(pairedBtcR, ethR),
    hourOfDay: new Date(boundaryMs).getUTCHours(),
    weekend: dow === 0 || dow === 6,
  };
}

/** TERMINAL state at the END of a source block [start, start+len): summarize the last TERMINAL_LOOKBACK candles. */
export function computeTerminalState(frames: readonly CommonMarketFrame[], blockStart: number, blockLen: number, baseline: CalibrationVolumeBaseline, btc: string, eth: string, lookback = TERMINAL_LOOKBACK): BlockTransitionState {
  const end = blockStart + blockLen; // exclusive
  // Clamp the lookback to the block's OWN start: for a short block (len < lookback, e.g. COMPAT_STATIONARY geometric
  // lengths) the window must NOT reach into source candles BEFORE this block — those precede the block in the SOURCE
  // but a DIFFERENT block precedes it in the generated path, so summarizing them would be a causality mismatch.
  const from = Math.max(0, blockStart, end - lookback);
  return describeWindow(frames, from, end, end - 1, baseline, btc, eth);
}

/** INITIAL state at the START of a candidate source block: summarize ONLY its first `prefixLen` candles (FROZEN). */
export function computeInitialState(frames: readonly CommonMarketFrame[], blockStart: number, baseline: CalibrationVolumeBaseline, btc: string, eth: string, prefixLen = CANDIDATE_PREFIX_LEN): BlockTransitionState {
  const to = Math.min(frames.length, blockStart + prefixLen);
  return describeWindow(frames, blockStart, to, blockStart, baseline, btc, eth);
}
