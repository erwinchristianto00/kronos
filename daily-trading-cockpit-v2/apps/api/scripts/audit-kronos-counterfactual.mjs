// READ-ONLY audit script for Kronos counterfactual lanes.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "../../");
const DATA_API = path.join(ROOT, "apps", "api", "data", "kronos-counterfactual-observations.json");
const DATA_ROOT = path.join(ROOT, "data", "kronos-counterfactual-observations.json");
const SHADOW = path.join(ROOT, "data", "shadow-positions.json");

const raw = JSON.parse(fs.readFileSync(DATA_API, "utf8"));
const obs = Array.isArray(raw) ? raw : raw.observations ?? raw.entries ?? raw.items ?? [];
console.log("source file:", DATA_API);

const num = (a) => a.filter((x) => Number.isFinite(x));
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const trimmedMean = (a, pct = 0.1) => {
  if (a.length < 5) return null;
  const s = [...a].sort((x, y) => x - y);
  const k = Math.floor(s.length * pct);
  const t = s.slice(k, s.length - k);
  return mean(t);
};
const pf = (a) => {
  const wins = sum(a.filter((x) => x > 0));
  const lossAbs = Math.abs(sum(a.filter((x) => x < 0)));
  return lossAbs === 0 ? null : wins / lossAbs;
};
const wr = (a) => (a.length ? (a.filter((x) => x > 0).length / a.length) * 100 : null);
const fmt = (x, d = 4) => (x === null || x === undefined ? "n/a" : typeof x === "number" ? x.toFixed(d) : x);

console.log("total observations:", obs.length);
const byLane = {};
const statusByLane = {};
for (const o of obs) {
  const L = o.lane;
  byLane[L] ??= [];
  statusByLane[L] ??= {};
  byLane[L].push(o);
  statusByLane[L][o.observationStatus] = (statusByLane[L][o.observationStatus] ?? 0) + 1;
}

function laneStats(list) {
  const resolved = list.filter((o) => o.observationStatus === "RESOLVED" && Number.isFinite(o.outcome?.realizedNetR));
  const r = resolved.map((o) => o.outcome.realizedNetR);
  return {
    total: list.length,
    open: list.filter((o) => o.observationStatus === "OPEN").length,
    resolved: list.filter((o) => o.observationStatus === "RESOLVED").length,
    noFill: list.filter((o) => o.observationStatus === "NO_FILL").length,
    expired: list.filter((o) => o.observationStatus === "EXPIRED" || o.observationStatus === "TIME_EXPIRED").length,
    failed: list.filter((o) => o.observationStatus === "FAILED").length,
    n: r.length,
    netAvgR: mean(r),
    PF: pf(r),
    WR: wr(r),
    netSumR: sum(r),
    avgWinR: mean(r.filter((x) => x > 0)),
    avgLossR: mean(r.filter((x) => x < 0)),
    median: median(r),
    trimmed: trimmedMean(r),
    resolvedList: resolved,
  };
}

console.log("\n=== PART 1: Lane Reconstruction ===");
const stats = {};
for (const lane of Object.keys(byLane)) {
  const s = laneStats(byLane[lane]);
  stats[lane] = s;
  console.log(`\nLane: ${lane}`);
  console.log(
    `  total=${s.total} open=${s.open} resolved=${s.resolved} noFill=${s.noFill} expired=${s.expired} failed=${s.failed}`,
  );
  console.log(
    `  n=${s.n} netAvgR=${fmt(s.netAvgR)} PF=${fmt(s.PF)} WR=${fmt(s.WR, 2)}% netSumR=${fmt(s.netSumR)} avgWinR=${fmt(s.avgWinR)} avgLossR=${fmt(s.avgLossR)}`,
  );
  console.log(`  median=${fmt(s.median)} trimmed10=${fmt(s.trimmed)}`);
}

