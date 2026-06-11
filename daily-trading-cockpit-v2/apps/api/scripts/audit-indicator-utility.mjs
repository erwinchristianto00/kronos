#!/usr/bin/env node
// Throwaway READ-ONLY analytics: indicator-utility audit on closed shadow tape.
// Does NOT mutate any production file or feed any feature. Safe to delete.

import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(process.cwd());
const POS_FILE = path.join(REPO, 'data', 'shadow-positions.json');
const KRON_CF_FILE = path.join(REPO, 'apps', 'api', 'data', 'kronos-counterfactual-observations.json');

const posRaw = fs.readFileSync(POS_FILE, 'utf-8');
const positions = JSON.parse(posRaw);

// ---- Helpers --------------------------------------------------------------

function fmt(x, d = 4) {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  return Number(x).toFixed(d);
}

function aggregate(rows, rField = 'realizedNetR') {
  const r = rows.map(p => Number(p[rField] ?? 0)).filter(v => Number.isFinite(v));
  const n = r.length;
  if (n === 0) return { n: 0, avgR: null, sumR: 0, pf: null, wr: null };
  const sum = r.reduce((a, b) => a + b, 0);
  const wins = r.filter(v => v > 0);
  const losses = r.filter(v => v < 0);
  const pf = losses.length > 0
    ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0))
    : (wins.length > 0 ? Infinity : 0);
  return {
    n,
    avgR: sum / n,
    sumR: sum,
    pf,
    wr: wins.length / n,
  };
}

// Flatten: pick the variant matching position.selectedExitVariant (or any closed variant for it).
function flatten(positions) {
  const out = [];
  for (const p of positions) {
    if (!Array.isArray(p.variants)) continue;
    const wanted = p.selectedExitVariant;
    let variant = wanted ? p.variants.find(v => v.variant === wanted && v.state === 'CLOSED') : null;
    if (!variant) variant = p.variants.find(v => v.state === 'CLOSED' && v.closeReason !== 'NO_FILL');
    if (!variant) continue;
    if (variant.closeReason === 'NO_FILL') continue;

    const ctx = p.strategyContextSnapshot || p.strategyContext || {};
    out.push({
      id: p.id,
      symbol: p.symbol,
      direction: p.direction,
      selectedEntryVariant: p.selectedEntryVariant,
      selectedExitVariant: p.selectedExitVariant,
      marketRegimeRaw: p.marketRegime || ctx.marketRegime || null,
      closeReason: variant.closeReason,
      realizedNetR: Number(variant.realizedNetR ?? 0),
      realizedGrossR: Number(variant.realizedGrossR ?? 0),
      // top-level
      stopDistanceBps: Number(p.stopDistanceBps ?? ctx.stopDistanceBps ?? NaN),
      // context fields
      kronosBias: ctx.selectedKronosBias || ctx.kronosBias1h || null,
      kronosAgrees: ctx.selectedKronosBias ? (ctx.selectedKronosBias === p.direction) : null,
      whaleAgreement: ctx.whaleAgreement || null,
      horizonConflict: ctx.horizonConflict ?? null,
      liveSourceConflict: ctx.liveSourceConflict ?? null,
      chaseRisk: ctx.chaseRisk || null,
      entryDriftPctOfZone: ctx.entryDriftPctOfZone ?? null,
      entryDriftAtr: ctx.entryDriftAtr ?? null,
      opportunityScore: ctx.opportunityScore ?? p.latestScore ?? null,
      evidenceEra: ctx.evidenceEra || p.evidenceEra || null,
      trendStackLabel: ctx.trendStackLabel || null,
      directionalAlignmentLabel: ctx.directionalAlignmentLabel || null,
    });
  }
  return out;
}

const rows = flatten(positions);
console.log(`flatten: total flattened closed (filled) rows = ${rows.length} from ${positions.length} positions`);

