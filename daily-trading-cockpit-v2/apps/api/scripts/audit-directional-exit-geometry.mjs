/**
 * Which exit geometry should the CROSS_SECTIONAL_DIRECTIONAL lanes use?
 *
 * Run:  node apps/api/scripts/audit-directional-exit-geometry.mjs
 * Reads public Binance USD-M klines only. No store, no key, no side effect.
 *
 * WHAT THIS DOES NOT DO — read this before quoting any number below.
 *
 * It does NOT simulate the lanes. Their entry rule needs `kronosBias`, `finalStatus`,
 * `dataQualityScore` and the scanner's own `stopLoss` (see cross-sectional-directional-regime.ts's
 * `eligible`/`validStop`), none of which exists in candle data. Nothing here can tell you whether
 * those lanes have edge, and for the same reason it says NOTHING about whether the regime overlay
 * should keep closing their positions — that decision depends on `canonical.regimeFamily` plus
 * scanner transition state, which is not reconstructible from price history either. That question
 * still needs live episodes.
 *
 * What it DOES measure is the part that lives entirely in the price path: given an entry with a
 * stop at distance d, which exit geometry does the real distribution of 1h paths reward. Entries
 * are deliberately NEUTRAL — every Nth bar, both directions — so the result is a property of the
 * geometry and not of any signal. Stop widths are swept as a grid so no conclusion depends on a
 * guessed stop model, and because the sweep is exactly where the defect below shows itself.
 *
 * THE DEFECT IT WAS BUILT FOR (measured 2026-08-16 over 14 real directional closes):
 * `profitLockNetReturn` is a fraction of PRICE while `armR` and the stop are in R. Real stop widths
 * ranged 0.47%-2.18% of entry, so one config meant a lock at 1.15R on ETH and 0.25R on SOL.
 *
 * RESULT as of 2026-08-16 — 20 symbols, 6,000 1h bars (~250 days), 39,600 entries per cell, cost
 * 8.0 bps measured (4.00 in + 4.00 out, feeSource EXCHANGE). Paired: identical entries, only the
 * geometry differs, blocked by full calendar week.
 *
 *     vs arm 0.20 + lock 0.5% price          delta      blk t   weeks better
 *     arm 0.75 + lock 0.5R                 +0.0699R      4.57       26/36
 *     arm 0.75, NO lock at all             -0.0002R     -0.14       17/36
 *     arm 0.40 + lock 0.3R                 +0.0660R      4.83       29/36
 *
 * Raising `armR` ALONE does nothing. The whole gain comes from denominating the lock in R; the arm
 * level is second-order (0.40 and 0.75 are indistinguishable). The lock's job is catching peaks
 * between itself and the arm that would otherwise run to the stop — STOP share falls 52% -> 46%
 * when it is present. Absolute, full weeks only: the old geometry is -0.0553R at t=-8.60 (provably
 * negative on NEUTRAL entries), the new one +0.0147R at t=1.09 (indistinguishable from zero). So
 * this change removes a proven bleed; it does not create an edge. The old geometry taxed the lane
 * 0.055R per position on top of cost, which any entry signal had to overcome before earning
 * anything.
 *
 * Mechanism, from the same data: 34.3% of entries reach 0.20R before -1R and 32.1% still reach
 * 0.75R — arming three times higher costs 2.2 points of hit rate and roughly triples the payoff.
 *
 * CAVEATS: entries within a week overlap and are not independent; the 36 weekly means are the
 * honest unit, not the 39,600 rows. The reach table uses wicks while the replay uses closes.
 */
import { setTimeout as delay } from "node:timers/promises";

const POOL = "SOLUSDT,DOGEUSDT,AVAXUSDT,SUIUSDT,1000PEPEUSDT,ARBUSDT,OPUSDT,INJUSDT,WLDUSDT,APTUSDT,NEARUSDT,BNBUSDT,XRPUSDT,ADAUSDT,FETUSDT,WIFUSDT,TAOUSDT,UNIUSDT,AAVEUSDT,LDOUSDT".split(",");
const COST_BPS = 8.0;
const MAX_HOLD_BARS = 24;          // CROSS_SECTIONAL_DIRECTIONAL_MAX_HOLD_HOURS
const ENTRY_EVERY = 6;             // spacing between entries, to limit overlap
const STOP_PCTS = [0.5, 1.0, 1.5, 2.0, 2.5];
const NEAR_REAL_STOP = 1.5;        // closest grid point to the measured 1.46% mean
const MIN_ENTRIES_FOR_FULL_WEEK = 200;

