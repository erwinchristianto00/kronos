/**
 * Historical continuation library (Market Digital Twin, Phase 2C). For every eligible historical state window we record
 * its terminal state AND the ACTUALLY-CONTIGUOUS real sequence that followed it. At generation time we match a
 * generated terminal state to these historical terminal states and replay a REAL observed successor — so the transition
 * across the join is a real historical transition, not an arbitrary join between independently-selected blocks. The
 * successor is a contiguous [successorStart, successorEnd) slice of real synchronized BTC/ETH history — never assembled
 * from unrelated blocks. Pure + deterministic. Candle-only corpus ⇒ funding/mark-basis jumps are UNSUPPORTED (null).
 *
 * CAUSALITY: a record is ranked ONLY by its terminalState (the window ENDING at the boundary, entirely in the past of
 * the successor). The successor's future path is NEVER used to rank — it is only replayed once selected.
 */
import type { CommonMarketFrame } from "./simulation-types.js";
import type { BlockRef } from "./historical-block-bootstrap.js";
import { computeTerminalState, type BlockTransitionState, type CalibrationVolumeBaseline } from "./block-transition-state.js";
import { logReturns, mean, std } from "./calibration-metrics.js";

export interface HistoricalContinuationRecord {
  continuationId: string;
  stateWindowStartMs: number;
  stateWindowEndMs: number;
  terminalState: BlockTransitionState;
  successorStartMs: number;
  successorEndMs: number;
  /** Contiguous real successor as a source slice ref (frames materialized on demand to avoid copying). */
  successorRef: BlockRef;
  sourceMonth: string;
  sourcePartition: string;
  regimeBefore: string | null;
  regimeAfter: string | null;
  transitionMetrics: {
    volatilityRatio: number | null; // range ratio across the real boundary (candle b-1 → b)
    volumeRatio: number | null;
    fundingJump: number | null; // UNSUPPORTED (candle-only)
    markBasisJump: number | null; // UNSUPPORTED
    btcEthVectorDiscontinuity: number | null; // |returnVector(b) − returnVector(b−1)|
  };
}

const rangeOf = (f: CommonMarketFrame | undefined, s: string): number | null => { const c = f?.symbols[s]?.candle.value; return c ? c.high - c.low : null; };
const volOf = (f: CommonMarketFrame | undefined, s: string): number | null => (f?.symbols[s]?.candle.value?.volume ?? null);
const retAt = (frames: readonly CommonMarketFrame[], i: number, s: string): number | null => {
  const a = frames[i - 1]?.symbols[s]?.candle.value?.close; const b = frames[i]?.symbols[s]?.candle.value?.close;
  return typeof a === "number" && typeof b === "number" && a > 0 ? Math.log(b / a) : null;
};

/** Regime family of a window [from,to) from BTC drift vs realized vol (matches the offline labeler family). */
function windowRegime(frames: readonly CommonMarketFrame[], from: number, to: number, btc: string): string | null {
  const closes: number[] = []; for (let i = from; i < to; i += 1) { const c = frames[i]?.symbols[btc]?.candle.value?.close; if (typeof c === "number") closes.push(c); }
  const r = logReturns(closes); if (r.length < 2) return null;
  const v = std(r) ?? 0; const drift = mean(r) ?? 0;
  return drift > v * 0.15 ? "UPTREND" : drift < -v * 0.15 ? "DOWNTREND" : "RANGE";
}

/**
 * Build the continuation library over `frames`. For each boundary index b in [lookback, len−successorLen), record the
 * terminal state of the window [b−lookback, b) and the REAL contiguous successor [b, b+successorLen). `stride` subsamples
 * boundaries to bound library size. Pure + deterministic.
 */
export function buildContinuationLibrary(frames: readonly CommonMarketFrame[], args: { lookback: number; successorLen: number; sourcePartition: string; baseline: CalibrationVolumeBaseline; btc: string; eth: string; stride?: number }): HistoricalContinuationRecord[] {
  const { lookback, successorLen, sourcePartition, baseline, btc, eth } = args;
  const stride = Math.max(1, args.stride ?? 1);
  const out: HistoricalContinuationRecord[] = [];
  for (let b = lookback; b + successorLen <= frames.length; b += stride) {
    const terminalState = computeTerminalState(frames, b - lookback, lookback, baseline, btc, eth, lookback);
    // real transition metrics across the boundary b−1 → b (the actual historical join we will transplant)
    const pr = rangeOf(frames[b - 1], btc); const cr = rangeOf(frames[b], btc);
    const pv = volOf(frames[b - 1], btc); const cv = volOf(frames[b], btc);
    const volatilityRatio = pr != null && cr != null && pr > 0 && cr > 0 ? Math.max(cr / pr, pr / cr) : null;
    const volumeRatio = pv != null && cv != null && pv > 0 && cv > 0 ? Math.max(cv / pv, pv / cv) : null;
    const bBtc = retAt(frames, b, btc); const bEth = retAt(frames, b, eth);
    const pBtc = retAt(frames, b - 1, btc); const pEth = retAt(frames, b - 1, eth);
    const vecDisc = bBtc != null && bEth != null && pBtc != null && pEth != null ? Math.hypot(bBtc - pBtc, bEth - pEth) : null;
    out.push({
      continuationId: `cont:${sourcePartition}:${b}`,
      stateWindowStartMs: frames[b - lookback]?.asOfMs ?? 0, stateWindowEndMs: frames[b - 1]?.asOfMs ?? 0,
      terminalState,
      successorStartMs: frames[b]?.asOfMs ?? 0, successorEndMs: frames[b + successorLen - 1]?.asOfMs ?? 0,
      successorRef: { startIndex: b, length: successorLen },
      sourceMonth: new Date(frames[b]?.asOfMs ?? 0).toISOString().slice(0, 7), sourcePartition,
      regimeBefore: windowRegime(frames, b - lookback, b, btc), regimeAfter: windowRegime(frames, b, b + successorLen, btc),
      transitionMetrics: { volatilityRatio, volumeRatio, fundingJump: null, markBasisJump: null, btcEthVectorDiscontinuity: vecDisc },
    });
  }
  return out;
}

/** Materialize a record's successor frames on demand (shallow slice of the source — references, not copies). */
export function successorFrames(source: readonly CommonMarketFrame[], record: HistoricalContinuationRecord): CommonMarketFrame[] {
  return source.slice(record.successorRef.startIndex, record.successorRef.startIndex + record.successorRef.length);
}
