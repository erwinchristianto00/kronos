// READ-ONLY AUDIT — Symbol Concentration Robustness
//
// Audits two conditional-alpha filters over base lane
// (POST_CALIBRATION + BEARISH_EXPANSION + SHORT + vwap_retest_entry + tp1_full_exit):
//
//   Filter A: WHALE_AGREES
//   Filter B: WHALE_AGREES + NO_HORIZON_CONFLICT
//
// Reconstructs cohorts directly from data/shadow-positions.json.
// Does not modify any file or live behavior.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const DATA = path.join(ROOT, "data", "shadow-positions.json");
const positions = JSON.parse(fs.readFileSync(DATA, "utf8"));

// ---------- helpers (mirrored from audit-whale-horizon-cohorts.mjs) ----------
function normalizeRegime(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).toUpperCase();
  if (s.includes("BULL")) return "BULLISH_EXPANSION";
  if (s.includes("BEAR")) return "BEARISH_EXPANSION";
  if (s.includes("SIDE") || s.includes("RANGE") || s.includes("CHOP")) return "SIDEWAYS";
  if (s.includes("MIX")) return "MIXED";
  return s;
}
function primaryClosedVariant(p) {
  return (
    p.variants.find((v) => v.variant === p.selectedExitVariant && v.state === "CLOSED") ??
    p.variants.find((v) => v.state === "CLOSED") ??
    null
  );
}
function buildRecord(p) {
  const variant = primaryClosedVariant(p);
  if (!variant) return null;
  const ctx = p.strategyContextSnapshot ?? null;
  if (!ctx) return null;
  const realizedNetR = Number.isFinite(variant.realizedNetR) ? variant.realizedNetR : null;
  const realizedGrossR = Number.isFinite(variant.realizedGrossR) ? variant.realizedGrossR : null;
  const openedAt = p.entryFilledAt ?? variant.openedAt ?? p.scannedAt ?? null;
  const closedAt = variant.closedAt ?? null;
  return {
    positionId: p.id,
    context: {
      ...ctx,
      direction: p.direction,
      symbol: p.symbol,
      evidenceEra: ctx.evidenceEra ?? p.variantSelection?.evidenceEra ?? null,
    },
    outcome: {
      symbol: p.symbol,
      direction: p.direction,
      selectedEntryVariant: p.selectedEntryVariant ?? p.variantSelection?.selectedEntryVariant ?? null,
      selectedExitVariant: variant.variant ?? p.selectedExitVariant ?? null,
      openedAt,
      closedAt,
      closeReason: variant.closeReason ?? null,
      realizedGrossR,
      realizedNetR,
    },
  };
}

const allRecords = positions.map(buildRecord).filter(Boolean);
const postCal = allRecords.filter(
  (r) => (r.context.evidenceEra ?? null) === "POST_CALIBRATION",
);

function isBase(rec) {
  return (
    normalizeRegime(rec.context.marketRegime) === "BEARISH_EXPANSION" &&
    rec.context.direction === "SHORT" &&
    rec.context.selectedEntryVariant === "vwap_retest_entry" &&
    rec.outcome.selectedExitVariant === "tp1_full_exit"
  );
}
const isWhaleAgrees = (r) => r.context.whaleAgreement === "AGREES";
const isNoHC = (r) => r.context.horizonConflict === false;

const base = postCal.filter(isBase);
const whale = base.filter(isWhaleAgrees);
const both = base.filter((r) => isWhaleAgrees(r) && isNoHC(r));