console.log("\n=== PART 2: Outlier Robustness ===");
function scenario(rArr, drop) {
  let r = [...rArr];
  if (drop === "B") r = [...r].sort((a, b) => a - b).slice(1);
  if (drop === "C") r = [...r].sort((a, b) => a - b).slice(2);
  if (drop === "D") r = [...r].sort((a, b) => a - b).slice(3);
  if (drop === "E") {
    r = [...r].sort((a, b) => b - a).slice(1);
  }
  return { n: r.length, netAvgR: mean(r), PF: pf(r), netSumR: sum(r) };
}
for (const lane of Object.keys(stats)) {
  const r = stats[lane].resolvedList.map((o) => o.outcome.realizedNetR);
  console.log(`\nLane: ${lane}`);
  for (const sc of ["A", "B", "C", "D", "E"]) {
    const drop = sc === "A" ? null : sc;
    const out = drop ? scenario(r, drop) : { n: r.length, netAvgR: mean(r), PF: pf(r), netSumR: sum(r) };
    console.log(`  ${sc}: n=${out.n} netAvgR=${fmt(out.netAvgR)} PF=${fmt(out.PF)} netSumR=${fmt(out.netSumR)}`);
  }
  const negSum = Math.abs(sum(r.filter((x) => x < 0)));
  const sorted = [...r].sort((a, b) => a - b);
  const worst1Share = negSum ? Math.abs(sorted[0]) / negSum : null;
  const worst3Share = negSum ? Math.abs(sorted.slice(0, 3).reduce((s, x) => s + x, 0)) / negSum : null;
  console.log(`  worst-1 share of negSum=${fmt(worst1Share)} worst-3 share=${fmt(worst3Share)} median=${fmt(median(r))} trimmed10=${fmt(trimmedMean(r))}`);
}

console.log("\n=== PART 3: Symbol Concentration ===");
for (const lane of Object.keys(stats)) {
  const list = stats[lane].resolvedList;
  const bySym = {};
  for (const o of list) {
    const sy = o.symbol;
    bySym[sy] ??= [];
    bySym[sy].push(o.outcome.realizedNetR);
  }
  const totalNetSum = sum(list.map((o) => o.outcome.realizedNetR));
  console.log(`\nLane: ${lane}  totalNetSum=${fmt(totalNetSum)} distinctSymbols=${Object.keys(bySym).length}`);
  const rows = [];
  for (const [s, arr] of Object.entries(bySym)) {
    rows.push({
      sym: s,
      n: arr.length,
      netAvgR: mean(arr),
      netSumR: sum(arr),
      PF: pf(arr),
      WR: wr(arr),
      share: totalNetSum !== 0 ? sum(arr) / totalNetSum : null,
    });
  }
  rows.sort((a, b) => a.netSumR - b.netSumR);
  for (const r of rows) {
    console.log(
      `  ${r.sym.padEnd(12)} n=${r.n} netAvgR=${fmt(r.netAvgR)} netSumR=${fmt(r.netSumR)} PF=${fmt(r.PF)} WR=${fmt(r.WR, 1)}% share=${fmt(r.share)}`,
    );
  }
  const pos = rows.filter((r) => r.netSumR > 0).length;
  const neg = rows.filter((r) => r.netSumR < 0).length;
  console.log(`  positive=${pos} negative=${neg}`);
  // top-1 / top-2 loss contributors
  const losers = [...rows].sort((a, b) => a.netSumR - b.netSumR);
  const lossSum = sum(rows.filter((r) => r.netSumR < 0).map((r) => r.netSumR));
  // null (not Infinity/NaN) when no symbol in this lane has a negative netSumR —
  // "loss share" is undefined when there's no loss to share.
  const top1 = lossSum !== 0 && losers[0] ? losers[0].netSumR / lossSum : null;
  const top2 = lossSum !== 0 && losers[0] ? (losers[0].netSumR + (losers[1]?.netSumR ?? 0)) / lossSum : null;
  console.log(`  top-1 loss share=${fmt(top1)} top-2 loss share=${fmt(top2)}`);
  // ex-top-1, ex-top-2
  const exTop1Rs = list.filter((o) => o.symbol !== losers[0]?.sym).map((o) => o.outcome.realizedNetR);
  const exTop2Syms = new Set([losers[0]?.sym, losers[1]?.sym]);
  const exTop2Rs = list.filter((o) => !exTop2Syms.has(o.symbol)).map((o) => o.outcome.realizedNetR);
  console.log(`  ex-top1 (${losers[0]?.sym}): n=${exTop1Rs.length} netAvgR=${fmt(mean(exTop1Rs))} PF=${fmt(pf(exTop1Rs))}`);
  console.log(`  ex-top2 ([${[...exTop2Syms].join(",")}]): n=${exTop2Rs.length} netAvgR=${fmt(mean(exTop2Rs))} PF=${fmt(pf(exTop2Rs))}`);
}

