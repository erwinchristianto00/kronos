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

/**
 * RETURN-SPACE stitching (Phase 2A repair). Rebuilds a CONTINUOUS synchronized price path from the source blocks'
 * WITHIN-block relative geometry so seams inject NO artificial price-level jump (the Phase-1B defect). For each
 * candle: the block's first candle opens exactly at the previous GENERATED close (continuity — the seam gap is
 * removed); subsequent candles preserve the source's within-block open-gap return; every candle's body + wicks are
 * reconstructed by the source's OWN ratios (open/prevClose, close/open, high/open, low/open) around the new anchored
 * level. BTC and ETH are reconstructed from the SAME block sequence + candle index, so their contemporaneous return
 * vectors (and seam behavior) are preserved — dependence is NOT independently normalized away. OHLC invariants hold
 * by construction (ratios of a valid source candle scaled by a positive anchor). Deterministic. Provenance ⇒
 * HISTORICAL_BOOTSTRAP.
 */
export function assembleReturnSpaceBootstrapPath(source: readonly CommonMarketFrame[], blocks: readonly BlockRef[], args: { runId: string; symbols: string[]; startMs: number; stepMs: number; method: BlockSelectionMethod; tolerances?: StitchTolerances }): BootstrapResult {
  const frames: CommonMarketFrame[] = [];
  const stitches: StitchAssessment[] = [];
  let rejected = 0;
  const anchor: Record<string, number> = {}; // running GENERATED close per symbol
  let tOpen = args.startMs;
  let prevLast: CommonMarketFrame | null = null;

  for (const [bi, block] of blocks.entries()) {
    const slice = source.slice(block.startIndex, block.startIndex + block.length);
    if (slice.length === 0) continue;
    const stitchStartIndex = frames.length;
    for (let j = 0; j < slice.length; j += 1) {
      const openTimeMs = tOpen; const closeTimeMs = tOpen + args.stepMs;
      const symbols: Record<string, SymbolFrameInput> = {};
      for (const sym of args.symbols) {
        const sc = slice[j]!.symbols[sym]?.candle.value;
        if (!sc || !(sc.open > 0) || !(sc.close > 0) || !(sc.high > 0) || !(sc.low > 0)) { symbols[sym] = { candle: null, source: `rspace:${sym}:blk${bi}` }; continue; }
        const prevGen = anchor[sym];
        let newOpen: number;
        if (prevGen === undefined) {
          newOpen = sc.open; // very first candle of the whole path: start at the real source level
        } else if (j === 0) {
          newOpen = prevGen; // SEAM: open at the previous generated close — NO artificial cross-block gap
        } else {
          const srcPrev = slice[j - 1]!.symbols[sym]?.candle.value;
          const openGap = srcPrev && srcPrev.close > 0 ? sc.open / srcPrev.close : 1; // within-block open-gap return
          newOpen = prevGen * openGap;
        }
        const newClose = newOpen * (sc.close / sc.open);
        const newHigh = newOpen * (sc.high / sc.open);
        const newLow = newOpen * (sc.low / sc.open);
        anchor[sym] = newClose;
        symbols[sym] = { candle: { openTimeMs, closeTimeMs, open: newOpen, high: newHigh, low: newLow, close: newClose, volume: sc.volume }, source: `rspace:${sym}:blk${bi}` };
      }
      frames.push(buildCommonMarketFrame({ runId: args.runId, asOfMs: closeTimeMs, symbols, provenance: "HISTORICAL_BOOTSTRAP" }));
      tOpen = closeTimeMs;
    }
    // Seam assessment on the RECONSTRUCTED frames (price gap ≈ 0 by construction — that is the point; a seam is
    // rejected only if the reconstructed transition is still genuinely implausible, e.g. an extreme first-candle move).
    if (prevLast && frames.length > stitchStartIndex) {
      const st = assessStitch(prevLast, frames[stitchStartIndex]!, args.symbols, args.tolerances);
      stitches.push(st);
      if (!st.accepted) rejected += 1;
    }
    prevLast = frames.at(-1)!;
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