// Baseline cohort -----------------------------------------------------------
function isBearRegime(r) {
  if (!r) return false;
  const s = String(r).toLowerCase();
  return s.includes('bear');
}
function isPostCalib(row) {
  return row.evidenceEra === 'POST_CALIBRATION';
}

const baselineRows = rows.filter(r =>
  isPostCalib(r) &&
  isBearRegime(r.marketRegimeRaw) &&
  r.direction === 'SHORT' &&
  r.selectedEntryVariant === 'vwap_retest_entry' &&
  r.selectedExitVariant === 'tp1_full_exit'
);
const baseline = aggregate(baselineRows);
const baselineGross = aggregate(baselineRows, 'realizedGrossR');
console.log('\n=== BASELINE COHORT ===');
console.log({
  n: baseline.n,
  netAvgR: fmt(baseline.avgR),
  grossAvgR: fmt(baselineGross.avgR),
  PF: fmt(baseline.pf, 3),
  WR: fmt(baseline.wr, 3),
});

// Indicator slicer ----------------------------------------------------------
function slice(rows, predicate, label) {
  const ON = rows.filter(predicate);
  const OFF = rows.filter(r => !predicate(r));
  const onAgg = aggregate(ON);
  const offAgg = aggregate(OFF);
  return {
    label,
    onN: onAgg.n,
    onAvgR: onAgg.avgR,
    onPF: onAgg.pf,
    onWR: onAgg.wr,
    offN: offAgg.n,
    offAvgR: offAgg.avgR,
    offPF: offAgg.pf,
    offWR: offAgg.wr,
  };
}

const slices = [];

// 1. Kronos agreement
slices.push(slice(baselineRows, r => r.kronosAgrees === true, 'Kronos AGREES'));
slices.push(slice(baselineRows, r => r.kronosAgrees === false, 'Kronos DISAGREES'));

// 3. Whale
slices.push(slice(baselineRows, r => r.whaleAgreement === 'AGREES', 'Whale AGREES'));
slices.push(slice(baselineRows, r => r.whaleAgreement === 'DISAGREES', 'Whale DISAGREES'));
slices.push(slice(baselineRows, r => r.whaleAgreement === 'UNAVAILABLE', 'Whale UNAVAILABLE'));

// 4. Trend alignment - directionalAlignmentLabel CLEAR vs MIXED
slices.push(slice(baselineRows, r => r.directionalAlignmentLabel === 'ALIGNED', 'TrendAlign ALIGNED'));
slices.push(slice(baselineRows, r => r.directionalAlignmentLabel === 'MIXED', 'TrendAlign MIXED'));
slices.push(slice(baselineRows, r => r.directionalAlignmentLabel === 'CONFLICTED', 'TrendAlign CONFLICTED'));

// 5. liveSourceConflict
slices.push(slice(baselineRows, r => r.liveSourceConflict === true, 'liveSourceConflict TRUE'));
slices.push(slice(baselineRows, r => r.liveSourceConflict === false, 'liveSourceConflict FALSE'));

// 6. horizonConflict
slices.push(slice(baselineRows, r => r.horizonConflict === true, 'horizonConflict TRUE'));
slices.push(slice(baselineRows, r => r.horizonConflict === false, 'horizonConflict FALSE'));

// 7. chaseRisk
slices.push(slice(baselineRows, r => r.chaseRisk === 'HIGH', 'chaseRisk HIGH'));
slices.push(slice(baselineRows, r => r.chaseRisk === 'MEDIUM', 'chaseRisk MEDIUM'));
slices.push(slice(baselineRows, r => r.chaseRisk === 'LOW', 'chaseRisk LOW'));

