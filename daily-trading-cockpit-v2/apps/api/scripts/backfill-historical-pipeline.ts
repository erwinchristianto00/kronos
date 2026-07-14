/**
 * Historical backfill + replay pipeline — offline runner (Phase 10 orchestration + sign-off locks). Read-only:
 * streams the real stored stores, runs the pure pipeline, and writes artifacts. Mutates NO live state, touches
 * NO executor, changes NO liveBeta.
 *
 * Sign-off locks folded in (methodology, not decoration):
 *   L1 — pre-registered decision metrics; every selection threshold is TRAIN-ONLY, frozen onto test; coverage
 *        always reported; Brier compared to a base-rate predictor (train base rate). No post-hoc threshold pick.
 *   L2 — attribution distribution diagnostics + decision-side funnel (prove 100% attribution isn't an artifact).
 *   L3 — risk-denominator provenance; GLOBAL_CONSTANT_ASSUMED rows are REPLAY-ONLY (not training-gold) +
 *        a 20/30/40 bps label-flip sensitivity.
 *   L4 — one-hot confidence (no ordinal-spacing assumption) with an ordinal-encoding sensitivity; effective-
 *        sample-size caveat (distinct days/symbols/lanes).
 *
 *   Usage:  npx tsx scripts/backfill-historical-pipeline.ts <dataDir> <outDir>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BACKFILL_OUTCOME_ADAPTERS, BACKFILL_DECISION_ADAPTERS } from "../src/lib/backfill-adapters.js";
import { attributeHistorical } from "../src/lib/backfill-attribution.js";
import { computeOutcomeR } from "../src/lib/backfill-outcome.js";
import { reconstructAsOf, projectVector } from "../src/lib/backfill-asof.js";
import { classifyObservation } from "../src/lib/backfill-classify.js";
import { assembleFamily, directionTarget, entryTarget, exitTarget, EXIT_UNSUPPORTED_MFE_MAE, type DatasetRow } from "../src/lib/backfill-datasets.js";
import { planWalkForward, brierScore, calibrationBins, maxDrawdownR, concentration, realityGapProxy, preRegisteredDecisionMetrics, brierVsBaseRate, calibrationLine } from "../src/lib/backfill-walkforward.js";
import { fitLogisticL2, predictLogistic, computeClassPriors, warmStartGuards } from "../src/lib/backfill-warmstart.js";
import { buildReconciliation } from "../src/lib/backfill-reconciliation.js";
import type { HistoricalDecision, HistoricalOutcome, SourceAdapter, TrainingClass } from "../src/lib/backfill-schema.js";

// L4: one-hot confidence is the DEFAULT schema (no ordinal-spacing assumption); ordinal kept for sensitivity.
const ONEHOT_SCHEMA = ["directionalBias", "allowsLong", "allowsShort", "confidence_LOW", "confidence_MEDIUM", "confidence_HIGH", "confidence_UNKNOWN"] as const;
const ORDINAL_SCHEMA = ["directionalBias", "allowsLong", "allowsShort", "confidence_ord"] as const;
const SCHEMA_VERSION = 1;
const TTL_MS = 60 * 60_000;
const BPS_SENSITIVITY = [20, 30, 40];

function loadRows(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".jsonl")) {
    const out: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) { const s = line.trim(); if (!s) continue; try { out.push(JSON.parse(s)); } catch { /* skip */ } }
    return out;
  }
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      let best: unknown[] | null = null;
      for (const v of Object.values(data)) if (Array.isArray(v) && (!best || v.length > best.length)) best = v;
      return (best as Record<string, unknown>[]) ?? [data];
    }
  } catch { /* fall through */ }
  return [];
}
const fileFor = (a: SourceAdapter): string => `${a.sourceId}.${a.sourceId.includes("snapshots") ? "jsonl" : "json"}`;
const mean = (a: number[]): number | null => { const u = a.filter((v) => Number.isFinite(v)); return u.length ? u.reduce((x, v) => x + v, 0) / u.length : null; };

interface Row extends DatasetRow { xOrdinal: number[] | null; denomSource: string | null; symbol: string | null; }

