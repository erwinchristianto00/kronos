/**
 * Tier-A candle proof — SIX-MONTH causal reconstruction + analysis (offline, read-only). Extends the validated
 * one-month proof to Jan–Jun 2026 using the FROZEN core (same features/thresholds/labels/model family/execution
 * levels). Adds the required breakdown+metric matrix and, critically, keeps TWO SEPARATE result streams:
 *
 *   Stream 1 — incumbent Direction Brain RECONSTRUCTABILITY (can candles alone drive the live brain? — expected
 *              NO: it abstains FLAT because edge-memory/conviction are LIVE_ONLY). FLAT ≠ "market had no direction".
 *   Stream 2 — INDEPENDENT Tier-A candle directional skill (do raw [trend,vol,mom] have OOS predictive skill?).
 *
 * Nothing here touches live state, beta, CORTEX, executor, kill state, or VPS. Deterministic (seeded bootstrap).
 *
 *   Usage: npx tsx scripts/replay-tier-a-6mo-run.ts <klinesDir> <outDir>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stableHash } from "../src/lib/replay-provenance.js";
import { tallyReplayStatuses } from "../src/lib/replay-quality-status.js";
import { planWalkForward, brierVsBaseRate, brierScore, calibrationBins, calibrationLine, maxDrawdownR, concentration, quantile } from "../src/lib/backfill-walkforward.js";
import { fitLogisticL2, predictLogistic, type LogisticModel } from "../src/lib/backfill-warmstart.js";
import { parseKlines, reconstructSymbol, HORIZON_BARS, HURDLE_R, HOUR, EXEC_LEVEL_KEYS, dayKey, monthKey, type TAMarketRow, type TADirRow } from "../src/lib/replay-tier-a-core.js";
import { clusteredBootstrapMeanCI, statePersistence, overlapAdjustedEss, coefficientStability, mean } from "../src/lib/replay-tier-a-metrics.js";
import type { DirectionHorizon } from "../src/lib/four-brain-types.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
const MONTHS = ["01", "02", "03", "04", "05", "06"] as const;
const FEATURES = ["trend", "vol", "mom"] as const;
const round = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const dist = (arr: string[]): Record<string, number> => arr.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});

interface LR { tMs: number; symbol: string; month: string; day: number; x: number[]; longWin: 0 | 1; netRByLevel: Record<string, number>; }

/**
 * Independent Tier-A model evaluation on one row-set: 3-fold chronological WF (frozen) + pooled-test economics.
 * EMBARGO: labels look forward `embargoBars` (the horizon H), so a train row within H bars of a test/holdout
 * boundary would leak its future outcome across the seam. We purge those boundary train rows (a standard
 * purged/embargoed walk-forward for overlapping labels). This can only REDUCE apparent skill — never inflate it.
 */
