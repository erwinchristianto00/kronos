/**
 * Historical contiguous-block bootstrap (Market Digital Twin, Phase-1 foundation). Priority #2/#3 of the
 * historical-first hierarchy. We NEVER independently sample candles — we resample CONTIGUOUS blocks of REAL,
 * SYNCHRONIZED frames so returns, volatility clustering, wick geometry, volume sequence, mark-basis, funding, and
 * cross-asset dependence are all preserved WITHIN each block. Blocks are joined by monotonic timestamp
 * normalization (a RECORDED transformation); genuine discontinuities INSIDE a block are never smoothed, and seam
 * boundaries are ASSESSED + counted (never silently smoothed either). Deterministic given the injected RNG.
 */
import type { CommonMarketFrame } from "./simulation-types.js";
import { buildCommonMarketFrame, type SymbolFrameInput } from "./common-market-frame.js";
import type { DeterministicRng } from "./deterministic-rng.js";

export type BlockSelectionMethod =
  | "FIXED_LENGTH_BLOCK"
  | "STATIONARY_BLOCK_BOOTSTRAP"
  | "REGIME_CONDITIONED_BLOCK"
  | "NEAREST_NEIGHBOR_CONTINUATION";

/** A block = a contiguous [startIndex, startIndex+length) slice of the source frame array. */
export interface BlockRef { startIndex: number; length: number; }

export interface StitchAssessment {
  accepted: boolean;
  reasons: string[];
  transformations: string[];
  priceGapPct: number | null;
  volatilityRatio: number | null;
  volumeRatio: number | null;
  fundingGap: number | null;
  correlationContext: number | null;
}

export interface BootstrapResult {
  method: BlockSelectionMethod;
  frames: CommonMarketFrame[];
  blocks: BlockRef[];
  stitches: StitchAssessment[];
  rejectedBoundaries: number;
}

export interface StitchTolerances {
  maxPriceGapPct: number; // e.g. 0.05 (5%)
  maxVolatilityRatio: number; // e.g. 3
  maxVolumeRatio: number; // e.g. 5
  maxFundingGap: number; // e.g. 0.0005
}
export const DEFAULT_STITCH_TOLERANCES: StitchTolerances = { maxPriceGapPct: 0.05, maxVolatilityRatio: 3, maxVolumeRatio: 5, maxFundingGap: 0.0005 };

const closeOf = (f: CommonMarketFrame, sym: string): number | null => (f.symbols[sym]?.candle.value?.close ?? null);
const openOf = (f: CommonMarketFrame, sym: string): number | null => (f.symbols[sym]?.candle.value?.open ?? null);
const rangeOf = (f: CommonMarketFrame, sym: string): number | null => {
  const c = f.symbols[sym]?.candle.value; return c ? c.high - c.low : null;
};
const volOf = (f: CommonMarketFrame, sym: string): number | null => (f.symbols[sym]?.candle.value?.volume ?? null);

/** Assess the boundary between the LAST frame of a prior block and the FIRST frame of the next block. */
export function assessStitch(prevLast: CommonMarketFrame, nextFirst: CommonMarketFrame, symbols: string[], tol: StitchTolerances = DEFAULT_STITCH_TOLERANCES): StitchAssessment {
  const reasons: string[] = [];
  let worstGap: number | null = null;
  let worstVolRatio: number | null = null;
  let worstVolumeRatio: number | null = null;
  for (const s of symbols) {
    const prevClose = closeOf(prevLast, s);
    const nextOpen = openOf(nextFirst, s);
    if (prevClose != null && nextOpen != null && prevClose > 0) {
      const gap = Math.abs(nextOpen - prevClose) / prevClose;
      worstGap = worstGap == null ? gap : Math.max(worstGap, gap);
      if (gap > tol.maxPriceGapPct) reasons.push(`${s} price gap ${(gap * 100).toFixed(2)}% > ${(tol.maxPriceGapPct * 100).toFixed(0)}%`);
    }
    const pr = rangeOf(prevLast, s); const nr = rangeOf(nextFirst, s);
    if (pr != null && nr != null && pr > 0) {
      const vr = Math.max(nr / pr, pr / Math.max(nr, 1e-9));
      worstVolRatio = worstVolRatio == null ? vr : Math.max(worstVolRatio, vr);
      if (vr > tol.maxVolatilityRatio) reasons.push(`${s} volatility ratio ${vr.toFixed(2)} > ${tol.maxVolatilityRatio}`);
    }
    const pv = volOf(prevLast, s); const nv = volOf(nextFirst, s);
    if (pv != null && nv != null && pv > 0) {
      const rr = Math.max(nv / pv, pv / Math.max(nv, 1e-9));
      worstVolumeRatio = worstVolumeRatio == null ? rr : Math.max(worstVolumeRatio, rr);
      if (rr > tol.maxVolumeRatio) reasons.push(`${s} volume ratio ${rr.toFixed(2)} > ${tol.maxVolumeRatio}`);
    }
  }
  return {
    accepted: reasons.length === 0,
    reasons,
    transformations: ["TIMESTAMP_NORMALIZED"], // seams are re-timed onto the monotonic grid; prices NOT smoothed
    priceGapPct: worstGap,
    volatilityRatio: worstVolRatio,
    volumeRatio: worstVolumeRatio,
    fundingGap: null, // funding not in the candle-only corpus ⇒ UNSUPPORTED at the seam (never fabricated)
    correlationContext: null,
  };
}

