/**
 * CG_WIDE exit-geometry search. The wide-stop lane loses because it banks small
 * (TP at 1R) but eats full stops — at 1:1 payoff you need >50% WR and it gets
 * ~35%. The operator's thesis is "hold longer, win big," so this re-resolves the
 * SAME historical CG_WIDE orders (same entries/stops) under let-it-run exits and
 * measures the honest edge of each, to find a geometry that turns the lane
 * positive. Needs WARP (live candles). Read-only; mutates nothing.
 *
 * Honest rules: intrabar stop-first on same-candle ambiguity (conservative, no
 * 1m refinement), taker cost = 22bps / stopDistanceBps, and a hold cap after
 * which the position is marked-to-market at the last close.
 */
import { BinanceClient } from "../src/lib/binance.js";

interface OrderLike {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  plannedStopDistanceBps: number;
  selectedLaneId?: string | null;
  paperStatus: string;
  openedAt: string;
}

const CANDLE_MS = 5 * 60 * 1000;
const TAKER_BPS = 22;

interface Variant {
  key: string;
  /** full-exit reward multiple (null when using a trailing rule) */
  tpR?: number;
  /** trailing rule: arm after price moves armR in favor, then trail trailR behind the extreme, floor at breakeven */
  trail?: { armR: number; trailR: number; capR?: number };
  holdH: number; // max-hold hours before mark-to-market
}

const VARIANTS: Variant[] = [
  { key: "B_1R_full (baseline)", tpR: 1, holdH: 72 },
  { key: "F_1.5R_full", tpR: 1.5, holdH: 72 },
  { key: "F_2R_full", tpR: 2, holdH: 72 },
  { key: "F_3R_full", tpR: 3, holdH: 72 },
  { key: "F_5R_full", tpR: 5, holdH: 72 },
  { key: "F_3R_full_7d", tpR: 3, holdH: 168 },
  { key: "F_5R_full_7d", tpR: 5, holdH: 168 },
  { key: "TRAIL_arm1_trail1_be", trail: { armR: 1, trailR: 1 }, holdH: 72 },
  { key: "TRAIL_arm1_trail2_be", trail: { armR: 1, trailR: 2 }, holdH: 72 },
  { key: "TRAIL_arm2_trail2_be", trail: { armR: 2, trailR: 2 }, holdH: 72 },
  { key: "TRAIL_arm1_trail1_be_7d", trail: { armR: 1, trailR: 1 }, holdH: 168 },
];

type Tuple = [number, string, string, string, string, string, number];

function simulate(
  o: OrderLike,
  candles: Tuple[],
  v: Variant,
  openedAtMs: number,
): { netR: number; exit: "TP" | "SL" | "TRAIL" | "MTM" } | null {
  const dir = o.direction;
  const E = o.entryPrice;
  const S = o.stopLoss;
  const risk = Math.abs(E - S);
  if (!(risk > 0)) return null;
  const sign = dir === "SHORT" ? -1 : 1; // favorable price direction
  const costR = -(TAKER_BPS / o.plannedStopDistanceBps);
  const holdMs = v.holdH * 3600 * 1000;

  const reward = (px: number): number => (dir === "LONG" ? (px - E) / risk : (E - px) / risk);

  // trailing state
  let armed = false;
  let extreme = E; // most-favorable price seen
  let lastClose = E;

  for (const c of candles) {
    const openMs = c[0];
    if (openMs < openedAtMs - CANDLE_MS) continue;
    if (openMs - openedAtMs > holdMs) break; // past hold cap → MTM below
    const high = Number(c[2]);
    const low = Number(c[3]);
    const close = Number(c[4]);
    if (Number.isFinite(close)) lastClose = close;

    const slHit = dir === "LONG" ? low <= S : high >= S;

    if (v.tpR != null) {
      // ── full-exit at fixed reward multiple ──
      const target = E + sign * v.tpR * risk;
      const tpHit = dir === "LONG" ? high >= target : low <= target;
      if (slHit && tpHit) return { netR: -1 + costR, exit: "SL" }; // same-candle → stop-first
      if (slHit) return { netR: -1 + costR, exit: "SL" };
      if (tpHit) return { netR: v.tpR + costR, exit: "TP" };
    } else if (v.trail) {
      // ── arm-then-trail (ride winners) ──
      extreme = dir === "SHORT" ? Math.min(extreme, low) : Math.max(extreme, high);
      const favorR = reward(extreme);
      if (!armed && favorR >= v.trail.armR) armed = true;
      if (!armed) {
        // before arming, original stop protects
        if (slHit) return { netR: -1 + costR, exit: "SL" };
      } else {
        // trailing stop sits trailR behind the favorable extreme, floored at breakeven (E)
        let trailStop = extreme - sign * v.trail.trailR * risk;
        trailStop = dir === "SHORT" ? Math.min(E, trailStop) : Math.max(E, trailStop); // never worse than BE
        const trailHit = dir === "LONG" ? low <= trailStop : high >= trailStop;
        const capHit = v.trail.capR != null && (dir === "LONG" ? high >= E + sign * v.trail.capR * risk : low <= E + sign * v.trail.capR * risk);
        if (capHit) return { netR: v.trail.capR! + costR, exit: "TP" };
        if (trailHit) return { netR: reward(trailStop) + costR, exit: "TRAIL" };
      }
    }
  }
  // hold cap reached → mark to market at last close
  return { netR: reward(lastClose) + costR, exit: "MTM" };
}