function evalIndependent(rows: LR[], embargoBars: number) {
  const wf = planWalkForward(rows, 3, 0.25);
  const embargoMs = embargoBars * HOUR;
  const foldWeights: number[][] = [];
  const pooledTest: Array<{ tMs: number; day: number; symbol: string; month: string; p: number; y: 0 | 1; sel: boolean; netRByLevel: Record<string, number> }> = [];
  const folds = wf.folds.map((f) => {
    // purge train rows whose H-bar label window overlaps the test block (tMs ≥ testStart − H).
    const trainIdx = f.trainIdx.filter((i) => (wf.sorted[i] as LR).tMs < f.testStartMs - embargoMs);
    const Xtr = trainIdx.map((i) => (wf.sorted[i] as LR).x);
    const ytr = trainIdx.map((i) => (wf.sorted[i] as LR).longWin);
    const model = fitLogisticL2(Xtr, ytr, FEATURES, { l2: 1 });
    foldWeights.push(model.weights);
    const thr = model.positiveRate; // TRAIN-derived selection threshold (fixed-hurdle; no test peeking)
    const preds = f.testIdx.map((i) => {
      const r = wf.sorted[i] as LR;
      const p = predictLogistic(model, r.x) ?? 0.5;
      const sel = p >= thr;
      pooledTest.push({ tMs: r.tMs, day: r.day, symbol: r.symbol, month: r.month, p, y: r.longWin, sel, netRByLevel: r.netRByLevel });
      return { p, y: r.longWin };
    });
    const bc = brierVsBaseRate(preds, model.positiveRate);
    const cl = calibrationLine(calibrationBins(preds, 5));
    return { fold: f.index, trainN: trainIdx.length, trainPurged: f.trainIdx.length - trainIdx.length, testN: f.testIdx.length, baseRate: round(model.positiveRate), brierModel: round(bc.brierModel), brierBaseRate: round(bc.brierBaseRate), brierSkill: round(bc.brierSkill), calibSlope: round(cl.slope), calibIntercept: round(cl.intercept), converged: model.converged };
  });

  // Pooled-test economics (model overlay: take the long when selected, else flat=0), at each frozen cost level.
  const acted = pooledTest.filter((t) => t.sel);
  const turnover = pooledTest.length ? acted.length / pooledTest.length : 0;
  const costSensitivity: Record<string, { meanActedNetR: number | null; sumNetR: number | null; maxDrawdownR: number | null }> = {};
  for (const lv of EXEC_LEVEL_KEYS) {
    const series = [...acted].sort((a, b) => a.tMs - b.tMs).map((t) => t.netRByLevel[lv] ?? 0);
    costSensitivity[lv] = { meanActedNetR: round(mean(series)), sumNetR: round(series.reduce((a, v) => a + v, 0)), maxDrawdownR: round(maxDrawdownR(series)) };
  }
  // selection lift (L1_base): does the model's SELECTION beat taking every long indiscriminately? (NOT incumbent-
  // relative — the incumbent abstains FLAT, so there is no incumbent long-book to compare against here.)
  const allLongMean = mean(pooledTest.map((t) => t.netRByLevel.L1_base ?? 0));
  const actedMean = mean(acted.map((t) => t.netRByLevel.L1_base ?? 0));
  const selectionLiftR = actedMean != null && allLongMean != null ? actedMean - allLongMean : null;
  // clustered (per-day) bootstrap CI of the acted mean netR (L1_base) — the "is there real edge" test.
  const ci = clusteredBootstrapMeanCI(acted.map((t) => ({ dayKey: t.day, value: t.netRByLevel.L1_base ?? 0 })), { iters: 2000, seed: 0x5eed1, alpha: 0.05 });
  // concentration of acted netR by symbol / month
  const bySym = new Map<string, number>(); const byMon = new Map<string, number>();
  for (const t of acted) { const v = t.netRByLevel.L1_base ?? 0; bySym.set(t.symbol, (bySym.get(t.symbol) ?? 0) + v); byMon.set(t.month, (byMon.get(t.month) ?? 0) + v); }

  // Untouched holdout: fit on working rows (EMBARGOED away from the holdout boundary), evaluate ONCE on the block.
  let holdout: unknown = { rows: wf.holdoutIdx.length, note: "insufficient" };
  if (wf.holdoutIdx.length > 10) {
    const holdoutSet = new Set(wf.holdoutIdx);
    const workIdx = wf.sorted.map((_, i) => i).filter((i) => !holdoutSet.has(i) && (wf.sorted[i] as LR).tMs < wf.holdoutStartMs - embargoMs);
    const model = fitLogisticL2(workIdx.map((i) => (wf.sorted[i] as LR).x), workIdx.map((i) => (wf.sorted[i] as LR).longWin), FEATURES, { l2: 1 });
    const preds = wf.holdoutIdx.map((i) => ({ p: predictLogistic(model, (wf.sorted[i] as LR).x) ?? 0.5, y: (wf.sorted[i] as LR).longWin }));
    const bc = brierVsBaseRate(preds, model.positiveRate);
    holdout = { rows: wf.holdoutIdx.length, trainRows: workIdx.length, baseRate: round(model.positiveRate), brierModel: round(bc.brierModel), brierBaseRate: round(bc.brierBaseRate), brierSkill: round(bc.brierSkill), note: "evaluated ONCE, never tuned; train embargoed by H bars from the holdout boundary" };
  }
  return {
    folds, foldBrierSkillMedian: round(quantile(folds.map((f) => f.brierSkill ?? 0), 0.5)),
    coefficientStability: coefficientStability(FEATURES, foldWeights),
    economics: { turnover: round(turnover), actedN: acted.length, pooledTestN: pooledTest.length, selectionLiftR_vsAllLongs_L1base: round(selectionLiftR), actedMeanNetR_L1base: round(actedMean), allLongMeanNetR_L1base: round(allLongMean), costSensitivity, bootstrapCI_actedMeanNetR_L1base: { point: round(ci.point), lo: round(ci.lo), loRaw: ci.lo, hi: round(ci.hi), dayBlocks: ci.blocks, iters: ci.iters } },
    concentration: { bySymbol: concentration(bySym), byMonth: concentration(byMon) },
    holdout,
  };
}

