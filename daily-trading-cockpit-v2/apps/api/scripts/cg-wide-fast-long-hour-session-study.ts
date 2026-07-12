/**
 * CG_WIDE_FAST_LONG intraday/session (UTC entry-hour) interaction study — operator research brief
 * Task 4, 2026-07-10. Pure OFFLINE ANALYSIS/RESEARCH: read-only, mutates nothing, never touches live
 * trading behavior (no exit rule, no allocation, no execution path is read or written by this file).
 *
 * GOAL (verbatim from the brief): an earlier, cruder pass over this lane's real trades found 04h UTC
 * entries lost ~$2.69 (n=12) while 16h-17h UTC entries made ~$3.05 combined (n=20). This is NOT license
 * to hardcode a time filter — this script instead builds a controlled study to determine WHETHER, and
 * WHY, UTC entry hour matters: a genuine source of edge, a proxy for volatility, a proxy for specific
 * symbols/clusters, or just small-sample noise — using only honestly-available features.
 *
 * DATA SOURCE: this script does NOT re-run the candle-walk/backfill itself. It consumes Task 2's
 * already-persisted per-trade classification records (see PATH_CLASSIFICATION_INPUT_PATH below —
 * produced by backfill-cg-wide-fast-long-mfe.ts / cg-wide-fast-long-path-classification.ts), then adds
 * three honest, additive enrichments:
 *   1. feesUsd — looked up directly against the SAME live-execution store (LiveExecutionStore),
 *      matched by tradeId === LiveIntent.paperOrderId. Whole-position (un-prorated) — see the doc on
 *      HourInteractionTradeFacts.feesUsd in cg-wide-fast-long-hour-interaction.ts for why this isn't
 *      lane-share-prorated here.
 *   2. atrPct / volatilityState — entryATR/entryPrice already sits in Task 2's persisted record; this
 *      script just normalizes it to a fraction and runs the sample's own tercile split
 *      (assignVolatilityStateTerciles).
 *   3. btcMovePct / btcDirection — BTCUSDT's % return over the UTC CALENDAR HOUR containing each
 *      trade's entry, fetched via fetchCandlesRange (../src/lib/candle-range-fetch.ts — the SAME
 *      helper Task 2's backfill script uses, extracted there for exactly this reuse; see that module's
 *      doc comment). Deliberately anchored to the calendar hour, not the trade's own hold window — see
 *      HourInteractionTradeFacts.btcMovePct's doc for why.
 * cluster comes from correlation-clusters.ts's own clusterOf(symbol) — reused directly, not rebuilt.
 *
 * All actual math (metrics/rates/comparisons) is pure and lives in
 * ../src/lib/cg-wide-fast-long-hour-interaction.ts (unit-tested separately in
 * ../test/cg-wide-fast-long-hour-interaction.test.ts) — this script is I/O + report formatting only.
 *
 * EXPLICITLY SKIPPED interactions (no honestly-available historical data — see that module's top doc
 * comment for the full reasoning, restated briefly in this report's own output too):
 *   hour x breadthState, hour x liquidityState, hour x orderFlowState, hour x priceImpactEfficiencyBucket.
 *
 * feeDrag is reported here as avg $ fees only (NOT normalized to R-of-planned-risk the way the backfill
 * script's own feeDragR is) — deriving riskUsd by inverting realizedR (realizedNetPnLUsd / realizedR)
 * would be numerically unstable for near-breakeven trades and isn't machinery Task 2 exposed for reuse;
 * the raw $ figure (with its own honest sample-size count) is sufficient for this diagnostic and avoids
 * fabricating an unstable derived number.
 *
 * Usage (from repo root):
 *   cd apps/api && npx tsx scripts/cg-wide-fast-long-hour-session-study.ts [dataDir]
 *
 * PREREQUISITE: run Task 2's backfill FIRST, against the SAME dataDir, so a classification JSON exists
 * for this script to read and so the feesUsd lookup below can match real tradeIds:
 *   cd apps/api && npx tsx scripts/backfill-cg-wide-fast-long-mfe.ts [dataDir]
 *
 * dataDir defaults to apps/api/data (this repo's local/dev store — likely empty; see the operator run
 * instructions for the live VPS's data directory, same caveat as Task 2).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { LiveExecutionStore } from "../src/lib/live-execution-engine.js";
import { BinanceClient } from "../src/lib/binance.js";
import { fetchCandlesRange } from "../src/lib/candle-range-fetch.js";
import { clusterOf } from "../src/lib/correlation-clusters.js";
import type { CgWideFastLongClassifiedTradeRecord } from "../src/lib/cg-wide-fast-long-path-classification.js";
import {
  assignVolatilityStateTerciles,
  btcDirectionOf,
  buildHourComparisonReport,
  computeHourlyMetrics,
  hourXBtcDirection,
  hourXCluster,
  hourXEntryRegimeAlignment,
  hourXSymbol,
  hourXVolatilityState,
  type HourComparisonGroup,
  type HourInteractionTradeFacts,
  type TradeGroupMetrics,
} from "../src/lib/cg-wide-fast-long-hour-interaction.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

// NOTE: intentionally NOT importing backfill-cg-wide-fast-long-mfe.ts's own
// PATH_CLASSIFICATION_OUTPUT_PATH constant — that script's main() runs unconditionally at import time
// (documented in that file itself: this is exactly why Task 2 extended rather than added a sibling
// script), so importing anything from it here would trigger a full, network-heavy backfill re-run as a
// side effect of loading THIS script. This is a literal copy of that constant's value (same directory,
// same filename) for read-only consumption — not a re-derivation of any logic.
const PATH_CLASSIFICATION_INPUT_PATH = join(import.meta.dirname, "output", "cg-wide-fast-long-path-classification.json");
const OUTPUT_PATH = join(import.meta.dirname, "output", "cg-wide-fast-long-hour-session-study.json");

const COMPARISON_HOURS = { FOUR: 4, SIXTEEN: 16, SEVENTEEN: 17 } as const;

interface PersistedClassificationFile {
  generatedAt: string;
  lane: string;
  n: number;
  records: CgWideFastLongClassifiedTradeRecord[];
}

function fmt(n: number | null, digits = 4): string {
  return n === null || !Number.isFinite(n) ? "n/a" : n.toFixed(digits);
}

function fmtPct(n: number | null, digits = 2): string {
  return n === null || !Number.isFinite(n) ? "n/a" : `${(n * 100).toFixed(digits)}%`;
}

function printGroupMetricsLine(label: string, m: TradeGroupMetrics): void {
  console.log(
    `  ${label.padEnd(24)} n=${String(m.n).padStart(3)}  netPnL=${fmt(m.netPnLUsd, 2).padStart(9)}  ` +
      `avgNetR=${fmt(m.avgNetR, 3).padStart(7)}(n=${m.nWithRealizedR})  medianNetR=${fmt(m.medianNetR, 3).padStart(7)}  ` +
      `payoff=${fmt(m.payoffRatioUsd, 3).padStart(6)}  PF=${fmt(m.profitFactorUsd, 3).padStart(6)}`,
  );
  console.log(
    `  ${"".padEnd(24)} MFE=${fmt(m.avgMfeR, 3)}(n=${m.nWithMfe})  MAE=${fmt(m.avgMaeR, 3)}(n=${m.nWithMae})  ` +
      `trueExp=${fmtPct(m.trueExpansionRate, 1)}  scratch=${fmtPct(m.scratchRate, 1)}  ` +
      `toxic=${fmtPct(m.toxicReversalRate, 1)}  dead=${fmtPct(m.deadOnArrivalRate, 1)}`,
  );
  console.log(
    `  ${"".padEnd(24)} avgFeesUsd=${fmt(m.avgFeesUsd, 4)}(n=${m.nWithFeeData})  ` +
      `avgATR%=${fmtPct(m.averageAtrPct, 3)}(n=${m.nWithAtr})  ` +
      `avgBTCmove%=${fmt(m.averageBtcMovePct, 3)}(n=${m.nWithBtcData})  ` +
      `btcDir(UP/DOWN/FLAT/UNK)=${m.btcDirectionCounts.UP}/${m.btcDirectionCounts.DOWN}/${m.btcDirectionCounts.FLAT}/${m.btcDirectionCounts.UNKNOWN}`,
  );
}

function printInteractionTable(name: string, table: Map<number, Map<string, TradeGroupMetrics>>): void {
  console.log(`\n----- hour x ${name} -----`);
  for (const [hour, bySubgroup] of [...table.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${String(hour).padStart(2, "0")}h UTC (n=${[...bySubgroup.values()].reduce((s, m) => s + m.n, 0)}):`);
    for (const [subgroup, m] of [...bySubgroup.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(
        `    ${subgroup.padEnd(20)} n=${String(m.n).padStart(3)}  netPnL=${fmt(m.netPnLUsd, 2).padStart(9)}  ` +
          `avgNetR=${fmt(m.avgNetR, 3).padStart(7)}`,
      );
    }
  }
}

function nestedMapToPlainObject(table: Map<number, Map<string, TradeGroupMetrics>>): Record<string, Record<string, TradeGroupMetrics>> {
  const out: Record<string, Record<string, TradeGroupMetrics>> = {};
  for (const [hour, bySubgroup] of table) out[String(hour)] = Object.fromEntries(bySubgroup);
  return out;
}

async function main(): Promise<void> {
  const dataDirArg = process.argv[2];
  const dataDir = dataDirArg ? dataDirArg : join(import.meta.dirname, "../data");

  console.log(`Reading Task 2's persisted path-classification records from: ${PATH_CLASSIFICATION_INPUT_PATH}`);
  if (!existsSync(PATH_CLASSIFICATION_INPUT_PATH)) {
    console.log(
      `\nNo classification file found at that path. Run Task 2's backfill FIRST, against the SAME ` +
        `dataDir you want to analyze here:\n` +
        `  cd apps/api && npx tsx scripts/backfill-cg-wide-fast-long-mfe.ts ${dataDir}\n` +
        `then re-run this script:\n` +
        `  cd apps/api && npx tsx scripts/cg-wide-fast-long-hour-session-study.ts ${dataDir}`,
    );
    return;
  }

  let parsed: PersistedClassificationFile;
  try {
    parsed = JSON.parse(readFileSync(PATH_CLASSIFICATION_INPUT_PATH, "utf-8")) as PersistedClassificationFile;
  } catch (err) {
    console.error(`Failed to parse ${PATH_CLASSIFICATION_INPUT_PATH}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const records = parsed.records ?? [];
  console.log(`Loaded ${records.length} classified real CG_WIDE_FAST_LONG trades (generated ${parsed.generatedAt}).`);
  if (records.length === 0) {
    console.log(
      "\nNothing to analyze — 0 classified trades in the persisted file. This matches the case where the " +
        "local dev store's live-execution.json has no real closed CG_WIDE_FAST_LONG intents (see Task 2's own " +
        "report). Point --dataDir at a copy of the live VPS's apps/api/data directory and re-run both scripts.",
    );
    return;
  }

  // ── feesUsd lookup (honest, whole-position, un-prorated) ───────────────────────────────────────
  console.log(`\nLooking up feesUsd against the live-execution store at: ${dataDir}`);
  const store = new LiveExecutionStore(dataDir);
  const intentById = new Map(store.getState().intents.map((i) => [i.paperOrderId, i]));
  let feesMatched = 0;

  // ── BTC candle fetch, per DISTINCT containing UTC calendar hour (dedup network calls) ──────────
  const binance = new BinanceClient();
  const btcMoveByHourStart = new Map<number, number | null>();
  async function btcMoveForHourStart(hourStartMs: number): Promise<number | null> {
    if (btcMoveByHourStart.has(hourStartMs)) return btcMoveByHourStart.get(hourStartMs)!;
    let move: number | null = null;
    try {
      const candles = await fetchCandlesRange(binance, "BTCUSDT", hourStartMs, hourStartMs + ONE_HOUR_MS);
      const inHour = candles.filter((c) => c.openTime >= hourStartMs && c.openTime < hourStartMs + ONE_HOUR_MS);
      if (inHour.length > 0) {
        const openPrice = inHour[0]!.open;
        const closePrice = inHour[inHour.length - 1]!.close;
        if (openPrice > 0) move = ((closePrice - openPrice) / openPrice) * 100;
      }
    } catch (err) {
      console.warn(`  [btcMove] hour ${new Date(hourStartMs).toISOString()} — fetch failed: ${(err as Error).message}`);
    }
    btcMoveByHourStart.set(hourStartMs, move);
    return move;
  }

  const atrPcts: Array<number | null> = [];
  type PreVolatility = Omit<HourInteractionTradeFacts, "volatilityState">;
  const enriched: PreVolatility[] = [];

  let processed = 0;
  for (const r of records) {
    processed += 1;
    const intent = intentById.get(r.tradeId);
    const feesUsd = intent?.feesUsd ?? null;
    if (feesUsd !== null) feesMatched += 1;

    const atrPct = r.entryATR !== null && r.entryPrice > 0 ? r.entryATR / r.entryPrice : null;
    atrPcts.push(atrPct);

    const entryMs = Date.parse(r.entryTimestamp);
    const hourStartMs = Number.isFinite(entryMs) ? Math.floor(entryMs / ONE_HOUR_MS) * ONE_HOUR_MS : null;
    const btcMovePct = hourStartMs !== null ? await btcMoveForHourStart(hourStartMs) : null;

    enriched.push({
      tradeId: r.tradeId,
      symbol: r.symbol,
      cluster: clusterOf(r.symbol),
      entryHourUtc: r.entryHourUtc,
      entryRegimeAlignment: r.entryRegimeAlignment,
      pathClass: r.pathClass,
      realizedNetPnLUsd: r.realizedNetPnLUsd,
      realizedR: r.realizedR,
      maxMfeR: r.maxMfeR,
      minMaeR: r.minMaeR,
      feesUsd,
      atrPct,
      btcMovePct,
      btcDirection: btcDirectionOf(btcMovePct),
    });
    if (processed % 25 === 0) console.error(`  ...enriched ${processed}/${records.length}`);
  }

  const volatilityStates = assignVolatilityStateTerciles(atrPcts);
  const facts: HourInteractionTradeFacts[] = enriched.map((e, i) => ({ ...e, volatilityState: volatilityStates[i]! }));

  console.log(
    `\nfeesUsd matched (non-null) for ${feesMatched}/${records.length} trades (whole-position, un-prorated). ` +
      (feesMatched / records.length < 0.3
        ? "Consistent with the earlier finding that feesUsd is mostly null on this lane's real intents — " +
          "feeDrag below is honest but low-sample."
        : "NOTE: this diverges from the earlier 'feesUsd mostly null' finding — worth flagging to the operator."),
  );
  const btcMatched = facts.filter((f) => f.btcMovePct !== null).length;
  console.log(`BTC hourly move resolved for ${btcMatched}/${records.length} trades (${btcMoveByHourStart.size} distinct UTC hours fetched).`);

  console.log(
    "\nEXPLICITLY SKIPPED interactions (no honestly-available historical data for these 79 trades — never " +
      "fabricated): hour x breadthState, hour x liquidityState, hour x orderFlowState, " +
      "hour x priceImpactEfficiencyBucket. See cg-wide-fast-long-hour-interaction.ts's top doc comment for why " +
      "each collector did not exist when these trades were entered.",
  );

  // ── Per-hour breakdown (the brief's primary ask) ───────────────────────────────────────────────
  const hourly = computeHourlyMetrics(facts);
  console.log(
    `\n===== CG_WIDE_FAST_LONG hour-of-day breakdown — ${records.length} real trades across ` +
      `${hourly.length} distinct UTC entry hours =====`,
  );
  console.log(
    "(Most hour buckets below are single-digit to low-teens n — read every per-hour figure as directional " +
      "only, never as a standalone conclusion.)",
  );
  for (const h of hourly) printGroupMetricsLine(`${String(h.hourUtc).padStart(2, "0")}h UTC`, h);

  // ── Interactions (only where honestly-available underlying data exists) ───────────────────────
  printInteractionTable("volatilityState (entryATR/entryPrice tercile)", hourXVolatilityState(facts));
  printInteractionTable("BTCDirection (BTC's own-hour return)", hourXBtcDirection(facts));
  printInteractionTable("symbol", hourXSymbol(facts));
  printInteractionTable("cluster (correlation-clusters.ts)", hourXCluster(facts));
  printInteractionTable("entryRegimeAlignment", hourXEntryRegimeAlignment(facts));

  // ── Explicit 04 / 16 / 17 / all-other-hours-combined side-by-side comparison ───────────────────
  const specialHours = new Set<number>([COMPARISON_HOURS.FOUR, COMPARISON_HOURS.SIXTEEN, COMPARISON_HOURS.SEVENTEEN]);
  const otherHours = Array.from({ length: 24 }, (_, h) => h).filter((h) => !specialHours.has(h));
  const comparisonGroups: HourComparisonGroup[] = buildHourComparisonReport(facts, [
    { label: "04 UTC", hours: [COMPARISON_HOURS.FOUR] },
    { label: "16 UTC", hours: [COMPARISON_HOURS.SIXTEEN] },
    { label: "17 UTC", hours: [COMPARISON_HOURS.SEVENTEEN] },
    { label: "All other hours combined", hours: otherHours },
  ]);

  console.log(
    "\n===== Explicit comparison: 04 UTC vs 16 UTC vs 17 UTC vs all other hours combined =====\n" +
      "(a) average volatility/ATR%   (b) symbol/cluster dominance   (c) BTC direction/move   (d) is there any " +
      "clear explanatory feature, or does this look like small-sample noise? — the raw numbers below answer " +
      "(a)-(c) directly; (d) is a judgment call for the reader given each group's own n, NOT asserted here.",
  );
  for (const g of comparisonGroups) {
    console.log(`\n-- ${g.label} (hours: ${g.hours.length <= 3 ? g.hours.join(",") : `${g.hours.length} hours`}) --`);
    printGroupMetricsLine(g.label, g.metrics);
    console.log(
      `  ${"".padEnd(24)} dominantSymbol=${g.dominantSymbol ? `${g.dominantSymbol.key} (${fmtPct(g.dominantSymbol.share, 1)} of n=${g.dominantSymbol.n})` : "n/a"}  ` +
        `dominantCluster=${g.dominantCluster ? `${g.dominantCluster.key} (${fmtPct(g.dominantCluster.share, 1)} of n=${g.dominantCluster.n})` : "n/a"}`,
    );
  }
  console.log(
    "\n(Reminder: the ORIGINAL finding this study investigates was 04h≈-$2.69/n=12, 16h+17h≈+$3.05/n=20 from an " +
      "earlier, cruder pass. The n/netPnL above are THIS run's own honest recount from the real ledger + candle " +
      "walk — treat any difference from those earlier headline numbers as the more careful figure, not a " +
      "contradiction to resolve.)",
  );

  // ── Persist full study output ───────────────────────────────────────────────────────────────────
  try {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(
      OUTPUT_PATH,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          sourceClassificationGeneratedAt: parsed.generatedAt,
          n: records.length,
          distinctHours: hourly.length,
          feesMatched,
          btcMatched,
          skippedInteractions: [
            "hour x breadthState — no market-breadth collector running historically",
            "hour x liquidityState — no depth/liquidity snapshot captured at entry historically",
            "hour x orderFlowState — taker-flow/crowding collectors built after these trades were entered",
            "hour x priceImpactEfficiencyBucket — price-impact-efficiency.ts is a same-day (2026-07-10) build",
          ],
          hourlyMetrics: hourly,
          interactions: {
            hourXVolatilityState: nestedMapToPlainObject(hourXVolatilityState(facts)),
            hourXBtcDirection: nestedMapToPlainObject(hourXBtcDirection(facts)),
            hourXSymbol: nestedMapToPlainObject(hourXSymbol(facts)),
            hourXCluster: nestedMapToPlainObject(hourXCluster(facts)),
            hourXEntryRegimeAlignment: nestedMapToPlainObject(hourXEntryRegimeAlignment(facts)),
          },
          comparisonGroups,
          perTradeFacts: facts,
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`\nPersisted the full hour-session study to ${OUTPUT_PATH}`);
  } catch (err) {
    console.warn(`\n[persist] failed to write ${OUTPUT_PATH}: ${(err as Error).message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