// ---------- metric utilities ----------
function sum(arr) { return arr.reduce((s, v) => s + v, 0); }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round4(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return v;
  return Math.round(v * 10_000) / 10_000;
}
function metricsOf(cohort) {
  const n = cohort.length;
  if (!n) return { n: 0, netAvgR: null, PF: null, winRate: null, netSumR: 0 };
  const netRs = cohort.map((r) => r.outcome.realizedNetR).filter(Number.isFinite);
  const wins = netRs.filter((v) => v > 0);
  const losses = netRs.filter((v) => v < 0);
  const winSum = sum(wins);
  const lossAbs = Math.abs(sum(losses));
  const netSumR = sum(netRs);
  return {
    n,
    netAvgR: round4(netSumR / netRs.length),
    PF: lossAbs === 0 ? null : round4(winSum / lossAbs),
    winRate: round4(wins.length / n),
    netSumR: round4(netSumR),
  };
}
const FIFTEEN_MIN_MS = 15 * 60_000;
function bucketTime(epochMs) {
  return Math.floor(epochMs / FIFTEEN_MIN_MS);
}
function bucketPrice(price) {
  if (!Number.isFinite(price) || price <= 0) return null;
  return Math.floor(Math.log(price) / 0.0005);
}
function nEffective(cohort) {
  const seen = new Set();
  let nullCnt = 0;
  for (const rec of cohort) {
    const symbol = rec.context.symbol;
    const direction = rec.context.direction;
    const entry = rec.context.selectedEntryVariant ?? "X";
    const exit = rec.outcome.selectedExitVariant ?? "X";
    const t = rec.outcome.openedAt ? new Date(rec.outcome.openedAt).getTime() : NaN;
    const tb = Number.isFinite(t) ? bucketTime(t) : `tn_${nullCnt++}`;
    const pb = bucketPrice(rec.context.entryPrice ?? NaN) ?? `pn_${nullCnt++}`;
    seen.add(`${symbol}|${direction}|${entry}|${exit}|${tb}|${pb}`);
  }
  return seen.size;
}

// ---------- 1. Cohort summary ----------
console.log("=== Cohort summary ===");
const cohortRows = [
  { name: "BASE", recs: base },
  { name: "WHALE", recs: whale },
  { name: "BOTH", recs: both },
].map(({ name, recs }) => {
  const m = metricsOf(recs);
  return { Cohort: name, n: m.n, nEff: nEffective(recs), netAvgR: m.netAvgR, PF: m.PF, WR: m.winRate, netSumR: m.netSumR };
});
console.table(cohortRows);

// ---------- 2. Symbol contribution ----------
function symbolBreakdown(cohort) {
  const bySym = new Map();
  for (const r of cohort) {
    const s = r.context.symbol;
    const lst = bySym.get(s) ?? [];
    lst.push(r);
    bySym.set(s, lst);
  }
  const cohortNetSum = sum(
    cohort.map((r) => r.outcome.realizedNetR).filter(Number.isFinite),
  );
  const denom = cohortNetSum === 0 ? 1 : Math.abs(cohortNetSum);
  const rows = [...bySym.entries()].map(([sym, recs]) => {
    const m = metricsOf(recs);
    return {
      symbol: sym,
      n: m.n,
      netAvgR: m.netAvgR,
      netSumR: m.netSumR,
      PF: m.PF,
      WR: m.winRate,
      shareNetSumR: round4(m.netSumR / denom),
    };
  });
  rows.sort((a, b) => b.netSumR - a.netSumR);
  return rows;
}
function concentrationVerdict(rows) {
  const positive = rows.filter((r) => r.netSumR > 0).length;
  const total = rows.length;
  const totalPos = sum(rows.filter((r) => r.netSumR > 0).map((r) => r.netSumR));
  const denom = totalPos === 0 ? 1 : totalPos;
  const top1 = rows[0]?.netSumR > 0 ? rows[0].netSumR / denom : 0;
  const top2 = sum(rows.slice(0, 2).filter((r) => r.netSumR > 0).map((r) => r.netSumR)) / denom;
  const top3 = sum(rows.slice(0, 3).filter((r) => r.netSumR > 0).map((r) => r.netSumR)) / denom;
  let verdict;
  if (top2 >= 0.95) verdict = "EXTREMELY_SYMBOL_CONCENTRATED";
  else if (top2 >= 0.8) verdict = "SYMBOL_CONCENTRATED";
  else if (top2 >= 0.6) verdict = "MODERATELY_CONCENTRATED";
  else verdict = "BROADLY_DIVERSIFIED";
  return {
    positiveContributors: positive,
    negativeContributors: total - positive,
    distinctSymbols: total,
    top1ShareOfPositive: round4(top1),
    top2ShareOfPositive: round4(top2),
    top3ShareOfPositive: round4(top3),
    verdict,
  };
}