function agg(rs: number[]): { n: number; wr: number; sumR: number; avgR: number; expectancy: number } {
  const n = rs.length;
  if (n === 0) return { n: 0, wr: 0, sumR: 0, avgR: 0, expectancy: 0 };
  const wins = rs.filter((r) => r > 0);
  const sumR = rs.reduce((a, b) => a + b, 0);
  return { n, wr: (100 * wins.length) / n, sumR, avgR: sumR / n, expectancy: sumR / n };
}

async function main(): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const backup = path.join(import.meta.dirname, "../data/paper-execution-router.2026-06-11.bak");
  const all = JSON.parse(fs.readFileSync(backup, "utf-8")).orders as OrderLike[];
  const orders = all.filter((o) => (o.selectedLaneId ?? "").includes("CG_WIDE_STOP_TP_WIDE"));
  console.log(`CG_WIDE orders: ${orders.length} (SHORT ${orders.filter((o) => o.direction === "SHORT").length}, LONG ${orders.filter((o) => o.direction === "LONG").length})`);

  const binance = new BinanceClient();
  const nowMs = Date.parse("2026-06-14T01:10:00Z");

  // results[variantKey][direction] = number[]
  const results: Record<string, { LONG: number[]; SHORT: number[] }> = {};
  for (const v of VARIANTS) results[v.key] = { LONG: [], SHORT: [] };
  const exitMix: Record<string, Record<string, number>> = {};

  let done = 0;
  for (const o of orders) {
    const openedAtMs = Date.parse(o.openedAt);
    if (!Number.isFinite(openedAtMs)) continue;
    const startTime = openedAtMs - CANDLE_MS;
    const endTime = Math.min(nowMs, openedAtMs + 8 * 24 * 60 * 60 * 1000);
    let candles: Tuple[];
    try {
      const symbol = (o as unknown as { symbol: string }).symbol;
      const raw = await binance.getCandles(symbol, "5m", Math.min(Math.max(Math.ceil((endTime - startTime) / CANDLE_MS) + 2, 12), 1000), { startTime, endTime });
      candles = raw.map((c) => [c.openTime, "0", String(c.high), String(c.low), String(c.close), "0", c.openTime + CANDLE_MS] as Tuple);
    } catch {
      continue;
    }
    for (const v of VARIANTS) {
      const r = simulate(o, candles, v, openedAtMs);
      if (!r) continue;
      results[v.key]![o.direction].push(r.netR);
      exitMix[v.key] ??= {};
      exitMix[v.key]![r.exit] = (exitMix[v.key]![r.exit] ?? 0) + 1;
    }
    done += 1;
    if (done % 300 === 0) console.error(`  …${done}/${orders.length}`);
  }

  const fmt = (a: ReturnType<typeof agg>) =>
    `n=${String(a.n).padStart(4)} WR=${a.wr.toFixed(1).padStart(5)}% sumR=${a.sumR.toFixed(1).padStart(8)} avgR=${a.avgR.toFixed(3).padStart(7)}`;

  console.log("\n===== CG_WIDE EXIT SEARCH (honest, ideal fills) =====");
  console.log(`${"variant".padEnd(26)} | ${"SHORT".padEnd(46)} | ${"LONG".padEnd(46)} | ALL avgR`);
  for (const v of VARIANTS) {
    const s = agg(results[v.key]!.SHORT);
    const l = agg(results[v.key]!.LONG);
    const all2 = agg([...results[v.key]!.SHORT, ...results[v.key]!.LONG]);
    const flag = all2.avgR > 0.02 ? " ✅" : all2.avgR < -0.02 ? " ❌" : " ·";
    console.log(`${v.key.padEnd(26)} | ${fmt(s)} | ${fmt(l)} | ${all2.avgR.toFixed(3)}${flag}`);
  }
  console.log("\n----- exit mix per variant (SHORT+LONG) -----");
  for (const v of VARIANTS) console.log(`  ${v.key.padEnd(26)} ${JSON.stringify(exitMix[v.key] ?? {})}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
