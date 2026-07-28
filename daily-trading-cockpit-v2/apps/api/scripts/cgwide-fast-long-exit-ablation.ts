/**
 * CG_WIDE_FAST_LONG exit-architecture ablation (Tier-2 audit item 5, OFFLINE ANALYSIS ONLY).
 *
 * Re-walks the REAL historical CG_WIDE_FAST_LONG entries (same source signal, same entry price,
 * same wide (>=300bps) stop distance — the only thing this lane's own geometry actually fixes)
 * through several candidate exit ARCHITECTURES, using the exact same candle-walk engine
 * (walkVariantPath / walkPyramidOnConfirmedWinner) the live report-only harness already uses, so
 * the comparison is apples-to-apples: every architecture sees the same entries, resolved by the
 * same conservative (SL-first-on-ambiguity) engine.
 *
 * Each candidate keeps CG_WIDE_FAST_LONG's own entry price + stop distance (risk), but derives its
 * OWN target price at its own idiomatic reward multiple — mirroring how each exitRule is actually
 * paired with a target elsewhere in VARIANT_MATRIX_DEFINITIONS (e.g. CG_MFE_GIVEBACK needs a FAR
 * target to have room to fire; CG_WIDE_FAST_LONG itself uses a near 0.5R target). The table below
 * prints exactly which target multiple each row used, so the comparison basis is never hidden.
 *
 * This script NEVER touches live execution, the paper book, or shadow-positions.json. It reads the
 * variant-matrix's own isolated store (data/current-guard-variant-matrix.json) read-only and hits
 * Binance for historical candles. Needs network access (WARP/proxy if geo-blocked). Read-only;
 * mutates nothing.
 *
 * Usage: npx tsx apps/api/scripts/cgwide-fast-long-exit-ablation.ts [--data-dir data] [--horizon-days 10]
 */
import { BinanceClient } from "../src/lib/binance.js";
import {
  getCurrentGuardVariantMatrixStore,
  walkVariantPath,
  walkPyramidOnConfirmedWinner,
  TAKER_ROUNDTRIP_BPS,
  STOP_OUT_SLIPPAGE_BPS,
  type CurrentGuardVariantMatrixObservation,
  type KlineTuple,
  type VariantExitRule,
  type VariantWalkResult,
} from "../src/lib/current-guard-variant-matrix.js";

const CANDLE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Comparison table. Each row keeps the SAME entry price + stop distance as the real
// CG_WIDE_FAST_LONG signal; only the exit architecture (and its own idiomatic target multiple)
// differs. `isPyramid` routes that one row through walkPyramidOnConfirmedWinner instead.
// ---------------------------------------------------------------------------
export interface ComparisonVariant {
  key: string;
  exitRule: VariantExitRule;
  targetRewardMultiple: number;
  isPyramid?: boolean;
}

export const COMPARISON_VARIANTS: readonly ComparisonVariant[] = [
  { key: "tp1_full @0.5R (current CG_WIDE_FAST_LONG)", exitRule: "tp1_full", targetRewardMultiple: 0.5 },
  { key: "trail_after_tp1 @0.5R arm", exitRule: "trail_after_tp1", targetRewardMultiple: 0.5 },
  { key: "scaleout_tp1_trail @0.5R", exitRule: "scaleout_tp1_trail", targetRewardMultiple: 0.5 },
  { key: "mfe_giveback @3R far TP", exitRule: "mfe_giveback", targetRewardMultiple: 3 },
  { key: "atr_trail @0.5R arm (new)", exitRule: "atr_trail", targetRewardMultiple: 0.5 },
  // The pyramid row NEEDS a target reward multiple comfortably ABOVE PYRAMID_ADD_TRIGGER_R
  // (default 1.0R): walkPyramidOnConfirmedWinner gives leg 2 the SAME target price as leg 1, so
  // if the target were reached before (or at) the add level, leg 2 would inherit a target at or
  // below its own entry — an inverted, meaningless geometry. 2R stays safely above the 1.0R add
  // trigger for any monotonic path, and reflects a more realistic "pyramid into a trade that's
  // proven itself, then let the combined position run further" architecture (vs. the near-0.5R
  // single-entry baseline).
  {
    key: "pyramid_on_confirmed_winner (base tp1_full @2R, add @1.0R) (new)",
    exitRule: "tp1_full",
    targetRewardMultiple: 2,
    isPyramid: true,
  },
];

export interface EntryLike {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  stopDistanceBps: number;
  openedAtMs: number;
}

export interface VariantOutcome {
  netR: number | null;
  grossR: number | null;
  status: string;
  resolutionSource: string | null;
}