console.log("\n=== WHALE symbol contribution ===");
const whaleSymRows = symbolBreakdown(whale);
console.table(whaleSymRows);
const whaleConc = concentrationVerdict(whaleSymRows);
console.log("WHALE concentration:", whaleConc);

console.log("\n=== BOTH symbol contribution ===");
const bothSymRows = symbolBreakdown(both);
console.table(bothSymRows);
const bothConc = concentrationVerdict(bothSymRows);
console.log("BOTH concentration:", bothConc);

// ---------- 3. Remove-top-symbol robustness ----------
function removeTopK(cohort, k) {
  const rows = symbolBreakdown(cohort);
  const drop = new Set(rows.slice(0, k).map((r) => r.symbol));
  const remaining = cohort.filter((r) => !drop.has(r.context.symbol));
  const m = metricsOf(remaining);
  return { dropped: [...drop], n: m.n, netAvgR: m.netAvgR, PF: m.PF, WR: m.winRate, netSumR: m.netSumR };
}
function robustnessTable(cohort, name) {
  const orig = metricsOf(cohort);
  const rows = [
    { Scenario: "Original", n: orig.n, netAvgR: orig.netAvgR, PF: orig.PF, WR: orig.winRate, netSumR: orig.netSumR, dropped: "" },
  ];
  for (let k = 1; k <= 3; k++) {
    const r = removeTopK(cohort, k);
    rows.push({ Scenario: `Remove top ${k}`, n: r.n, netAvgR: r.netAvgR, PF: r.PF, WR: r.winRate, netSumR: r.netSumR, dropped: r.dropped.join(",") });
  }
  console.log(`\n=== Robustness — ${name} (remove top-K by netSumR) ===`);
  console.table(rows);
  return rows;
}
const whaleRobust = robustnessTable(whale, "WHALE");
const bothRobust = robustnessTable(both, "BOTH");

// ---------- 4. LOSO — Leave-one-symbol-out ----------
function losoTable(cohort, name) {
  const orig = metricsOf(cohort);
  const symbols = [...new Set(cohort.map((r) => r.context.symbol))];
  const rows = symbols.map((s) => {
    const remaining = cohort.filter((r) => r.context.symbol !== s);
    const m = metricsOf(remaining);
    return {
      excluded: s,
      remainingN: m.n,
      remainingNetAvgR: m.netAvgR,
      deltaVsOriginal: round4((m.netAvgR ?? 0) - (orig.netAvgR ?? 0)),
      remainingNetSumR: m.netSumR,
      remainingPF: m.PF,
    };
  });
  rows.sort((a, b) => a.deltaVsOriginal - b.deltaVsOriginal); // most load-bearing first (largest drop)
  console.log(`\n=== LOSO — ${name} ===`);
  console.table(rows);
  return rows;
}
const whaleLOSO = losoTable(whale, "WHALE");
const bothLOSO = losoTable(both, "BOTH");

// ---------- 5. Symbol diversity quality ----------
function diversityQuality(rows) {
  const sums = rows.map((r) => r.netSumR);
  const avgs = rows.map((r) => r.netAvgR).filter(Number.isFinite);
  const positiveSum = rows.filter((r) => r.netSumR > 0).length;
  const positiveAvg = rows.filter((r) => Number.isFinite(r.netAvgR) && r.netAvgR > 0).length;
  const totalNet = sum(sums);
  const denom = totalNet === 0 ? 1 : Math.abs(totalNet);
  const hhi = sum(sums.map((v) => (v / denom) ** 2));
  return {
    symbols: rows.length,
    netSumR_positive: positiveSum,
    netAvgR_positive: positiveAvg,
    median_netSumR: round4(median(sums)),
    mean_netSumR: round4(sum(sums) / (sums.length || 1)),
    median_netAvgR: round4(median(avgs)),
    HHI_share_of_netSumR_signed: round4(hhi),
  };
}
console.log("\n=== Diversity quality — WHALE ===");
console.log(diversityQuality(whaleSymRows));
console.log("\n=== Diversity quality — BOTH ===");
console.log(diversityQuality(bothSymRows));