const GEOMS = [
  { name: "OLD   arm 0.20 lock 0.5% price", armR: 0.20, giveback: 0.3, lockPct: 0.5, lockR: 0 },
  { name: "NEW   arm 0.75 lock 0.5R", armR: 0.75, giveback: 0.3, lockPct: 0, lockR: 0.5 },
  { name: "arm 0.75, no lock at all", armR: 0.75, giveback: 0.3, lockPct: 0, lockR: 0 },
  { name: "arm 0.40 lock 0.3R", armR: 0.40, giveback: 0.3, lockPct: 0, lockR: 0.3 },
];

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
const weekOf = (ms) => Math.floor(ms / (7 * 86400e3));

/** One replay. Mirrors makeMfeGivebackExitPolicy, including that the R lock arms on the PEAK and
 *  fires only on a retrace back THROUGH it — not as a take-profit on the way up. */
function replay(bars, i, dir, stopPct, geom) {
  const entry = bars[i].c;
  const isShort = dir === "SHORT";
  const risk = (entry * stopPct) / 100;
  const stop = isShort ? entry + risk : entry - risk;
  const costR = ((COST_BPS / 10000) * entry) / risk;
  const rOf = (px) => (isShort ? entry - px : px - entry) / risk;
  const retOf = (px) => (isShort ? entry - px : px - entry) / entry;

  let peak = 0;
  for (let j = i + 1; j < Math.min(bars.length, i + 1 + MAX_HOLD_BARS); j++) {
    const b = bars[j];
    // stop first, filled on the wick — pessimistic, same as the production counterfactual
    if ((isShort && b.h >= stop) || (!isShort && b.l <= stop)) return { r: -1 - costR, why: "STOP" };
    const r = rOf(b.c);
    const pk = Math.max(peak, r);
    if (geom.lockR > 0) {
      if (pk >= geom.lockR && r <= geom.lockR) return { r: geom.lockR - costR, why: "LOCK" };
    } else if (geom.lockPct > 0) {
      // lockPct 0 means NO lock. Treating it as "lock at 0%" exits every position at breakeven and
      // silently reports a geometry nobody proposed — it did, in the first run of this script.
      if (retOf(b.c) >= geom.lockPct / 100) return { r: r - costR, why: "LOCK" };
    }
    if (pk >= geom.armR && r <= pk * (1 - geom.giveback)) return { r: r - costR, why: "GIVEBACK" };
    peak = pk;
  }
  const last = bars[Math.min(bars.length - 1, i + MAX_HOLD_BARS)];
  return { r: rOf(last.c) - costR, why: "MAX_HOLD" };
}

/** Every (symbol, entry bar, direction) this audit considers, in one place, so each section below
 *  provably walks the SAME entries — a paired test that quietly paired different sets would be
 *  worse than no test. */
function* entries(candles, syms) {
  for (const s of syms) {
    const bars = candles[s];
    for (let i = 40; i < bars.length - MAX_HOLD_BARS - 1; i += ENTRY_EVERY) {
      for (const dir of ["LONG", "SHORT"]) yield { bars, i, dir };
    }
  }
}