/** Expanding-window MONTHLY skill: train on all prior months (EMBARGOED by H bars before the test month starts),
 *  test on month m (same features/label/model). */
function evalMonthly(rows: LR[], embargoBars: number) {
  const embargoMs = embargoBars * HOUR;
  const out: Array<{ month: string; testN: number; baseRate: number | null; brierSkill: number | null; calibSlope: number | null }> = [];
  for (let mi = 1; mi < MONTHS.length; mi += 1) {
    const m = `2026-${MONTHS[mi]}`;
    const test = rows.filter((r) => r.month === m);
    const testStart = test.length ? Math.min(...test.map((r) => r.tMs)) : Infinity;
    const train = rows.filter((r) => r.month < m && r.tMs < testStart - embargoMs); // embargo the seam
    if (train.length < 30 || test.length < 10) { out.push({ month: m, testN: test.length, baseRate: null, brierSkill: null, calibSlope: null }); continue; }
    const model = fitLogisticL2(train.map((r) => r.x), train.map((r) => r.longWin), FEATURES, { l2: 1 });
    const preds = test.map((r) => ({ p: predictLogistic(model, r.x) ?? 0.5, y: r.longWin }));
    out.push({ month: m, testN: test.length, baseRate: round(model.positiveRate), brierSkill: round(brierVsBaseRate(preds, model.positiveRate).brierSkill), calibSlope: round(calibrationLine(calibrationBins(preds, 5)).slope) });
  }
  return out;
}