/** Re-time a chosen set of contiguous blocks onto a monotonic grid; preserve every real candle's OHLCV geometry;
 *  assess each seam. `stepMs` = the source timeframe. Provenance ⇒ HISTORICAL_BOOTSTRAP. */
export function assembleBootstrapPath(source: readonly CommonMarketFrame[], blocks: readonly BlockRef[], args: { runId: string; symbols: string[]; startMs: number; stepMs: number; method: BlockSelectionMethod; tolerances?: StitchTolerances }): BootstrapResult {
  const frames: CommonMarketFrame[] = [];
  const stitches: StitchAssessment[] = [];
  let rejected = 0;
  let tCloseAnchor = args.startMs;
  let prevLast: CommonMarketFrame | null = null;
  for (const [bi, block] of blocks.entries()) {
    const slice = source.slice(block.startIndex, block.startIndex + block.length);
    if (slice.length === 0) continue;
    if (prevLast) {
      const st = assessStitch(prevLast, slice[0]!, args.symbols, args.tolerances);
      stitches.push(st);
      if (!st.accepted) rejected += 1;
    }
    for (const f of slice) {
      const openTimeMs = tCloseAnchor;
      const closeTimeMs = openTimeMs + args.stepMs;
      const symbols: Record<string, SymbolFrameInput> = {};
      for (const s of args.symbols) {
        const c = f.symbols[s]?.candle.value;
        symbols[s] = c
          ? { candle: { openTimeMs, closeTimeMs, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }, source: `bootstrap:${s}:blk${bi}` }
          : { candle: null, source: `bootstrap:${s}:blk${bi}` };
      }
      frames.push(buildCommonMarketFrame({ runId: args.runId, asOfMs: closeTimeMs, symbols, provenance: "HISTORICAL_BOOTSTRAP" }));
      tCloseAnchor = closeTimeMs;
    }
    prevLast = slice.at(-1)!;
  }
  return { method: args.method, frames, blocks: blocks.slice(), stitches, rejectedBoundaries: rejected };
}

/** Deterministic FIXED-LENGTH block selection: pick `count` contiguous blocks of exactly `blockLen` frames. */
export function selectFixedLengthBlocks(sourceLen: number, blockLen: number, count: number, rng: DeterministicRng): BlockRef[] {
  if (blockLen <= 0 || blockLen > sourceLen) throw new Error(`fixed-block: blockLen ${blockLen} invalid for source ${sourceLen}`);
  const maxStart = sourceLen - blockLen;
  const blocks: BlockRef[] = [];
  for (let i = 0; i < count; i += 1) blocks.push({ startIndex: rng.nextInt(0, maxStart + 1), length: blockLen });
  return blocks;
}

/**
 * Deterministic STATIONARY block bootstrap (Politis–Romano): geometric block lengths (mean `meanBlockLen`), wrapping
 * disabled (blocks are clamped to the array end) so no block reaches past the observed data. Emits blocks until the
 * cumulative length ≥ `targetLen`.
 */
export function selectStationaryBlocks(sourceLen: number, meanBlockLen: number, targetLen: number, rng: DeterministicRng): BlockRef[] {
  if (meanBlockLen <= 0 || sourceLen <= 0) throw new Error("stationary-block: bad params");
  const p = 1 / meanBlockLen; // geometric restart probability
  const blocks: BlockRef[] = [];
  let total = 0;
  while (total < targetLen) {
    const start = rng.nextInt(0, sourceLen);
    let len = 1;
    while (rng.nextFloat() > p && start + len < sourceLen) len += 1; // grow geometrically, clamp at end (no wrap)
    blocks.push({ startIndex: start, length: len });
    total += len;
  }
  return blocks;
}