async function klines(symbol, pages = 4) {
  let all = [];
  let end = Date.now();
  for (let p = 0; p < pages; p++) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=1500&endTime=${end}`;
    let k;
    try {
      const response = await fetch(url);
      if (!response.ok) break;
      k = await response.json();
    } catch {
      break;
    }
    if (!Array.isArray(k) || k.length === 0) break;
    all = [...k, ...all];
    end = k[0][0] - 1;
    if (k.length < 1500) break;
    await delay(40);
  }
  const seen = new Set();
  const out = [];
  for (const r of all) {
    if (seen.has(r[0])) continue;
    seen.add(r[0]);
    out.push({ t: r[0], h: +r[2], l: +r[3], c: +r[4] });
  }
  return out.sort((a, b) => a.t - b.t);
}

const candles = {};
for (const s of POOL) {
  const d = await klines(s);
  if (d.length > 500) candles[s] = d;
}
const syms = Object.keys(candles);
if (syms.length === 0) {
  console.error("no candles fetched — Binance is geo-blocked from Indonesia; run this on the VPS");
  process.exit(1);
}
const bars = Math.min(...syms.map((s) => candles[s].length));
console.log(`${syms.length} symbols | ${bars} 1h bars (~${(bars / 24).toFixed(0)} days) | cost ${COST_BPS} bps | max hold ${MAX_HOLD_BARS}h\n`);

console.log("A. BY STOP WIDTH  (mean netR per position)");
console.log("-".repeat(96));
console.log("geometry".padEnd(34) + STOP_PCTS.map((p) => `${p}%`.padStart(11)).join("") + "   n/cell");
console.log("-".repeat(96));
for (const g of GEOMS) {
  let line = g.name.padEnd(34);
  let n = 0;
  for (const sp of STOP_PCTS) {
    const rs = [];
    for (const e of entries(candles, syms)) rs.push(replay(e.bars, e.i, e.dir, sp, g).r);
    n = rs.length;
    line += mean(rs).toFixed(4).padStart(11);
  }
  console.log(line + String(n).padStart(10));
}

console.log(`\nB. PAIRED — IDENTICAL entries, geometry the only difference (stop ${NEAR_REAL_STOP}%)`);
console.log("-".repeat(96));
const base = GEOMS[0];
for (const g of GEOMS.slice(1)) {
  const deltas = [];
  const byWeek = {};
  for (const e of entries(candles, syms)) {
    const d = replay(e.bars, e.i, e.dir, NEAR_REAL_STOP, g).r - replay(e.bars, e.i, e.dir, NEAR_REAL_STOP, base).r;
    deltas.push(d);
    (byWeek[weekOf(e.bars[e.i].t)] ??= []).push(d);
  }
  // full weeks only: a partial week holds few entries and would carry a full week's weight
  const wm = Object.values(byWeek).filter((v) => v.length >= MIN_ENTRIES_FOR_FULL_WEEK).map(mean);
  const t = mean(wm) / (sd(wm) / Math.sqrt(wm.length));
  console.log(
    `  ${g.name.padEnd(32)} delta ${mean(deltas).toFixed(4).padStart(8)}R | full weeks ${String(wm.length).padStart(2)}` +
      ` | blk t ${t.toFixed(2).padStart(6)} | weeks better ${wm.filter((x) => x > 0).length}/${wm.length}`,
  );
}
console.log(`\n  (baseline: ${base.name})`);

console.log(`\nB2. ABSOLUTE level per geometry, full weeks only (stop ${NEAR_REAL_STOP}%)`);
console.log("-".repeat(96));
console.log("geometry".padEnd(34) + "netR".padStart(9) + "win%".padStart(8) + "wks".padStart(6) + "blk t".padStart(8) + "  exit mix");
console.log("-".repeat(96));
for (const g of GEOMS) {
  const rs = [];
  const byWeek = {};
  const mix = {};
  for (const e of entries(candles, syms)) {
    const o = replay(e.bars, e.i, e.dir, NEAR_REAL_STOP, g);
    rs.push(o.r);
    mix[o.why] = (mix[o.why] ?? 0) + 1;
    (byWeek[weekOf(e.bars[e.i].t)] ??= []).push(o.r);
  }
  const wm = Object.values(byWeek).filter((v) => v.length >= MIN_ENTRIES_FOR_FULL_WEEK).map(mean);
  const t = mean(wm) / (sd(wm) / Math.sqrt(wm.length));
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  const mixStr = Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${((100 * v) / total).toFixed(0)}%`).join(" · ");
  console.log(
    g.name.padEnd(34) + mean(rs).toFixed(4).padStart(9) +
      ((100 * rs.filter((x) => x > 0).length) / rs.length).toFixed(1).padStart(8) +
      String(wm.length).padStart(6) + t.toFixed(2).padStart(8) + "  " + mixStr,
  );
}

console.log(`\nC. HOW OFTEN PRICE TRAVELS X R BEFORE -1R  (stop ${NEAR_REAL_STOP}%)`);
console.log("-".repeat(60));
const levels = [0.2, 0.5, 0.75, 1.0, 1.5, 2.0];
const reached = new Map(levels.map((l) => [l, 0]));
let total = 0;
for (const e of entries(candles, syms)) {
  const entry = e.bars[e.i].c;
  const isShort = e.dir === "SHORT";
  const risk = (entry * NEAR_REAL_STOP) / 100;
  const stop = isShort ? entry + risk : entry - risk;
  let pk = 0;
  let stopped = false;
  for (let j = e.i + 1; j < Math.min(e.bars.length, e.i + 1 + MAX_HOLD_BARS); j++) {
    const b = e.bars[j];
    if ((isShort && b.h >= stop) || (!isShort && b.l <= stop)) { stopped = true; break; }
    pk = Math.max(pk, (isShort ? entry - b.l : b.h - entry) / risk);
  }
  total++;
  if (!stopped) for (const l of levels) if (pk >= l) reached.set(l, reached.get(l) + 1);
}
for (const l of levels) console.log(`  reaches ${l.toFixed(2)}R before the stop : ${((100 * reached.get(l)) / total).toFixed(1)}%`);
console.log(`  (n=${total}; the rest hit the stop first or never got there)`);