console.log("\n=== PART 4: Direction Breakdown ===");
for (const lane of Object.keys(stats)) {
  const list = stats[lane].resolvedList;
  const byDir = {};
  for (const o of list) {
    const d = o.snapshot?.direction ?? "UNK";
    byDir[d] ??= [];
    byDir[d].push(o.outcome.realizedNetR);
  }
  console.log(`\nLane: ${lane}`);
  for (const [d, arr] of Object.entries(byDir)) {
    console.log(`  ${d}: n=${arr.length} netAvgR=${fmt(mean(arr))} PF=${fmt(pf(arr))} WR=${fmt(wr(arr), 1)}%`);
  }
}

console.log("\n=== PART 5: Regime / Context ===");
const slices = ["marketRegime", "kronosBias", "whaleSignal", "horizonConflict"];
for (const lane of Object.keys(stats)) {
  console.log(`\nLane: ${lane}`);
  const list = stats[lane].resolvedList;
  for (const key of slices) {
    const buckets = {};
    for (const o of list) {
      const v = String(o.snapshot?.[key] ?? "null");
      buckets[v] ??= [];
      buckets[v].push(o.outcome.realizedNetR);
    }
    if (Object.keys(buckets).length <= 1) continue;
    console.log(`  ${key}:`);
    for (const [v, arr] of Object.entries(buckets)) {
      console.log(`    ${v}: n=${arr.length} netAvgR=${fmt(mean(arr))} PF=${fmt(pf(arr))}`);
    }
  }
}

console.log("\n=== PART 6: Admission Quality ===");
function distrib(list, key, nested = "snapshot") {
  const d = {};
  for (const o of list) {
    const v = String(o[nested]?.[key] ?? "null");
    d[v] = (d[v] ?? 0) + 1;
  }
  return d;
}
function distribOutcome(list, key) {
  const d = {};
  for (const o of list) {
    const v = String(o.outcome?.[key] ?? "null");
    d[v] = (d[v] ?? 0) + 1;
  }
  return d;
}
function stat3(arr) {
  const a = num(arr);
  if (!a.length) return "n/a";
  const s = [...a].sort((x, y) => x - y);
  return `min=${fmt(s[0])} med=${fmt(median(a))} max=${fmt(s[s.length - 1])}`;
}
for (const lane of Object.keys(stats)) {
  const list = stats[lane].resolvedList;
  console.log(`\nLane: ${lane}`);
  console.log(`  opportunityScore: ${stat3(list.map((o) => o.snapshot?.opportunityScore))}`);
  console.log(`  stopDistanceBps : ${stat3(list.map((o) => o.snapshot?.stopDistanceBps))}`);
  console.log(`  costR           : ${stat3(list.map((o) => o.snapshot?.costR))}`);
  console.log(`  durationMinutes : ${stat3(list.map((o) => o.outcome?.durationMinutes))}`);
  console.log(`  selectedEntryVariant: ${JSON.stringify(distrib(list, "selectedEntryVariant"))}`);
  console.log(`  selectedExitVariant : ${JSON.stringify(distrib(list, "selectedExitVariant"))}`);
  console.log(`  finalStatusObserved : ${JSON.stringify(distrib(list, "finalStatusObserved"))}`);
  console.log(`  closeReason         : ${JSON.stringify(distribOutcome(list, "closeReason"))}`);
  console.log(`  fillStatus          : ${JSON.stringify(distribOutcome(list, "fillStatus"))}`);
  console.log(`  winnerLabel         : ${JSON.stringify(distribOutcome(list, "winnerLabel"))}`);
}

console.log("\n=== PART 8: Control cohort presence ===");
if (fs.existsSync(SHADOW)) {
  try {
    const sd = JSON.parse(fs.readFileSync(SHADOW, "utf8"));
    const list = Array.isArray(sd) ? sd : sd.positions ?? sd.entries ?? sd.items ?? [];
    console.log(`shadow-positions.json found; entries=${list.length}`);
    const sample = list.slice(0, 1);
    console.log(`first-entry keys:`, sample[0] ? Object.keys(sample[0]).slice(0, 30) : "empty");
    // Try to extract closed Kronos-approved
    const closed = list.filter((p) => {
      const s = p.status ?? p.observationStatus ?? p.state;
      return s === "CLOSED" || s === "RESOLVED";
    });
    console.log(`closed count (heuristic): ${closed.length}`);
  } catch (e) {
    console.log("shadow-positions.json parse error:", e.message);
  }
} else {
  console.log("shadow-positions.json NOT FOUND");
}