function targetPriceFor(entry: EntryLike, rewardMultiple: number): number {
  const risk = entry.direction === "LONG" ? entry.entryPrice - entry.stopLoss : entry.stopLoss - entry.entryPrice;
  return entry.direction === "LONG"
    ? entry.entryPrice + rewardMultiple * risk
    : entry.entryPrice - rewardMultiple * risk;
}

/** costR = round-trip bps / stop-distance bps, PLUS stop-out slippage on losers/giveback exits —
 *  the exact honest cost model resolveVariantMatrixObservations already applies. */
function netROf(walk: VariantWalkResult, stopDistanceBps: number): number | null {
  if (typeof walk.grossR !== "number" || !Number.isFinite(walk.grossR)) return null;
  const stopTriggeredExit = walk.status === "CLOSED_LOSS" || walk.resolutionSource === "MFE_GIVEBACK_EXIT";
  const costR = TAKER_ROUNDTRIP_BPS / stopDistanceBps + (stopTriggeredExit ? STOP_OUT_SLIPPAGE_BPS / stopDistanceBps : 0);
  return walk.grossR - costR;
}

/**
 * Runs ONE real entry through every row of COMPARISON_VARIANTS using the SAME candle path. Pure
 * (aside from the walk functions' optional 1m-resolve callback); no I/O. Exported so tests can
 * exercise it with synthetic candles instead of live Binance data.
 */
export async function simulateEntryAcrossVariants(
  entry: EntryLike,
  candles: KlineTuple[],
  resolve1m?: (fillCandleOpenMs: number) => Promise<"SL" | "TP" | null>,
): Promise<Map<string, VariantOutcome>> {
  const out = new Map<string, VariantOutcome>();
  for (const v of COMPARISON_VARIANTS) {
    const target = targetPriceFor(entry, v.targetRewardMultiple);
    if (v.isPyramid) {
      const pyr = await walkPyramidOnConfirmedWinner(
        {
          direction: entry.direction,
          entryPrice: entry.entryPrice,
          stopLoss: entry.stopLoss,
          target,
          exitRule: v.exitRule,
          fillMode: "taker",
          openedAtMs: entry.openedAtMs,
          candles,
        },
        resolve1m,
      );
      // Combined net R: each leg's own cost is charged against its own risk unit, then leg 2 is
      // scaled by its size multiple — mirrors walkPyramidOnConfirmedWinner's own combinedGrossR
      // convention (leg 2's risk distance mirrors leg 1's exactly, so bps-based costs are the same
      // per-unit figure for both legs).
      const net1 = netROf(pyr.leg1, entry.stopDistanceBps);
      const net2 = pyr.leg2 ? netROf(pyr.leg2, entry.stopDistanceBps) : null;
      const netR =
        net1 !== null ? net1 + (net2 !== null ? net2 * pyr.addSizeMultiple : 0) : null;
      out.set(v.key, {
        netR,
        grossR: pyr.combinedGrossR,
        status: pyr.addTriggered ? `${pyr.leg1.status}+ADD` : pyr.leg1.status,
        resolutionSource: pyr.leg1.resolutionSource,
      });
      continue;
    }
    const walk = await walkVariantPath(
      {
        direction: entry.direction,
        entryPrice: entry.entryPrice,
        stopLoss: entry.stopLoss,
        target,
        exitRule: v.exitRule,
        fillMode: "taker",
        openedAtMs: entry.openedAtMs,
        candles,
      },
      resolve1m,
    );
    out.set(v.key, {
      netR: netROf(walk, entry.stopDistanceBps),
      grossR: walk.grossR,
      status: walk.status,
      resolutionSource: walk.resolutionSource,
    });
  }
  return out;
}

export interface AggregateStat {
  n: number;
  wr: number | null;
  netAvgR: number | null;
  payoffRatio: number | null;
}

/** Aggregates one variant's outcomes across ALL entries: n (resolved CLOSED_WIN/CLOSED_LOSS only),
 *  win rate, average net R, and payoff ratio (avg win / |avg loss|). */
export function aggregateVariant(outcomes: VariantOutcome[]): AggregateStat {
  const resolved = outcomes.filter(
    (o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS" || o.status.endsWith("+ADD")) && typeof o.netR === "number",
  );
  const n = resolved.length;
  if (n === 0) return { n: 0, wr: null, netAvgR: null, payoffRatio: null };
  const netVals = resolved.map((o) => o.netR as number);
  const wins = netVals.filter((r) => r > 0);
  const losses = netVals.filter((r) => r <= 0);
  const netAvgR = netVals.reduce((a, b) => a + b, 0) / n;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : null;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : null;
  const payoffRatio = avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / Math.abs(avgLoss) : null;
  return { n, wr: wins.length / n, netAvgR, payoffRatio };
}

function fmtStat(s: AggregateStat): string {
  const wr = s.wr !== null ? `${(s.wr * 100).toFixed(1)}%` : "n/a";
  const netAvgR = s.netAvgR !== null ? s.netAvgR.toFixed(4) : "n/a";
  const payoff = s.payoffRatio !== null ? s.payoffRatio.toFixed(2) : "n/a";
  return `n=${String(s.n).padStart(4)}  WR=${wr.padStart(6)}  netAvgR=${netAvgR.padStart(8)}  payoff=${payoff.padStart(5)}`;
}

function parseArgs(argv: string[]): { dataDir: string; horizonDays: number } {
  let dataDir = "data";
  let horizonDays = 10;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--data-dir" && argv[i + 1]) dataDir = argv[i + 1]!;
    if (argv[i] === "--horizon-days" && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) horizonDays = n;
    }
  }
  return { dataDir, horizonDays };
}