// ---------- 6. Base vs filter per-symbol ----------
function netAvgBySymbol(cohort) {
  const bySym = new Map();
  for (const r of cohort) {
    const s = r.context.symbol;
    if (!bySym.has(s)) bySym.set(s, []);
    bySym.get(s).push(r);
  }
  const map = new Map();
  for (const [s, recs] of bySym.entries()) {
    map.set(s, metricsOf(recs));
  }
  return map;
}
const baseBySym = netAvgBySymbol(base);
const whaleBySym = netAvgBySymbol(whale);
const bothBySym = netAvgBySymbol(both);
const allSyms = new Set([...baseBySym.keys()]);
const compareRows = [...allSyms].map((s) => {
  const b = baseBySym.get(s);
  const w = whaleBySym.get(s);
  const bo = bothBySym.get(s);
  return {
    symbol: s,
    baseN: b?.n ?? 0,
    baseNetAvgR: b?.netAvgR ?? null,
    whaleN: w?.n ?? 0,
    whaleNetAvgR: w?.netAvgR ?? null,
    bothN: bo?.n ?? 0,
    bothNetAvgR: bo?.netAvgR ?? null,
    deltaWhaleVsBase:
      w && b && b.netAvgR !== null && w.netAvgR !== null ? round4(w.netAvgR - b.netAvgR) : null,
    deltaBothVsBase:
      bo && b && b.netAvgR !== null && bo.netAvgR !== null ? round4(bo.netAvgR - b.netAvgR) : null,
  };
});
compareRows.sort((a, b) => (b.baseN ?? 0) - (a.baseN ?? 0));
console.log("\n=== Base vs Filter — per symbol netAvgR ===");
console.table(compareRows);

// Selection effect summary
function selectionEffectSummary(rows, deltaKey) {
  const withFilter = rows.filter((r) => r[deltaKey] !== null);
  const improved = withFilter.filter((r) => r[deltaKey] > 0).length;
  const same = withFilter.filter((r) => r[deltaKey] === 0).length;
  const worse = withFilter.filter((r) => r[deltaKey] < 0).length;
  return { symbolsWithFilterData: withFilter.length, improved, same, worse };
}
console.log("WHALE selection effect:", selectionEffectSummary(compareRows, "deltaWhaleVsBase"));
console.log("BOTH selection effect: ", selectionEffectSummary(compareRows, "deltaBothVsBase"));