// 8. entryDriftPctOfZone
slices.push(slice(baselineRows, r => r.entryDriftPctOfZone !== null && r.entryDriftPctOfZone <= -0.65, 'entryDriftPctOfZone <= -0.65'));
slices.push(slice(baselineRows, r => r.entryDriftPctOfZone !== null && r.entryDriftPctOfZone > -0.65 && r.entryDriftPctOfZone <= -0.2, 'entryDriftPctOfZone -0.65..-0.2'));
slices.push(slice(baselineRows, r => r.entryDriftPctOfZone !== null && r.entryDriftPctOfZone > -0.2, 'entryDriftPctOfZone >= -0.2'));

// 9. entryDriftAtr
slices.push(slice(baselineRows, r => r.entryDriftAtr !== null && r.entryDriftAtr >= 2.0, 'entryDriftAtr >= 2.0'));
slices.push(slice(baselineRows, r => r.entryDriftAtr !== null && r.entryDriftAtr < 2.0, 'entryDriftAtr < 2.0'));

// 10. stopDistanceBps
slices.push(slice(baselineRows, r => r.stopDistanceBps < 100, 'stopDistanceBps <100'));
slices.push(slice(baselineRows, r => r.stopDistanceBps >= 100 && r.stopDistanceBps < 300, 'stopDistanceBps 100-300'));
slices.push(slice(baselineRows, r => r.stopDistanceBps >= 300, 'stopDistanceBps 300+'));

// 11. marketRegime BEARISH_EXPANSION vs other (baseline is already bear, so this is degenerate; we evaluate "Bearish pressure" presence vs other bear shades)
slices.push(slice(rows.filter(r => isPostCalib(r) && r.direction === 'SHORT' && r.selectedEntryVariant === 'vwap_retest_entry' && r.selectedExitVariant === 'tp1_full_exit'),
  r => isBearRegime(r.marketRegimeRaw), 'BEAR regime (vs all regimes, same route)'));

// 12. opportunityScore buckets
slices.push(slice(baselineRows, r => r.opportunityScore >= 60 && r.opportunityScore < 70, 'opportunityScore 60-70'));
slices.push(slice(baselineRows, r => r.opportunityScore >= 70 && r.opportunityScore < 80, 'opportunityScore 70-80'));
slices.push(slice(baselineRows, r => r.opportunityScore >= 80, 'opportunityScore 80+'));

// 13. FingerprintV0 MATCH heuristic: stopDistanceBps <= 300 AND entryDriftPctOfZone <= -0.5
slices.push(slice(baselineRows, r => r.stopDistanceBps <= 300 && r.entryDriftPctOfZone !== null && r.entryDriftPctOfZone <= -0.5, 'FingerprintV0 MATCH (heuristic)'));

console.log('\n=== PER-INDICATOR SLICES ===');
for (const s of slices) {
  console.log(s.label.padEnd(40),
    `ON n=${String(s.onN).padStart(4)}`,
    `avgR=${fmt(s.onAvgR)}`,
    `PF=${fmt(s.onPF, 3)}`,
    `WR=${fmt(s.onWR, 3)}`,
    `| OFF n=${String(s.offN).padStart(4)}`,
    `avgR=${fmt(s.offAvgR)}`,
    `PF=${fmt(s.offPF, 3)}`);
}

// Redundancy --------------------------------------------------------------
function jointSlice(rows, pa, pb, labelA, labelB) {
  const both = rows.filter(r => pa(r) && pb(r));
  const onlyA = rows.filter(r => pa(r) && !pb(r));
  const onlyB = rows.filter(r => !pa(r) && pb(r));
  const neither = rows.filter(r => !pa(r) && !pb(r));
  console.log(`\n--- redundancy ${labelA} vs ${labelB} ---`);
  console.log('both    ', aggregate(both));
  console.log('onlyA   ', aggregate(onlyA));
  console.log('onlyB   ', aggregate(onlyB));
  console.log('neither ', aggregate(neither));
}

jointSlice(baselineRows,
  r => r.kronosAgrees === false,
  r => r.liveSourceConflict === true,
  'KronosDISAGREES', 'liveSourceConflict');