function main(): void {
  const dataDir = process.argv[2] ?? "data";
  const outDir = process.argv[3] ?? "artifacts/backfill";
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // ── Load + normalize ──
  const outcomes: HistoricalOutcome[] = [];
  const decisions: HistoricalDecision[] = [];
  const parseDrops: Record<string, number> = {};
  let rawRows = 0;
  const perSource: Record<string, { raw: number; normalized: number }> = {};
  for (const a of BACKFILL_OUTCOME_ADAPTERS) {
    const rows = loadRows(join(dataDir, fileFor(a)));
    let ok = 0;
    for (const r of rows) { const o = a.toOutcome?.(r); if (o) { outcomes.push(o); ok += 1; } }
    rawRows += rows.length; perSource[a.sourceId] = { raw: rows.length, normalized: ok }; parseDrops[`normalize:${a.sourceId}`] = rows.length - ok;
  }
  for (const a of BACKFILL_DECISION_ADAPTERS) {
    const rows = loadRows(join(dataDir, fileFor(a)));
    for (const r of rows) { const d = a.toDecision?.(r); if (d) decisions.push(d); }
    perSource[a.sourceId] = { raw: rows.length, normalized: decisions.length };
  }

  // ── Attribution (with distribution diagnostics — L2). ──
  const attr = attributeHistorical(decisions, outcomes, { schemaVersion: SCHEMA_VERSION, matchLane: false, matchSymbol: false, matchSide: false, ttlMsForLane: () => TTL_MS });

  // ── Per-pair: label + as-of + classify + rows. GLOBAL_CONSTANT_ASSUMED denom ⇒ replay-only (L3). ──
  const cortexRows: Row[] = [];
  const directionRows: DatasetRow[] = [];
  const entryRows: DatasetRow[] = [];
  const exitRows: DatasetRow[] = [];
  const attributedClassCounts: Record<TrainingClass, number> = { VALID_FOR_TRAINING: 0, VALID_FOR_REPLAY_ONLY: 0, MISSING_FEATURES: 0, LABEL_UNSAFE: 0, SCHEMA_MISMATCH: 0 };
  const resolvedTimes = attr.pairs.map((p) => p.outcome.resolvedAtMs).sort((a, b) => a - b);
  const holdoutStartMs = resolvedTimes.length ? resolvedTimes[0]! + (resolvedTimes[resolvedTimes.length - 1]! - resolvedTimes[0]!) * 0.75 : 0;
  let denomFlipCount = 0, assumedRows = 0;

  for (const { decision, outcome } of attr.pairs) {
    const label = computeOutcomeR(outcome);
    const recon = reconstructAsOf(decision.features, outcome.openedAtMs);
    const x = projectVector(recon, ONEHOT_SCHEMA);
    const xOrd = projectVector(recon, ORDINAL_SCHEMA);
    const assumed = outcome.riskDenominatorSource === "GLOBAL_CONSTANT_ASSUMED";
    const cls = classifyObservation({
      ownerFound: true, schemaMismatchOnly: false, labelSafe: label.ok, trainingVectorComplete: x !== null,
      replayOnly: outcome.resolvedAtMs >= holdoutStartMs || assumed, // holdout OR assumed-denominator ⇒ not training-gold
    });
    attributedClassCounts[cls.klass] += 1;
    // L3 sensitivity: does the win/loss label flip across 20/30/40 bps for assumed-denominator rows?
    if (assumed && label.ok) {
      assumedRows += 1;
      const labels = BPS_SENSITIVITY.map((bps) => { const r = computeOutcomeR(outcome, { assumedDenominatorOverride: bps / 10_000 }); return r.ok ? r.y : null; });
      if (new Set(labels.filter((v) => v != null)).size > 1) denomFlipCount += 1;
    }
    const base: DatasetRow = { tMs: outcome.resolvedAtMs, laneId: outcome.laneId, symbolOrBasket: outcome.symbolOrBasket, side: outcome.side, x: x ?? [], netR: label.ok ? label.netR : null, klass: cls.klass, y: null };
    cortexRows.push({ ...base, y: label.ok ? label.y : null, xOrdinal: xOrd, denomSource: outcome.riskDenominatorSource ?? null, symbol: outcome.symbolOrBasket });
    directionRows.push({ ...base, y: directionTarget(outcome.side, decision.directionAction) });
    entryRows.push({ ...base, y: entryTarget(decision.entryAction, true) });
    const ex = exitTarget(outcome);
    if (ex) exitRows.push({ ...base, y: ex });
  }

  const cortexFamily = assembleFamily("CORTEX_ALLOCATION", ONEHOT_SCHEMA, ["loss", "win"], cortexRows, []);
  const directionFamily = assembleFamily("DIRECTION", ONEHOT_SCHEMA, ["LONG", "SHORT", "FLAT"], directionRows, []);
  const entryFamily = assembleFamily("ENTRY", ONEHOT_SCHEMA, ["ENTER_NOW", "WAIT", "SKIP"], entryRows, ["WAIT/SKIP rows require the decision-log entry stream (not joined this run)"]);
  const exitFamily = assembleFamily("EXIT", ONEHOT_SCHEMA, ["HOLD", "TRAIL", "SCALE_OUT", "EXIT"], exitRows, EXIT_UNSUPPORTED_MFE_MAE);

  // ── Walk-forward (L1): TRAIN-only frozen thresholds, pre-registered metric suite, Brier vs base rate. ──
  const trainable = cortexRows.filter((r) => r.klass === "VALID_FOR_TRAINING" && r.y != null && r.x.length === ONEHOT_SCHEMA.length);
  const plan = planWalkForward(trainable, 3, 0.25);
  const foldReports = plan.folds.map((f) => {
    const trainX = f.trainIdx.map((i) => plan.sorted[i]!.x);
    const trainY = f.trainIdx.map((i) => plan.sorted[i]!.y as 0 | 1);
    const model = fitLogisticL2(trainX, trainY, ONEHOT_SCHEMA, { l2: 1.0 });
    const trainScores = f.trainIdx.map((i) => predictLogistic(model, plan.sorted[i]!.x) ?? 0.5);
    const trainBaseRate = model.positiveRate;
    const preds = f.testIdx.map((i) => ({ p: predictLogistic(model, plan.sorted[i]!.x) ?? 0.5, y: plan.sorted[i]!.y as 0 | 1 }));
    const testScored = f.testIdx.map((i) => ({ score: predictLogistic(model, plan.sorted[i]!.x) ?? 0.5, netR: plan.sorted[i]!.netR ?? 0 }));
    const bins = calibrationBins(preds, 5);
    return {
      fold: f.index, trainN: f.trainIdx.length, testN: f.testIdx.length, trainBaseRate: round(trainBaseRate),
      brier: round(brierScore(preds)), brierVsBaseRate: roundObj(brierVsBaseRate(preds, trainBaseRate)),
      calibrationLine: roundObj(calibrationLine(bins)),
      preRegisteredDecisionMetrics: preRegisteredDecisionMetrics(testScored, trainScores, trainBaseRate).map((m) => ({ ...m, threshold: round(m.threshold), meanNetR: round(m.meanNetR), alphaR: round(m.alphaR), coverage: round(m.coverage) })),
      maxDrawdownR: round(maxDrawdownR(testScored.map((t) => t.netR))),
    };
  });

  // ── L4 sensitivity: confidence one-hot vs ordinal (does the encoding choice move the fit?). ──
  const ordTrainable = trainable.filter((r) => r.xOrdinal && r.xOrdinal.length === ORDINAL_SCHEMA.length);
  const mOneHot = trainable.length >= 20 ? fitLogisticL2(trainable.map((r) => r.x), trainable.map((r) => r.y as 0 | 1), ONEHOT_SCHEMA, { l2: 1.0 }) : null;
  const mOrdinal = ordTrainable.length >= 20 ? fitLogisticL2(ordTrainable.map((r) => r.xOrdinal!), ordTrainable.map((r) => r.y as 0 | 1), ORDINAL_SCHEMA, { l2: 1.0 }) : null;

  // ── Warm-start candidate (shadow-only; one-hot is the default schema). ──
  const spanMs = resolvedTimes.length ? resolvedTimes[resolvedTimes.length - 1]! - resolvedTimes[0]! : 0;
  const guards = warmStartGuards(spanMs);
  const directionPriors = computeClassPriors(directionRows.filter((r) => r.klass === "VALID_FOR_TRAINING").map((r) => String(r.y)), new Map());

  // ── Effective-sample-size caveat (L4): 5,112 rows ≠ 5,112 independent observations. ──
  const dayOf = (ms: number) => Math.floor(ms / 86_400_000);
  const distinctDays = new Set(trainable.map((r) => dayOf(r.tMs))).size;
  const distinctSymbols = new Set(trainable.map((r) => r.symbol ?? "∅")).size;
  const distinctLanes = new Set(trainable.map((r) => r.laneId)).size;

  // ── Reconciliation. ──
  const attributionDrops: Record<string, number> = {};
  for (const d of attr.drops) attributionDrops[d.reason] = (attributionDrops[d.reason] ?? 0) + 1;
  const funnel = buildReconciliation({ rawRows, parseDrops, attributionDrops, attributedClassCounts });

  const write = (name: string, obj: unknown) => writeFileSync(join(outDir, name), JSON.stringify(obj, null, 1));
  const familySummary = (fam: ReturnType<typeof assembleFamily>) => ({ name: fam.name, featureKeys: fam.featureKeys, targetSpace: fam.targetSpace, totalRows: fam.rows.length, trainableRows: fam.trainableRows, classCounts: fam.classCounts, unsupported: fam.unsupported });

  write("summary.json", {
    generatedFromDataDir: dataDir, perSource, rawRows, outcomes: outcomes.length, decisions: decisions.length,
    attribution: attr.counts, attributionDiagnostics: attr.diagnostics,
    families: [cortexFamily, directionFamily, entryFamily, exitFamily].map(familySummary),
    // Reality-gap proxy PER-SOURCE — XSEC grossR/costR are return-FRACTIONS while paper/kronos are R-UNITS;
    // pooling them would produce a unit-inconsistent aggregate, so report each source separately.
    realityGapProxyBySource: Object.fromEntries(
      [...new Set(outcomes.map((o) => o.sourceId))].map((sid) => {
        const rows = outcomes.filter((o) => o.sourceId === sid).map((o) => ({ grossR: o.grossR, costR: o.costR }));
        const units = sid === "cross-sectional-edge" ? "return-fraction" : "R";
        return [sid, { units, ...roundObj(realityGapProxy(rows)) }];
      }),
    ),
    concentrationByLane: roundObj(concentration(new Map(trainable.map((r) => [r.laneId, r.netR ?? 0])))),
    effectiveSampleSize: { trainableRows: trainable.length, distinctDays, distinctSymbols, distinctLanes, caveat: "rows cluster by day/symbol/lane/regime — effective independent N << row count; ~21d < one 45d edge-memory half-life; regime diversity is thin." },
    denominatorSensitivity: { assumedRows, labelFlipsAcross_20_30_40_bps: denomFlipCount, flipPct: assumedRows ? round(denomFlipCount / assumedRows) : 0 },
    confidenceEncodingSensitivity: { oneHotLogLoss: round(mOneHot?.logLoss ?? null), ordinalLogLoss: round(mOrdinal?.logLoss ?? null), note: "one-hot is the default (no ordinal-spacing assumption); ordinal shown for comparison." },
  });
  write("walkforward.json", { holdoutStartMs: plan.holdoutStartMs, holdoutRows: plan.holdoutIdx.length, foldCount: plan.folds.length, note: "All selection thresholds are TRAIN-ONLY, frozen onto test. Holdout never trained/tested/tuned.", folds: foldReports });
  write("warmstart-candidate.json", { guards, cortexLogistic: mOneHot, cortexLogisticOrdinal: mOrdinal, directionPriors, note: "SHADOW-ONLY. Not wired to any live decision. liveBeta unchanged. 60-day floor not met — cannot promote." });
  write("reconciliation.json", funnel);
  write("cortex-training-rows.json", trainable.slice(0, 2000).map((r) => ({ tMs: r.tMs, laneId: r.laneId, x: r.x, y: r.y, netR: r.netR, denomSource: r.denomSource })));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    rawRows, outcomes: outcomes.length, decisions: decisions.length, attributed: attr.counts.attributed,
    attributionLagMs: attr.diagnostics.lagMs, candidatesPerOutcome: attr.diagnostics.candidatesPerOutcome, nearTtlPct: round(attr.diagnostics.nearTtlPct), decisionSide: attr.diagnostics.decisionSide,
    trainableCortex: trainable.length, effectiveSampleSize: { distinctDays, distinctSymbols, distinctLanes },
    denominatorSensitivity: { assumedRows, labelFlips: denomFlipCount },
    confidenceLogLoss: { oneHot: round(mOneHot?.logLoss ?? null), ordinal: round(mOrdinal?.logLoss ?? null) },
    reconciles: funnel.reconciles, discrepancies: funnel.discrepancies,
    daysOfData: guards.daysOfData, sixtyDayFloorMet: guards.sixtyDayFloorMet, promotable: guards.promotable,
    folds: foldReports.map((f) => ({ fold: f.fold, brier: f.brier, brierSkill: f.brierVsBaseRate.brierSkill, decisionMetrics: f.preRegisteredDecisionMetrics.map((m) => ({ name: m.name, cov: m.coverage, alpha: m.alphaR })) })),
  }, null, 1));
}

function round(v: number | null | undefined): number | null { return v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4; }
function roundObj<T extends Record<string, unknown>>(o: T): T { const r: Record<string, unknown> = {}; for (const [k, v] of Object.entries(o)) r[k] = typeof v === "number" ? round(v) : v; return r as T; }

main();