function obsToEntry(obs: CurrentGuardVariantMatrixObservation): EntryLike | null {
  const E = obs.simulatedEntryPrice;
  const S = obs.simulatedStopLoss;
  const openedAtMs = Date.parse(obs.openedAt);
  if (!(E > 0) || !(S > 0) || !Number.isFinite(openedAtMs)) return null;
  if (obs.direction !== "LONG") return null; // CG_WIDE_FAST_LONG is longOnly by construction
  const stopDistanceBps = obs.stopDistanceBps ?? ((E - S) / E) * 10000;
  if (!(stopDistanceBps > 0)) return null;
  return { symbol: obs.symbol, direction: "LONG", entryPrice: E, stopLoss: S, stopDistanceBps, openedAtMs };
}

async function main(): Promise<void> {
  const { dataDir, horizonDays } = parseArgs(process.argv.slice(2));
  const store = getCurrentGuardVariantMatrixStore(dataDir);
  const seen = new Set<string>();
  const entries: EntryLike[] = [];
  for (const obs of store.all) {
    if (obs.variantId !== "CG_WIDE_FAST_LONG") continue;
    if (seen.has(obs.sourceObservationKey)) continue;
    seen.add(obs.sourceObservationKey);
    const entry = obsToEntry(obs);
    if (entry) entries.push(entry);
  }
  console.log(`CG_WIDE_FAST_LONG unique source entries: ${entries.length}`);
  if (entries.length === 0) {
    console.log(`No CG_WIDE_FAST_LONG observations found in ${dataDir}/current-guard-variant-matrix.json — nothing to ablate.`);
    return;
  }

  const binance = new BinanceClient();
  const nowMs = Date.now();
  const horizonMs = horizonDays * 24 * 60 * 60 * 1000;

  const byVariant = new Map<string, VariantOutcome[]>();
  for (const v of COMPARISON_VARIANTS) byVariant.set(v.key, []);

  let done = 0;
  for (const entry of entries) {
    const startTime = entry.openedAtMs - CANDLE_MS;
    const endTime = Math.min(nowMs, entry.openedAtMs + horizonMs);
    let candles: KlineTuple[];
    try {
      const raw = await binance.getCandles(entry.symbol, "5m", Math.min(Math.max(Math.ceil((endTime - startTime) / CANDLE_MS) + 2, 12), 1000), {
        startTime,
        endTime,
      });
      candles = raw.map((c) => [c.openTime, "0", String(c.high), String(c.low), String(c.close), "0", c.openTime + CANDLE_MS] as KlineTuple);
    } catch {
      continue; // data-failure — skip this entry for every variant (fair: same skip for all rows)
    }
    const outcomes = await simulateEntryAcrossVariants(entry, candles);
    for (const [key, outcome] of outcomes) byVariant.get(key)!.push(outcome);
    done += 1;
    if (done % 200 === 0) console.error(`  …${done}/${entries.length}`);
  }

  console.log(`\n===== CG_WIDE_FAST_LONG exit-architecture ablation (real entries, honest ideal fills) =====`);
  console.log(`Cost model: taker round-trip ${TAKER_ROUNDTRIP_BPS}bps/stopDistanceBps + ${STOP_OUT_SLIPPAGE_BPS}bps stop-out slippage on losers/giveback exits.\n`);
  for (const v of COMPARISON_VARIANTS) {
    const stat = aggregateVariant(byVariant.get(v.key) ?? []);
    console.log(`${v.key.padEnd(62)} ${fmtStat(stat)}`);
  }
}

// Only auto-run when executed directly (`npx tsx cgwide-fast-long-exit-ablation.ts`), never when
// imported — this file's pure helpers (simulateEntryAcrossVariants, aggregateVariant,
// COMPARISON_VARIANTS) are unit-tested by importing this module directly, and that must never
// trigger a live Binance fetch or a real-data-store read as a side effect.
const isMainModule = Boolean(process.argv[1]) && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
