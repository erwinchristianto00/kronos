/**
 * Common market-frame builder + validators (Market Digital Twin, Phase-1 foundation). Every path (replay,
 * bootstrap, calibrated, stress) produces this SAME frame so downstream code is source-agnostic while provenance is
 * preserved. Pure. Unsupported dimensions (spread, liquidity, OI, liq-flow, order-flow) default to UNSUPPORTED —
 * they are NOT fabricated; a source may upgrade a dimension to PRESENT only when it genuinely observed it.
 */
import { stableHash } from "../lib/replay-provenance.js";
import type { SimulationProvenance } from "./simulation-provenance.js";
import type { Candle, CommonMarketFrame, MarketObservation, SymbolFrame } from "./simulation-types.js";
import { observed, unsupported, missing } from "./simulation-types.js";

export interface SymbolFrameInput {
  candle: Candle | null;
  markPrice?: number | null;
  fundingRate?: number | null;
  /** availableAtMs default = the field's observedAtMs (candle closeTimeMs) — no artificial feed latency unless given. */
  availableAtMs?: number;
  source: string;
  /** Optionally supply genuinely-observed extra dimensions; omitted ones stay UNSUPPORTED (honest default). */
  spreadBps?: number | null;
  liquidity?: number | null;
  openInterest?: number | null;
  liquidationFlow?: number | null;
  orderFlow?: number | null;
}

function obsOrMissing<T>(value: T | null | undefined, observedAtMs: number, availableAtMs: number, source: string, provenance: SimulationProvenance | "OBSERVED"): MarketObservation<T> {
  return value == null ? missing<T>(source) : observed<T>(value, observedAtMs, availableAtMs, source, provenance);
}

/** Build a single symbol's frame. Candle drives the timestamps; a null candle ⇒ the whole symbol is a GAP. */
export function buildSymbolFrame(input: SymbolFrameInput, provenance: SimulationProvenance): SymbolFrame {
  const src = input.source;
  if (!input.candle) {
    return {
      candle: missing<Candle>(src, "GAP"), markPrice: missing<number>(src, "GAP"), fundingRate: missing<number>(src, "GAP"),
      spreadBps: unsupported<number>(src), liquidity: unsupported<number>(src), openInterest: unsupported<number>(src),
      liquidationFlow: unsupported<number>(src), orderFlow: unsupported<number>(src),
    };
  }
  const observedAtMs = input.candle.closeTimeMs; // a candle is knowable only at its close
  const availableAtMs = Math.max(input.availableAtMs ?? observedAtMs, observedAtMs);
  return {
    candle: observed<Candle>(input.candle, observedAtMs, availableAtMs, src, provenance),
    markPrice: obsOrMissing<number>(input.markPrice, observedAtMs, availableAtMs, src, provenance),
    fundingRate: obsOrMissing<number>(input.fundingRate, observedAtMs, availableAtMs, src, provenance),
    // Dimensions the Tier-A candle corpus does NOT observe stay UNSUPPORTED unless the caller genuinely has them.
    spreadBps: input.spreadBps == null ? unsupported<number>(src) : observed<number>(input.spreadBps, observedAtMs, availableAtMs, src, provenance),
    liquidity: input.liquidity == null ? unsupported<number>(src) : observed<number>(input.liquidity, observedAtMs, availableAtMs, src, provenance),
    openInterest: input.openInterest == null ? unsupported<number>(src) : observed<number>(input.openInterest, observedAtMs, availableAtMs, src, provenance),
    liquidationFlow: input.liquidationFlow == null ? unsupported<number>(src) : observed<number>(input.liquidationFlow, observedAtMs, availableAtMs, src, provenance),
    orderFlow: input.orderFlow == null ? unsupported<number>(src) : observed<number>(input.orderFlow, observedAtMs, availableAtMs, src, provenance),
  };
}

export function buildCommonMarketFrame(args: { runId: string; asOfMs: number; symbols: Record<string, SymbolFrameInput>; provenance: SimulationProvenance; hiddenStateRef?: string | null; observedViewRef?: string }): CommonMarketFrame {
  const symbols: Record<string, SymbolFrame> = {};
  for (const [sym, input] of Object.entries(args.symbols)) symbols[sym] = buildSymbolFrame(input, args.provenance);
  // Deterministic frameId from (runId, asOf, provenance, per-symbol candle identity) — stable across runs.
  const identity = Object.entries(symbols)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([sym, sf]) => [sym, sf.candle.status, sf.candle.value?.openTimeMs ?? null, sf.candle.value?.close ?? null]);
  const frameId = stableHash([args.runId, args.asOfMs, args.provenance, identity]).slice(0, 24);
  return {
    frameId, runId: args.runId, asOfMs: args.asOfMs, symbols,
    hiddenStateRef: args.hiddenStateRef ?? null, observedViewRef: args.observedViewRef ?? frameId, provenance: args.provenance,
  };
}

export interface FrameInvariantResult { ok: boolean; violations: string[]; }

/** OHLC/positivity/finiteness invariants for a PRESENT candle. Returns violations; never throws. */
export function validateFrameInvariants(frame: CommonMarketFrame): FrameInvariantResult {
  const violations: string[] = [];
  for (const [sym, sf] of Object.entries(frame.symbols)) {
    const c = sf.candle;
    if (c.status !== "PRESENT" || !c.value) continue;
    const { open, high, low, close, volume, openTimeMs, closeTimeMs } = c.value;
    for (const [n, v] of [["open", open], ["high", high], ["low", low], ["close", close], ["volume", volume]] as const) {
      if (!Number.isFinite(v)) violations.push(`${sym}.${n} not finite`);
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) violations.push(`${sym} non-positive price`);
    if (volume < 0) violations.push(`${sym} negative volume`);
    if (high < Math.max(open, close, low)) violations.push(`${sym} high < max(open,close,low)`);
    if (low > Math.min(open, close, high)) violations.push(`${sym} low > min(open,close,high)`);
    if (closeTimeMs <= openTimeMs) violations.push(`${sym} closeTime ≤ openTime`);
  }
  return { ok: violations.length === 0, violations };
}
