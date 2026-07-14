/**
 * Six-month Entry/Exit counterfactual datasets (Track 3, offline, report-only). Evaluates PRE-REGISTERED entry +
 * exit policies over the 6mo BTC/ETH candle corpus using the tested counterfactual builder. FROZEN policy defs /
 * horizons / stops / costs / thresholds / features (declared here, never tuned after seeing results). Candle-only:
 * rows are classified SILVER/REPLAY_ONLY/AMBIGUOUS_INTRABAR/MISSING_FEATURES/LABEL_UNSAFE — NEVER execution GOLD.
 * Conservative adverse-first intrabar rule ⇒ ambiguous rows flagged, never silently resolved to the profit path.
 * Chronological walk-forward with purge/embargo; the final holdout is never used for selection. Deterministic
 * (seeded day-clustered bootstrap). No live/beta/CORTEX/executor/authority touch.
 *
 *   Usage: npx tsx scripts/replay-entry-exit-6mo-run.ts <klinesDir> <outDir>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { computeATR } from "../src/lib/candle-indicators.js";
import { parseKlines, reconstructSymbol, RISK_ATR_MULT, EXEC_LEVELS, monthKey, dayKey, HOUR } from "../src/lib/replay-tier-a-core.js";
import { stableHash } from "../src/lib/replay-provenance.js";
import { simulateExecution, totalExecutionCostR } from "../src/lib/replay-execution-emulator.js";
import { evaluateEntryActions, evaluateExitActions, type PathCandle, type Direction, type EntryParams, type ExitParams } from "../src/lib/entry-exit-counterfactual.js";
import { planWalkForward, quantile } from "../src/lib/backfill-walkforward.js";
import { clusteredBootstrapMeanCI, mean } from "../src/lib/replay-tier-a-metrics.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
const MONTHS = ["01", "02", "03", "04", "05", "06"] as const;
// ── FROZEN policy definitions (pre-registered; do NOT tune after viewing results) ──
const WARMUP = 60, HORIZON = 24, WAIT_WINDOW = 6, PULLBACK_FRAC = 0.5, BREAKOUT_FRAC = 0.5, CONFIRM_BARS = 2, TRAIL_FRAC = 0.75, TP_R = 2;
const COST_LEVELS = ["L0", "L1_base", "L1_high"] as const;
const round = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const dist = (a: string[]) => a.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});

type QualityStatus = "SILVER_NO_MICROSTRUCTURE" | "REPLAY_ONLY" | "AMBIGUOUS_INTRABAR" | "MISSING_FEATURES" | "LABEL_UNSAFE";
interface Row {
  symbol: string; tMs: number; month: string; day: number; side: Direction; family: string;
  status: QualityStatus; entry: ReturnType<typeof evaluateEntryActions>; exit: ReturnType<typeof evaluateExitActions>;
  ambiguous: boolean;
}

function roundTripCostR(entry: number, risk: number, level: (typeof COST_LEVELS)[number]): number {
  const oneWay = totalExecutionCostR(simulateExecution({ orderId: "c", decisionId: "c", side: "BUY", type: "MARKET", requestedQty: 1, referencePrice: entry, riskDistancePrice: risk, submittedAtMs: 0 }, EXEC_LEVELS[level]));
  return 2 * oneWay;
}

function main(): void {
  const klinesDir = process.argv[2]!;
  const outDir = process.argv[3] ?? "artifacts/redirect/entry-exit-6mo";
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const rowsByLevel: Record<string, Row[]> = { L0: [], L1_base: [], L1_high: [] };
  for (const symbol of SYMBOLS) {
    const candles = MONTHS.flatMap((mm) => { const p = join(klinesDir, `${symbol}-1h-2026-${mm}`, `${symbol}-1h-2026-${mm}.csv`); return existsSync(p) ? parseKlines(readFileSync(p, "utf8")) : []; }).sort((a, b) => a.openTime - b.openTime);
    const atr14 = computeATR(candles, 14);
    const familyByT = new Map<number, string>();
    for (const r of reconstructSymbol(symbol, candles).marketRows) familyByT.set(r.tMs, r.family);
    const path: PathCandle[] = candles.map((c) => ({ openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close }));

    for (let i = WARMUP; i < candles.length; i += 1) {
      const c = candles[i]!; const risk = RISK_ATR_MULT * (atr14[i] ?? NaN);
      const decisionAtMs = c.closeTime + 1; const family = familyByT.get(decisionAtMs) ?? "UNKNOWN";
      const featuresPresent = Number.isFinite(risk) && risk > 0;
      const enoughForward = i + HORIZON < candles.length;
      for (const side of ["LONG", "SHORT"] as Direction[]) {
        for (const level of COST_LEVELS) {
          const costRT = featuresPresent ? roundTripCostR(c.close, risk, level) : 0;
          const slice = path.slice(i, Math.min(path.length, i + HORIZON + WAIT_WINDOW + 1));
          const eParams: EntryParams = { direction: side, riskDistance: risk, horizonBars: HORIZON, costRoundTripR: costRT, waitWindowBars: WAIT_WINDOW, pullbackFrac: PULLBACK_FRAC, breakoutFrac: BREAKOUT_FRAC, confirmBars: CONFIRM_BARS };
          const xParams: ExitParams = { direction: side, riskDistance: risk, horizonBars: HORIZON, costRoundTripR: costRT, trailFrac: TRAIL_FRAC, tpR: TP_R };
          const entry = featuresPresent && enoughForward ? evaluateEntryActions(slice, eParams) : [];
          const exit = featuresPresent && enoughForward ? evaluateExitActions(slice, xParams) : [];
          const ambiguous = entry.some((e) => e.outcome.ambiguousIntrabar);
          const status: QualityStatus = !featuresPresent ? "MISSING_FEATURES" : !enoughForward ? "LABEL_UNSAFE" : ambiguous ? "AMBIGUOUS_INTRABAR" : "SILVER_NO_MICROSTRUCTURE";
          rowsByLevel[level]!.push({ symbol, tMs: decisionAtMs, month: monthKey(decisionAtMs), day: dayKey(decisionAtMs), side, family, status, entry, exit, ambiguous });
        }
      }
    }
  }

  // ── Aggregation helpers (usable = SILVER only; AMBIGUOUS/MISSING/LABEL_UNSAFE excluded from headline means) ──
  const usable = (rows: Row[]) => rows.filter((r) => r.status === "SILVER_NO_MICROSTRUCTURE");
  const entryAgg = (rows: Row[]) => {
    const acts = ["ENTER_NOW", "WAIT_PULLBACK", "WAIT_BREAKOUT", "WAIT_CONFIRMATION", "SKIP"] as const;
    const out: Record<string, unknown> = {};
    for (const a of acts) {
      const rs = rows.map((r) => r.entry.find((e) => e.action === a)).filter(Boolean) as NonNullable<Row["entry"][number]>[];
      const entered = rs.filter((r) => r.outcome.entered);
      const ci = clusteredBootstrapMeanCI(entered.filter((r) => r.outcome.netR != null).map((r) => ({ dayKey: 0, value: r.outcome.netR! })), { iters: 1000, seed: a.length + 3 });
      out[a] = { n: rs.length, enteredRate: round(rs.length ? entered.length / rs.length : 0), meanNetR: round(mean(entered.map((r) => r.outcome.netR ?? NaN))), stopOutRate: round(entered.length ? entered.filter((r) => r.outcome.stoppedOut).length / entered.length : null), meanMaeR: round(mean(entered.map((r) => r.outcome.maeR ?? NaN))), meanTimeToMfe: round(mean(entered.map((r) => r.outcome.timeToMfeBars ?? NaN))), meanChaseR: round(mean(entered.map((r) => r.chaseCostR ?? NaN))), meanEfficiency: round(mean(entered.map((r) => r.entryEfficiency ?? NaN))) };
    }
    return out;
  };
  const exitAgg = (rows: Row[]) => {
    const acts = ["HOLD", "EXIT_NOW", "SCALE_OUT", "TRAIL", "INCUMBENT_TP_SL"] as const;
    const out: Record<string, unknown> = {};
    for (const a of acts) {
      const rs = rows.map((r) => r.exit.find((e) => e.action === a)).filter(Boolean) as NonNullable<Row["exit"][number]>[];
      out[a] = { n: rs.length, finalNetR: round(mean(rs.map((r) => r.finalNetR ?? NaN))), capturedMfe: round(mean(rs.map((r) => r.capturedMfe ?? NaN))), givebackR: round(mean(rs.map((r) => r.givebackR ?? NaN))), avoidedLossR: round(mean(rs.map((r) => r.avoidedLossR ?? NaN))), prematureExitCostR: round(mean(rs.map((r) => r.prematureExitCostR ?? NaN))) };
    }
    return out;
  };
  const dayCI = (rows: Row[], sel: (r: Row) => number | null) => { const pts = rows.map((r) => ({ dayKey: r.day, value: sel(r) })).filter((p) => p.value != null) as { dayKey: number; value: number }[]; const ci = clusteredBootstrapMeanCI(pts, { iters: 2000, seed: 0xE71 }); return { point: round(ci.point), lo: round(ci.lo), hi: round(ci.hi), dayBlocks: ci.blocks }; };
  const enterNowNetR = (r: Row) => r.entry.find((e) => e.action === "ENTER_NOW")?.outcome.netR ?? null;
  const holdNetR = (r: Row) => r.exit.find((e) => e.action === "HOLD")?.finalNetR ?? null;

  // ── Walk-forward with purge/embargo (policies FROZEN — reporting stability, NOT selecting) ──
  const base = rowsByLevel.L1_base!;
  const u = usable(base);
  const wf = planWalkForward(u.map((r) => ({ tMs: r.tMs, r })), 3, 0.25);
  const embargoMs = HORIZON * HOUR;
  const folds = wf.folds.map((f) => {
    const test = f.testIdx.map((i) => (wf.sorted[i] as { r: Row }).r);
    // purge: drop test rows within H bars of the fold's own start (overlapping label windows across the seam)
    const purged = test.filter((r) => r.tMs >= f.testStartMs + embargoMs);
    return { fold: f.index, testN: test.length, purgedN: test.length - purged.length, enterNowMeanNetR: round(mean(purged.map((r) => enterNowNetR(r) ?? NaN))), holdMeanNetR: round(mean(purged.map((r) => holdNetR(r) ?? NaN))) };
  });
  const holdoutRows = wf.holdoutIdx.map((i) => (wf.sorted[i] as { r: Row }).r);

  const byKey = <T>(rows: Row[], keyFn: (r: Row) => string, fn: (rs: Row[]) => T) => Object.fromEntries([...new Set(rows.map(keyFn))].sort().map((k) => [k, fn(rows.filter((r) => keyFn(r) === k))]));

  const statusTally = dist(base.map((r) => r.status));
  const ambiguityRate = round(base.length ? base.filter((r) => r.status === "AMBIGUOUS_INTRABAR").length / base.length : 0);

  const report = {
    frozenPolicy: { WARMUP, HORIZON, WAIT_WINDOW, PULLBACK_FRAC, BREAKOUT_FRAC, CONFIRM_BARS, TRAIL_FRAC, TP_R, riskAtrMult: RISK_ATR_MULT, note: "declared before results; not tuned after." },
    rows: { total: base.length, usableSilver: u.length, statusTally, ambiguityRate, note: "AMBIGUOUS_INTRABAR excluded from headline means; candle-only ⇒ never GOLD." },
    entry: { overall: entryAgg(u), byMonth: byKey(u, (r) => r.month, entryAgg), bySymbol: byKey(u, (r) => r.symbol, entryAgg), bySide: byKey(u, (r) => r.side, entryAgg), byMarketState: byKey(u, (r) => r.family, entryAgg) },
    exit: { overall: exitAgg(u), byMonth: byKey(u, (r) => r.month, exitAgg), bySide: byKey(u, (r) => r.side, exitAgg), byMarketState: byKey(u, (r) => r.family, exitAgg) },
    costSensitivity: Object.fromEntries(COST_LEVELS.map((lv) => [lv, { enterNowMeanNetR: round(mean(usable(rowsByLevel[lv]!).map((r) => enterNowNetR(r) ?? NaN))), holdMeanNetR: round(mean(usable(rowsByLevel[lv]!).map((r) => holdNetR(r) ?? NaN))) }])),
    dayClusteredCI: { enterNowNetR_L1base: dayCI(u, enterNowNetR), holdNetR_L1base: dayCI(u, holdNetR) },
    walkForward: { folds, holdout: { rows: holdoutRows.length, enterNowMeanNetR: round(mean(holdoutRows.map((r) => enterNowNetR(r) ?? NaN))), holdMeanNetR: round(mean(holdoutRows.map((r) => holdNetR(r) ?? NaN))), note: "evaluated ONCE; policies were frozen before the holdout; NOT used to select a policy." } },
  };
  const rerunHash = stableHash({ rows: base.map((r) => [r.symbol, r.tMs, r.side, r.status]), n: base.length });

  const write = (n: string, o: unknown) => writeFileSync(join(outDir, n), JSON.stringify(o, null, 1));
  write("entry-exit-6mo-report.json", report);
  write("entry-exit-6mo-determinism.json", { rerunHash });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ totalRows: base.length, usableSilver: u.length, statusTally, ambiguityRate, entryEnterNowNetR: (report.entry.overall as any).ENTER_NOW?.meanNetR, exitHoldNetR: (report.exit.overall as any).HOLD?.finalNetR, dayCI: report.dayClusteredCI, holdout: report.walkForward.holdout, rerunHash: rerunHash.slice(0, 16) }, null, 1));
}
main();
