/**
 * Read-only selection report for the Testnet-only Daily Range V5 FADE cohort.
 *
 * It never creates an exchange client and never fetches a URL. It consumes the
 * frozen Testnet ledger and the previously generated Testnet USD-M 1m replay
 * only, then compares exactly A/B/C:
 *   A V5 baseline, B entry filter, C filter + completed-1m soft invalidation.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Label = "FALSE_BREAKOUT" | "GENUINE_BREAKOUT";
type Result = {
  tradeId: string;
  symbol: string;
  status: string;
  entryAt: string | null;
  exitReason: string | null;
  netPnlUsd: number | null;
  grossPnlUsd: number | null;
  netR: number | null;
  stopFollowThrough: "CONTINUED_BREAKOUT" | "REVERTED_TO_RANGE" | "INSUFFICIENT_PATH" | null;
};
type Trade = {
  tradeId?: string;
  signalId?: string;
  rangeHigh?: number;
  rangeLow?: number;
  breakoutDirection?: "UP" | "DOWN" | null;
  breakoutExtreme?: number | null;
};
type Signal = {
  signalId?: string;
  research?: { features?: unknown } | null;
};

const root = resolve(import.meta.dirname, "../../..");
const statePath = process.argv[2] ?? resolve(root, "research/input/testnet-daily-range-state-20260903.json");
const replayPath = process.argv[3] ?? resolve(root, "research/output/testnet-fade-vnext-replay-full-20260903.json");
const outputPath = process.argv[4] ?? resolve(root, "research/output/testnet-fade-genuine-breakout-filter-report-20260903.json");
const threshold = 0.15;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number | null, digits = 8): number | null {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

function metric(rows: readonly Result[]) {
  const executed = rows.filter((row) => row.status === "EXECUTED" && finite(row.netPnlUsd));
  const net = executed.reduce((sum, row) => sum + row.netPnlUsd!, 0);
  const gross = executed.reduce((sum, row) => sum + (row.grossPnlUsd ?? 0), 0);
  const wins = executed.filter((row) => row.netPnlUsd! > 0);
  const losses = executed.filter((row) => row.netPnlUsd! < 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.netPnlUsd!, 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + row.netPnlUsd!, 0));
  let equity = 0;
  let peak = 0;
  let mdd = 0;
  for (const row of [...executed].sort((a, b) => String(a.entryAt).localeCompare(String(b.entryAt)) || a.tradeId.localeCompare(b.tradeId))) {
    equity += row.netPnlUsd!;
    peak = Math.max(peak, equity);
    mdd = Math.max(mdd, peak - equity);
  }
  const exits = Object.fromEntries([...new Set(executed.map((row) => row.exitReason ?? "UNKNOWN"))]
    .sort()
    .map((reason) => [reason, executed.filter((row) => (row.exitReason ?? "UNKNOWN") === reason).length]));
  const best = wins.length ? Math.max(...wins.map((row) => row.netPnlUsd!)) : null;
  return {
    n: executed.length,
    netPnlUsd: round(net),
    grossPnlUsd: round(gross),
    expectancyUsd: round(executed.length ? net / executed.length : null),
    expectancyR: round(executed.length ? executed.reduce((sum, row) => sum + (row.netR ?? 0), 0) / executed.length : null),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : grossProfit > 0 ? "Infinity" : null,
    winRate: round(executed.length ? wins.length / executed.length : null, 6),
    averageWinUsd: round(wins.length ? grossProfit / wins.length : null),
    averageLossUsd: round(losses.length ? grossLoss / losses.length : null),
    maxDrawdownUsd: round(mdd),
    exitCounts: exits,
    bestTradeUsd: round(best),
    largestWinShareOfGrossProfit: grossProfit > 0 && best !== null ? round(best / grossProfit, 6) : null,
  };
}

function labelsAndFeatures(input: { state: { trades?: Trade[]; signals?: Signal[] }; baseline: Result[] }) {
  const tradeById = new Map((input.state.trades ?? []).map((trade) => [trade.tradeId, trade]));
  const signalById = new Map((input.state.signals ?? []).map((signal) => [signal.signalId, signal]));
  return input.baseline
    .filter((result) => result.status === "EXECUTED")
    .flatMap((result) => {
      const trade = tradeById.get(result.tradeId);
      const rangeWidth = (trade?.rangeHigh ?? Number.NaN) - (trade?.rangeLow ?? Number.NaN);
      const sweepExtension = trade?.breakoutDirection === "UP"
        ? (trade.breakoutExtreme ?? Number.NaN) - (trade.rangeHigh ?? Number.NaN)
        : (trade.rangeLow ?? Number.NaN) - (trade.breakoutExtreme ?? Number.NaN);
      if (!finite(rangeWidth) || !(rangeWidth > 0) || !finite(sweepExtension) || !(sweepExtension > 0)) return [];
      const label: Label | null = result.exitReason === "SL" && result.stopFollowThrough === "CONTINUED_BREAKOUT"
        ? "GENUINE_BREAKOUT"
        : (result.netPnlUsd ?? 0) > 0 || (result.exitReason === "SL" && result.stopFollowThrough === "REVERTED_TO_RANGE")
          ? "FALSE_BREAKOUT"
          : null;
      if (!label) return [];
      return [{
        result,
        label,
        sweepExtensionOfRange: sweepExtension / rangeWidth,
        // Retained in the report only to prove the selected feature existed at
        // the decision boundary; it is not a live gate condition.
        entryFeatureSnapshot: signalById.get(trade?.signalId)?.research?.features ?? null,
      }];
    })
    .sort((left, right) => String(left.result.entryAt).localeCompare(String(right.result.entryAt)) || left.result.tradeId.localeCompare(right.result.tradeId));
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function splitRows<T>(rows: readonly T[]): Record<"EARLY" | "MIDDLE" | "RECENT", readonly T[]> {
  const size = Math.ceil(rows.length / 3);
  return {
    EARLY: rows.slice(0, size),
    MIDDLE: rows.slice(size, size * 2),
    RECENT: rows.slice(size * 2),
  };
}

function variantsFor(input: { labelled: ReturnType<typeof labelsAndFeatures>; softById: Map<string, Result> }) {
  const baseline = input.labelled.map((row) => row.result);
  const accepted = input.labelled.filter((row) => row.sweepExtensionOfRange < threshold);
  const filtered = accepted.map((row) => row.result);
  const filteredSoft = accepted.flatMap((row) => {
    const soft = input.softById.get(row.result.tradeId);
    return soft?.status === "EXECUTED" ? [soft] : [];
  });
  return { baseline, filtered, filteredSoft, accepted };
}

function splitReport(input: { labelled: ReturnType<typeof labelsAndFeatures>; softById: Map<string, Result> }) {
  const output = {} as Record<string, unknown>;
  for (const [name, rows] of Object.entries(splitRows(input.labelled))) {
    const variants = variantsFor({ labelled: rows, softById: input.softById });
    const genuine = rows.filter((row) => row.label === "GENUINE_BREAKOUT");
    const falseBreakout = rows.filter((row) => row.label === "FALSE_BREAKOUT");
    output[name] = {
      baselineSignals: rows.length,
      accepted: variants.accepted.length,
      skipped: rows.length - variants.accepted.length,
      genuineBreakoutLosersRemoved: genuine.filter((row) => row.sweepExtensionOfRange >= threshold).length,
      profitableFalseBreakoutsRemoved: falseBreakout.filter((row) => row.sweepExtensionOfRange >= threshold).length,
      A_V5_BASELINE: metric(variants.baseline),
      B_GENUINE_BREAKOUT_FILTER: metric(variants.filtered),
      C_FILTER_PLUS_SOFT_INVALIDATION: metric(variants.filteredSoft),
    };
  }
  return output;
}

async function main() {
  const [stateText, replayText] = await Promise.all([readFile(statePath, "utf8"), readFile(replayPath, "utf8")]);
  const state = JSON.parse(stateText) as { trades?: Trade[]; signals?: Signal[] };
  const replay = JSON.parse(replayText) as { policy?: unknown; source?: unknown; variants?: Record<string, { fullResults?: Result[] }> };
  const baseline = replay.variants?.BASELINE?.fullResults ?? [];
  const soft = replay.variants?.SOFT_INVALIDATION?.fullResults ?? [];
  if (!baseline.length || !soft.length) throw new Error("frozen Testnet V5 baseline/SOFT replay results are required");
  const labelled = labelsAndFeatures({ state, baseline });
  const softById = new Map(soft.map((row) => [row.tradeId, row]));
  const variants = variantsFor({ labelled, softById });
  const genuine = labelled.filter((row) => row.label === "GENUINE_BREAKOUT");
  const falseBreakout = labelled.filter((row) => row.label === "FALSE_BREAKOUT");
  const A = metric(variants.baseline);
  const B = metric(variants.filtered);
  const C = metric(variants.filteredSoft);
  const netImprovement = Math.abs(Number(A.netPnlUsd)) > 0
    ? (Math.abs(Number(A.netPnlUsd)) - Math.abs(Number(C.netPnlUsd))) / Math.abs(Number(A.netPnlUsd))
    : null;
  const checks = [0.10, 0.15, 0.20].map((candidate) => ({
    threshold: candidate,
    accepted: labelled.filter((row) => row.sweepExtensionOfRange < candidate).length,
    skippedGenuine: genuine.filter((row) => row.sweepExtensionOfRange >= candidate).length,
    skippedFalse: falseBreakout.filter((row) => row.sweepExtensionOfRange >= candidate).length,
  }));
  const recent = splitReport({ labelled, softById }).RECENT as { A_V5_BASELINE: ReturnType<typeof metric>; C_FILTER_PLUS_SOFT_INVALIDATION: ReturnType<typeof metric> };
  const report = {
    reportId: "daily-fade-genuine-breakout-filter-testnet-v1",
    generatedAt: new Date().toISOString(),
    sourceIntegrity: {
      endpoint: "https://testnet.binancefuture.com",
      executionAuthority: "NONE_READ_ONLY_REPLAY",
      sourceCompatibility: "TESTNET_LEDGER_WITH_TESTNET_USDM_1M_CANDLES_ONLY",
      statePath,
      stateSha256: createHash("sha256").update(stateText).digest("hex"),
      replayPath,
      replaySha256: createHash("sha256").update(replayText).digest("hex"),
      baselinePolicy: replay.policy ?? null,
      source: replay.source ?? null,
    },
    baselineDefinition: {
      version: "V5_FADE",
      entry: "SWEEP_BREAKOUT_THEN_FIRST_REACCEPTANCE_INTO_FROZEN_4H_RANGE",
      nativeStop: "SWEEP_EXTREME_PLUS_15PCT_EXTENSION_BUFFER_OR_100BPS_FILL_FLOOR",
      nativeTarget: "OPPOSITE_4H_RANGE_BOUNDARY",
      trail: "daily-fade-r30-floor25-v2",
    },
    labels: {
      resolvedEligiblePaths: labelled.length,
      excludedAmbiguousPaths: baseline.filter((row) => row.status === "AMBIGUOUS").length,
      genuineBreakout: genuine.length,
      falseBreakout: falseBreakout.length,
      definition: {
        genuine: "V5 native SL then continued outside toward original breakout",
        false: "positive V5 outcome or stopped then reverted into range",
      },
    },
    featureSelection: {
      selected: "SWEEP_EXTENSION_FROM_FROZEN_4H_RANGE_BOUNDARY_DIVIDED_BY_FROZEN_4H_RANGE_WIDTH",
      liveInformationOnly: true,
      conditions: [{ field: "sweepExtensionOfRange", operator: "<", threshold }],
      thresholdCheckOnly: checks,
      genuineMedian: round(median(genuine.map((row) => row.sweepExtensionOfRange)), 6),
      falseMedian: round(median(falseBreakout.map((row) => row.sweepExtensionOfRange)), 6),
      note: "Exploratory small-sample gate; no ML, no grid search, no future path in the live evaluator.",
    },
    breakoutDiagnosis: {
      stoppedBaselineFadeCount: baseline.filter((row) => row.status === "EXECUTED" && row.exitReason === "SL").length,
      continuedBreakoutAfterStop: genuine.length,
      continuedBreakoutStopShare: round(genuine.length / baseline.filter((row) => row.status === "EXECUTED" && row.exitReason === "SL").length, 6),
      genuineLosersRemovedBeforeEntry: genuine.filter((row) => row.sweepExtensionOfRange >= threshold).length,
      genuineLosersRemovedShare: round(genuine.filter((row) => row.sweepExtensionOfRange >= threshold).length / genuine.length, 6),
      profitableFalseBreakoutsWronglyRemoved: falseBreakout.filter((row) => row.sweepExtensionOfRange >= threshold).length,
      profitableFalseBreakoutsWronglyRemovedShare: round(falseBreakout.filter((row) => row.sweepExtensionOfRange >= threshold).length / falseBreakout.length, 6),
    },
    variants: {
      A_V5_BASELINE: A,
      B_GENUINE_BREAKOUT_FILTER: B,
      C_FILTER_PLUS_SOFT_INVALIDATION: C,
    },
    chronologicalSplits: splitReport({ labelled, softById }),
    eligibility: {
      status: "EXPERIMENTAL_TESTNET",
      passToTestnet: false,
      rationale: {
        CStillNegative: Number(C.expectancyUsd) < 0 || !(typeof C.profitFactor === "number" && C.profitFactor > 1),
        netLossImprovementVsA: round(netImprovement, 6),
        profitFactorImproved: typeof A.profitFactor === "number" && typeof C.profitFactor === "number" && C.profitFactor > A.profitFactor,
        maxDrawdownImproved: Number(C.maxDrawdownUsd) < Number(A.maxDrawdownUsd),
        recentExpectancyImproved: Number(recent.C_FILTER_PLUS_SOFT_INVALIDATION.expectancyUsd) > Number(recent.A_V5_BASELINE.expectancyUsd),
        noSingleOutlier: (C.largestWinShareOfGrossProfit ?? 1) < 0.75,
      },
      interpretation: "C reduces loss and drawdown materially but is not a proven positive edge; forward Testnet evidence is required before any LIVE consideration.",
    },
    selectedRuntimeCandidate: {
      testnetExperiment: "FADE_GENUINE_BREAKOUT_FILTER_SOFT_V1",
      variant: "FILTER_PLUS_SOFT_INVALIDATION",
      filter: `sweepExtensionOfRange < ${threshold}`,
      softInvalidation: "COMPLETED_1M_CLOSE_OUTSIDE_FROZEN_4H_RANGE_TOWARD_ORIGINAL_BREAKOUT",
      nativeStop: "UNCHANGED_V5_SWEEP_EXTREME_BUFFERED",
      nativeTarget: "UNCHANGED_V5_OPPOSITE_4H_RANGE",
      trail: "UNCHANGED_daily-fade-r30-floor25-v2",
      liveDaily: "DISARMED_UNCHANGED",
      crossSectional: "UNCHANGED",
    },
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, eligibility: report.eligibility, variants: report.variants }, null, 2));
}

await main();