function main(): void {
  const klinesDir = process.argv[2]!;
  const outDir = process.argv[3] ?? "artifacts/replay/tier-a-proof/6mo";
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // ── Manifest over the 1h reconstruction corpus ──
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith(".csv") ? [join(dir, d.name)] : []));
  const manifestEntries = walk(klinesDir).sort().map((f) => {
    const buf = readFileSync(f);
    const nums = buf.toString("utf8").split("\n").filter((l) => /^\d/.test(l)).map((l) => +l.split(",")[0]!);
    return { file: f.slice(klinesDir.length + 1), sha256: createHash("sha256").update(buf).digest("hex"), rows: nums.length, firstOpenTimeMs: nums[0] ?? null, lastOpenTimeMs: nums.at(-1) ?? null };
  });
  const manifestHash = stableHash(manifestEntries);

  // ── Reconstruct per symbol over the CONCATENATED 6-month contiguous 1h series (frozen core) ──
  const marketRows: TAMarketRow[] = [];
  const dirRows: TADirRow[] = [];
  const gapReport: Array<{ symbol: string; gaps: number; bars: number }> = [];
  let candidateTimestamps = 0, causalDecisions = 0, labeled = 0, leakGuardHits = 0;
  for (const symbol of SYMBOLS) {
    const candles = MONTHS.flatMap((mm) => {
      const p = join(klinesDir, `${symbol}-1h-2026-${mm}`, `${symbol}-1h-2026-${mm}.csv`);
      return existsSync(p) ? parseKlines(readFileSync(p, "utf8")) : [];
    }).sort((a, b) => a.openTime - b.openTime);
    const r = reconstructSymbol(symbol, candles);
    marketRows.push(...r.marketRows); dirRows.push(...r.dirRows);
    gapReport.push({ symbol, gaps: r.gaps, bars: candles.length });
    candidateTimestamps += r.candidateTimestamps; causalDecisions += r.causalDecisions; labeled += r.labeled; leakGuardHits += r.leakGuardHits;
  }

  // ── Market State report: overall + per-month + per-symbol (UNKNOWN rate, families, persistence, transition) ──
  const msOverall = (rowset: TAMarketRow[]) => ({
    rows: rowset.length, unknownRatePct: round(100 * rowset.filter((r) => r.unknown).length / Math.max(1, rowset.length)),
    familyDistribution: dist(rowset.map((r) => r.family)), biasDistribution: dist(rowset.map((r) => r.bias)),
    meanConfidence: round(mean(rowset.map((r) => r.conf))),
  });
  const msPersistenceBySymbol = SYMBOLS.map((s) => ({ symbol: s, ...statePersistence(marketRows.filter((r) => r.symbol === s).sort((a, b) => a.tMs - b.tMs).map((r) => r.family)) }));
  const marketReport = {
    overall: { ...msOverall(marketRows), statusCounts: tallyReplayStatuses(marketRows.map((r) => r.status)) },
    byMonth: Object.fromEntries([...new Set(marketRows.map((r) => monthKey(r.tMs)))].sort().map((m) => [m, msOverall(marketRows.filter((r) => monthKey(r.tMs) === m))])),
    bySymbol: Object.fromEntries(SYMBOLS.map((s) => [s, msOverall(marketRows.filter((r) => r.symbol === s))])),
    persistence: msPersistenceBySymbol,
    note: "breadth MISSING by construction (2-symbol universe, survivorship control). FLAT direction ≠ 'no market direction' — see direction-incumbent-report.",
  };

  // ── Stream 1: incumbent Direction reconstructability ──
  const incumbent: Record<string, unknown> = {};
  for (const horizon of Object.keys(HORIZON_BARS) as DirectionHorizon[]) {
    const rows = dirRows.filter((r) => r.horizon === horizon);
    const acts = dist(rows.map((r) => r.action));
    incumbent[horizon] = {
      actionDistribution: acts,
      reconstructable: Object.keys(acts).some((a) => a !== "FLAT"),
      matchesCounterfactualBestPct: round(100 * rows.filter((r) => r.win !== null && r.action === r.bestAction).length / Math.max(1, rows.filter((r) => r.win !== null).length)),
      meanChosenNetR: round(mean(rows.filter((r) => r.chosenNetR != null).map((r) => r.chosenNetR as number))),
    };
  }
  const incumbentReport = { note: "Incumbent Direction Brain fed longEdge/shortEdge/conviction = null (LIVE_ONLY, unavailable historically). FLAT abstention is a property of MISSING inputs, NOT evidence the market lacked direction.", byHorizon: incumbent };

  // ── Stream 2: independent Tier-A candle directional skill ──
  const independent: Record<string, unknown> = {};
  for (const horizon of Object.keys(HORIZON_BARS) as DirectionHorizon[]) {
    const base = dirRows.filter((r) => r.horizon === horizon && r.win !== null && r.status === "GOLD");
    const lr: LR[] = base.map((r) => ({ tMs: r.tMs, symbol: r.symbol, month: monthKey(r.tMs), day: dayKey(r.tMs), x: r.x, longWin: (((r.longNetR.L1_base ?? -1) > HURDLE_R) ? 1 : 0) as 0 | 1, netRByLevel: r.longNetR }));
    const H = HORIZON_BARS[horizon];
    independent[horizon] = {
      rows: lr.length,
      embargoBars: H,
      classBalance: { longWinRate: round(mean(lr.map((r) => r.longWin))) },
      walkForward: evalIndependent(lr, H),
      monthly: evalMonthly(lr, H),
      bySymbol: Object.fromEntries(SYMBOLS.map((s) => [s, evalIndependent(lr.filter((r) => r.symbol === s), H).folds.map((f) => f.brierSkill)])),
    };
  }

  // ── Effective sample (overlap-adjusted) ──
  const uniqDays = new Set(marketRows.map((r) => dayKey(r.tMs))).size;
  const ess = {
    marketRows: marketRows.length, directionRows: dirRows.length, calendarDays: uniqDays,
    byHorizon: Object.fromEntries((Object.keys(HORIZON_BARS) as DirectionHorizon[]).map((h) => [h, overlapAdjustedEss(dirRows.filter((r) => r.horizon === h && r.win !== null).length, HORIZON_BARS[h], uniqDays)])),
    note: "Overlapping horizon returns ⇒ effective independent N ≪ row count. essByHorizon = N/H; essFloor = min(N/H, uniqueDays).",
  };

  // ── Reconciliation + determinism ──
  const reconciliation = {
    rawData: { klinesFiles: manifestEntries.length, expectedKlinesFiles: SYMBOLS.length * MONTHS.length, checksumNote: "SHA-256 verification was performed at DOWNLOAD time (see acquisition-log.tsv: 48/48 checksum-OK). This run re-hashes the 1h corpus into manifestHash but does not itself re-verify against .CHECKSUM sidecars.", gaps: gapReport },
    decisions: { candidateTimestamps, leakGuardRejections: leakGuardHits, causalDecisions, labeledOutcomes: labeled, marketRows: marketRows.length, directionRows: dirRows.length },
    note: "no silent row loss: candidateTimestamps − leakGuardRejections = causalDecisions.",
  };
  const rerunHash = stableHash({ marketRows: marketRows.map((r) => [r.symbol, r.tMs, r.family, r.bias]), dirRows: dirRows.map((r) => [r.symbol, r.horizon, r.tMs, r.action, r.win]) });

  // ── 6→12 month decision gate evaluation (mechanical, from the frozen metrics) ──
  // MATERIALITY FLOOR (pre-declared, with rationale): a genuinely useful binary predictor shows Brier skill of
  // ~0.01–0.02; noise-level positivity (~1e-4) is "approximately zero" per the operator's own STOP condition.
  // 0.005 conservatively separates real skill from noise, so a +0.0002 fold does NOT count as "positive skill".
  const MATERIAL_BRIER_SKILL = 0.005;
  const skillsAll = (Object.values(independent) as any[]).flatMap((h) => h.walkForward.folds.map((f: any) => f.brierSkill)).filter((v: any) => v != null) as number[];
  const monthliesAll = (Object.values(independent) as any[]).flatMap((h) => h.monthly.map((m: any) => m.brierSkill)).filter((v: any) => v != null) as number[];
  // ECONOMIC signal — COUPLED per horizon + multiplicity-aware: a horizon "passes" only if its clustered bootstrap
  // RAW lower bound > 0 AND its own fold skill is material. This kills best-of-3-horizons noise (an isolated CI
  // fluke in one correlated horizon can no longer flip STOP→CONTINUE on its own). Uses the UNROUNDED bound.
  const coupledEconHorizons = (Object.entries(independent) as [string, any][]).filter(([, h]) => {
    const loRaw = h.walkForward.economics.bootstrapCI_actedMeanNetR_L1base.loRaw;
    const horizonMaxSkill = Math.max(0, ...h.walkForward.folds.map((f: any) => f.brierSkill ?? 0));
    return typeof loRaw === "number" && loRaw > 0 && horizonMaxSkill > MATERIAL_BRIER_SKILL;
  }).map(([h]) => h);
  const anyCiAboveZero = coupledEconHorizons.length > 0;
  const posFoldShare = skillsAll.length ? skillsAll.filter((s) => s > 0).length / skillsAll.length : 0;       // trivial positivity
  const posMonthShare = monthliesAll.length ? monthliesAll.filter((s) => s > 0).length / monthliesAll.length : 0;
  const materialFoldShare = skillsAll.length ? skillsAll.filter((s) => s > MATERIAL_BRIER_SKILL).length / skillsAll.length : 0; // MEANINGFUL positivity
  const materialMonthShare = monthliesAll.length ? monthliesAll.filter((s) => s > MATERIAL_BRIER_SKILL).length / monthliesAll.length : 0;
  const maxFoldSkill = skillsAll.length ? Math.max(...skillsAll) : null;
  const medianFoldSkill = quantile(skillsAll, 0.5);
  const continueOnSkill = materialFoldShare > 0.5 && materialMonthShare > 0.5;
  const decisionGate = {
    materialityFloor: MATERIAL_BRIER_SKILL,
    magnitude: { medianFoldBrierSkill: round(medianFoldSkill), maxFoldBrierSkill: round(maxFoldSkill), note: "compare to materialityFloor — if max ≪ floor, positivity is noise, not skill" },
    continueCriteria: {
      materialBrierSkillMajorityFoldsAndMonths: continueOnSkill,
      clusteredBootstrapActedNetR_coupledWithMaterialSkill: anyCiAboveZero,
      coupledEconHorizons,
      materialFoldShare: round(materialFoldShare), materialMonthShare: round(materialMonthShare),
      multiplicityNote: "economic criterion is COUPLED (CI raw-lo>0 AND same-horizon material skill), not a bare best-of-3 CI OR — a lone noisy horizon can no longer trigger CONTINUE.",
    },
    stopConditions: {
      skillApproximatelyZeroOrNegative: (maxFoldSkill ?? 0) < MATERIAL_BRIER_SKILL, // TRUE ⇒ stop-worthy
      allBootstrapCIsAcrossOrBelowZero: !anyCiAboveZero,
      trivialPositivityOnly: posFoldShare > 0.5 && !continueOnSkill, // "positive" but sub-materiality
    },
    trivialShares: { posFoldShare: round(posFoldShare), posMonthShare: round(posMonthShare), caveat: "these count ANY skill>0 incl. noise — NOT a continue trigger by themselves" },
    recommendation: continueOnSkill || anyCiAboveZero ? "CONTINUE_TO_12MO_CANDIDATE (operator approval required)" : "STOP_CANDLE_ONLY_DIRECTION_LINE (Brier skill ~0 below materiality floor; every economic CI across/below zero — do not proceed to 12mo hoping results change)",
    note: "Mechanical evaluation of the pre-registered 6→12mo gate with a materiality floor so noise-level positivity does not trigger CONTINUE. No metric selected post-hoc.",
  };

  const write = (n: string, o: unknown) => writeFileSync(join(outDir, n), JSON.stringify(o, null, 1));
  write("data-manifest.json", { period: "2026-01..06", symbols: SYMBOLS, manifestHash, entries: manifestEntries });
  write("market-state-report.json", marketReport);
  write("direction-incumbent-report.json", incumbentReport);
  write("direction-independent-report.json", independent);
  write("effective-sample.json", ess);
  write("reconciliation.json", reconciliation);
  write("decision-gate.json", decisionGate);
  write("determinism.json", { rerunHash });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    manifestHash: manifestHash.slice(0, 16), gaps: gapReport, candidateTimestamps, leakGuardRejections: leakGuardHits, causalDecisions, labeled,
    marketRows: marketRows.length, unknownRatePct: marketReport.overall.unknownRatePct,
    incumbentReconstructable: Object.fromEntries(Object.entries(incumbent).map(([h, v]) => [h, (v as any).reconstructable])),
    independentFoldBrierSkill: Object.fromEntries(Object.entries(independent).map(([h, v]) => [h, (v as any).walkForward.folds.map((f: any) => f.brierSkill)])),
    independentBootstrapCI: Object.fromEntries(Object.entries(independent).map(([h, v]) => [h, (v as any).walkForward.economics.bootstrapCI_actedMeanNetR_L1base])),
    decisionGate: decisionGate.recommendation, posFoldShare: round(posFoldShare), posMonthShare: round(posMonthShare),
    rerunHash: rerunHash.slice(0, 16),
  }, null, 1));
}
main();