// ---------- 7. Temporal cross-check for top-3 symbols ----------
function temporalSplitOf(records) {
  const withT = records
    .map((r) => ({ r, t: new Date(r.outcome.openedAt ?? 0).getTime() }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  if (withT.length < 2) return null;
  const half = Math.floor(withT.length / 2);
  const early = withT.slice(0, half).map((x) => x.r);
  const late = withT.slice(half).map((x) => x.r);
  return { early: metricsOf(early), late: metricsOf(late) };
}
function topThreeTemporal(cohort, symRows, name) {
  const top3 = symRows.slice(0, 3).map((r) => r.symbol);
  const rows = [];
  for (const sym of top3) {
    const symRecs = cohort.filter((r) => r.context.symbol === sym);
    const split = temporalSplitOf(symRecs);
    rows.push({
      symbol: sym,
      filter: name,
      n: symRecs.length,
      earlyN: split?.early.n ?? null,
      earlyNetAvgR: split?.early.netAvgR ?? null,
      lateN: split?.late.n ?? null,
      lateNetAvgR: split?.late.netAvgR ?? null,
    });
  }
  return rows;
}
console.log("\n=== Top-3 symbol temporal cross-check ===");
console.table([
  ...topThreeTemporal(whale, whaleSymRows, "WHALE"),
  ...topThreeTemporal(both, bothSymRows, "BOTH"),
]);

// ---------- 8. Episode concentration within top contributors ----------
function episodeBuckets(records) {
  const map = new Map();
  let nullCnt = 0;
  for (const r of records) {
    const t = r.outcome.openedAt ? new Date(r.outcome.openedAt).getTime() : NaN;
    const tb = Number.isFinite(t) ? bucketTime(t) : `tn_${nullCnt++}`;
    const pb = bucketPrice(r.context.entryPrice ?? NaN) ?? `pn_${nullCnt++}`;
    const key = `${tb}|${pb}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r.outcome.realizedNetR ?? 0);
  }
  return map;
}
function episodeConcentration(cohort, symRows, name) {
  const top = symRows.slice(0, Math.min(3, symRows.length));
  const rows = [];
  for (const s of top) {
    const symRecs = cohort.filter((r) => r.context.symbol === s.symbol);
    const buckets = episodeBuckets(symRecs);
    const sumsPerEp = [...buckets.values()].map((arr) => sum(arr));
    const totalNet = sum(sumsPerEp);
    const denom = totalNet === 0 ? 1 : Math.abs(totalNet);
    const sortedDesc = [...sumsPerEp].sort((a, b) => Math.abs(b) - Math.abs(a));
    const top1Share = sortedDesc[0] !== undefined ? sortedDesc[0] / denom : null;
    const top2Share =
      sortedDesc.length >= 2 ? (sortedDesc[0] + sortedDesc[1]) / denom : top1Share;
    let verdict;
    if (sumsPerEp.length <= 1) verdict = "ONE_BURST_DOMINATED";
    else if (Math.abs(top1Share) >= 0.8) verdict = "ONE_BURST_DOMINATED";
    else if (Math.abs(top1Share) >= 0.5) verdict = "SOME_EPISODE_CONCENTRATION";
    else verdict = "HEALTHY_MULTI_EPISODE_SUPPORT";
    rows.push({
      filter: name,
      symbol: s.symbol,
      n: symRecs.length,
      episodes: sumsPerEp.length,
      top1EpisodeShare: round4(top1Share),
      top2EpisodeShare: round4(top2Share),
      verdict,
    });
  }
  return rows;
}
console.log("\n=== Episode concentration within top contributors ===");
console.table([
  ...episodeConcentration(whale, whaleSymRows, "WHALE"),
  ...episodeConcentration(both, bothSymRows, "BOTH"),]);

// ---------- 9. Cross-filter robustness summary (for final verdict) ----------
function survivalSummary(robustRows) {
  const orig = robustRows[0];
  const t1 = robustRows[1];
  const t2 = robustRows[2];
  const t3 = robustRows[3];
  return {
    originalNetAvgR: orig.netAvgR,
    afterTop1: t1.netAvgR,
    afterTop2: t2.netAvgR,
    afterTop3: t3.netAvgR,
    survivesTop1Removal: (t1.netAvgR ?? -Infinity) >= 0,
    survivesTop2Removal: (t2.netAvgR ?? -Infinity) >= 0,
    survivesTop3Removal: (t3.netAvgR ?? -Infinity) >= 0,
  };
}
console.log("\n=== Survival summary ===");
console.log("WHALE:", survivalSummary(whaleRobust));
console.log("BOTH: ", survivalSummary(bothRobust));

// ---------- 10. Top-2 share (raw, for reference) ----------
function top2SymbolShareSigned(rows) {
  const totalNet = sum(rows.map((r) => r.netSumR));
  if (totalNet === 0) return null;
  return round4(sum(rows.slice(0, 2).map((r) => r.netSumR)) / totalNet);
}
console.log("\nTop-2 symbol share of signed netSumR — WHALE:", top2SymbolShareSigned(whaleSymRows));
console.log("Top-2 symbol share of signed netSumR — BOTH: ", top2SymbolShareSigned(bothSymRows));

console.log("\n--- end of audit ---");