console.log("\n=== PART 9: Time Stability ===");
for (const lane of Object.keys(stats)) {
  const list = [...stats[lane].resolvedList].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const n = list.length;
  const half = Math.floor(n / 2);
  const early = list.slice(0, half).map((o) => o.outcome.realizedNetR);
  const late = list.slice(half).map((o) => o.outcome.realizedNetR);
  const days = new Set(list.map((o) => new Date(o.createdAt).toISOString().slice(0, 10)));
  console.log(`\nLane: ${lane}`);
  console.log(`  early(n=${early.length}): netAvgR=${fmt(mean(early))} PF=${fmt(pf(early))} WR=${fmt(wr(early), 1)}%`);
  console.log(`  late (n=${late.length}): netAvgR=${fmt(mean(late))} PF=${fmt(pf(late))} WR=${fmt(wr(late), 1)}%`);
  console.log(`  distinct UTC days: ${days.size} -> ${[...days].sort().join(", ")}`);
}

console.log("\n=== PART 10: LSC semantics ===");
{
  const lane = "LIVE_SOURCE_CONFLICT_COUNTERFACTUAL";
  const list = stats[lane]?.resolvedList ?? [];
  let allHaveFlag = list.every((o) => o.snapshot?.liveSourceConflict === true);
  console.log(`all liveSourceConflict===true: ${allHaveFlag} (n=${list.length})`);
  const buckets = { KRONOS_LONG_WHALE_BEARISH: [], KRONOS_SHORT_WHALE_BULLISH: [], OTHER: [] };
  for (const o of list) {
    const kb = o.snapshot?.kronosBias;
    const ws = o.snapshot?.whaleSignal;
    let key = "OTHER";
    if (kb === "LONG" && ws === "BEARISH") key = "KRONOS_LONG_WHALE_BEARISH";
    else if (kb === "SHORT" && ws === "BULLISH") key = "KRONOS_SHORT_WHALE_BULLISH";
    buckets[key].push({ r: o.outcome.realizedNetR, kb, ws });
  }
  for (const [k, arr] of Object.entries(buckets)) {
    const r = arr.map((x) => x.r);
    console.log(`  ${k}: n=${arr.length} netAvgR=${fmt(mean(r))} PF=${fmt(pf(r))}`);
    if (k === "OTHER" && arr.length) {
      const types = {};
      for (const x of arr) {
        const t = `kb=${x.kb},ws=${x.ws}`;
        types[t] = (types[t] ?? 0) + 1;
      }
      console.log(`    OTHER breakdown:`, types);
    }
  }
}

console.log("\n=== PART 11: Kronos disagreement types ===");
{
  const lane = "KRONOS_DISAGREEMENT_COUNTERFACTUAL";
  const list = stats[lane]?.resolvedList ?? [];
  const buckets = { KRONOS_LONG_FINAL_SHORT: [], KRONOS_SHORT_FINAL_LONG: [], OTHER: [] };
  for (const o of list) {
    const kb = o.snapshot?.kronosBias;
    const d = o.snapshot?.direction;
    let key = "OTHER";
    if (kb === "LONG" && d === "SHORT") key = "KRONOS_LONG_FINAL_SHORT";
    else if (kb === "SHORT" && d === "LONG") key = "KRONOS_SHORT_FINAL_LONG";
    buckets[key].push({ r: o.outcome.realizedNetR, kb, d });
  }
  for (const [k, arr] of Object.entries(buckets)) {
    const r = arr.map((x) => x.r);
    console.log(`  ${k}: n=${arr.length} netAvgR=${fmt(mean(r))} PF=${fmt(pf(r))}`);
    if (k === "OTHER" && arr.length) {
      const types = {};
      for (const x of arr) {
        const t = `kb=${x.kb},d=${x.d}`;
        types[t] = (types[t] ?? 0) + 1;
      }
      console.log(`    OTHER breakdown:`, types);
    }
  }
}