jointSlice(baselineRows,
  r => r.entryDriftPctOfZone !== null && r.entryDriftPctOfZone <= -0.5,
  r => r.entryDriftAtr !== null && r.entryDriftAtr >= 2.0,
  'driftPct<=-0.5', 'driftAtr>=2');

jointSlice(baselineRows,
  r => r.whaleAgreement === 'AGREES',
  r => r.horizonConflict === false,
  'WhaleAGREES', 'NoHorizonConflict');

// Kronos counterfactual ----------------------------------------------------
console.log('\n=== KRONOS COUNTERFACTUAL ===');
try {
  const cfRaw = fs.readFileSync(KRON_CF_FILE, 'utf-8');
  const cf = JSON.parse(cfRaw);
  const obs = cf.observations || [];
  const resolved = obs.filter(o => o.observationStatus === 'RESOLVED' && o.outcome && o.outcome.fillStatus === 'FILLED');
  const cfRows = resolved.map(o => ({
    realizedNetR: Number(o.outcome.realizedNetR ?? 0),
    realizedGrossR: Number(o.outcome.realizedGrossR ?? 0),
    liveSourceConflict: o.snapshot?.liveSourceConflict ?? null,
    kronosAgrees: o.snapshot?.kronosAgrees ?? null,
  }));
  console.log('Counterfactual total resolved (filled):', cfRows.length);
  console.log('  Overall:', aggregate(cfRows));
  console.log('  liveSourceConflict=TRUE:', aggregate(cfRows.filter(r => r.liveSourceConflict === true)));
  console.log('  liveSourceConflict=FALSE:', aggregate(cfRows.filter(r => r.liveSourceConflict === false)));
  console.log('  kronosAgrees=TRUE:', aggregate(cfRows.filter(r => r.kronosAgrees === true)));
  console.log('  kronosAgrees=FALSE:', aggregate(cfRows.filter(r => r.kronosAgrees === false)));
} catch (e) {
  console.log('CF read failed:', e.message);
}

// Diagnostic: count nulls in each indicator within baseline cohort
console.log('\n=== INDICATOR COVERAGE IN BASELINE ===');
function pctNonNull(field) {
  const filled = baselineRows.filter(r => r[field] !== null && r[field] !== undefined && !(typeof r[field] === 'number' && Number.isNaN(r[field]))).length;
  return `${filled}/${baselineRows.length}`;
}
for (const f of ['kronosBias','kronosAgrees','whaleAgreement','horizonConflict','liveSourceConflict','chaseRisk','entryDriftPctOfZone','entryDriftAtr','stopDistanceBps','opportunityScore','directionalAlignmentLabel']) {
  console.log(`  ${f.padEnd(30)} coverage = ${pctNonNull(f)}`);
}

// Show directionalAlignmentLabel distribution
const labels = {};
for (const r of baselineRows) {
  const v = r.directionalAlignmentLabel || 'null';
  labels[v] = (labels[v] || 0) + 1;
}
console.log('directionalAlignmentLabel dist:', labels);

// Joint: WHALE_AGREES + NO_HORIZON_CONFLICT vs the rest
const wnhc = baselineRows.filter(r => r.whaleAgreement === 'AGREES' && r.horizonConflict === false);
const notWnhc = baselineRows.filter(r => !(r.whaleAgreement === 'AGREES' && r.horizonConflict === false));
console.log('\nWHALE+NO_HC ON:', aggregate(wnhc));
console.log('WHALE+NO_HC OFF:', aggregate(notWnhc));

// Joint: FingerprintV0 MATCH within Whale AGREES
const matchAndWhale = baselineRows.filter(r => r.stopDistanceBps <= 300 && r.entryDriftPctOfZone <= -0.5 && r.whaleAgreement === 'AGREES');
console.log('FP-MATCH ∩ Whale AGREES:', aggregate(matchAndWhale));
