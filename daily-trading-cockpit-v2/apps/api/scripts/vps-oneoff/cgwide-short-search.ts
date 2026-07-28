/**
 * SHORT exit-geometry search. The operator asked to turn CG_WIDE's losing SHORT
 * side into a "runner" (far-TP) like the winning long lane. The long search said
 * far-TP loses on shorts; this tests the full spectrum — tight TP, TIGHT stop,
 * scaleout, and runner — on the historical CG_WIDE SHORT orders, by regime, with
 * realistic slippage, to find what (if anything) makes shorts positive. Needs WARP.
 */
import { BinanceClient } from "../src/lib/binance.js";

interface OrderLike {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  plannedStopDistanceBps: number;
  selectedLaneId?: string | null;
  paperStatus: string;
  regime?: string | null;
  openedAt: string;
  symbol: string;
}

const CANDLE_MS = 5 * 60 * 1000;
const TAKER_BPS = 22;
const ENTRY_SLIP = 2 / 10000;
const STOP_SLIP = 5 / 10000;
const HOLD_MS = 72 * 3600 * 1000;

type Tuple = [number, string, string, string, string, string, number];

interface V {
  key: string;
  stopBps: number | null; // null = keep order's original stop; else re-floor to this
  tpR?: number; // full-exit reward multiple
  scaleAt?: number; // scaleout: lock 50% at this R, trail rest to BE
}
const VARIANTS: V[] = [
  { key: "orig_stop_1R   (current)", stopBps: null, tpR: 1 },
  { key: "orig_stop_0.75R", stopBps: null, tpR: 0.75 },
  { key: "orig_stop_0.5R ", stopBps: null, tpR: 0.5 },
  { key: "stop150_1R     ", stopBps: 150, tpR: 1 },
  { key: "stop150_0.75R  ", stopBps: 150, tpR: 0.75 },
  { key: "stop100_1R     ", stopBps: 100, tpR: 1 },
  { key: "stop100_0.75R  ", stopBps: 100, tpR: 0.75 },
  { key: "scaleout0.5_BE ", stopBps: null, scaleAt: 0.5 },
  { key: "RUNNER_2R      ", stopBps: null, tpR: 2 },
  { key: "RUNNER_3R      ", stopBps: null, tpR: 3 },
];

// SHORT sim with slippage. Returns netR.
function sim(o: OrderLike, candles: Tuple[], v: V, openedAtMs: number): number | null {
  const E = o.entryPrice;
  // stop: original or re-floored tighter
  const S = v.stopBps == null ? o.stopLoss : E * (1 + v.stopBps / 10000);
  const risk = S - E; // short: stop above entry
  if (!(risk > 0)) return null;
  const stopBps = v.stopBps ?? o.plannedStopDistanceBps;
  const costR = -(TAKER_BPS / stopBps);
  const Efill = E * (1 - ENTRY_SLIP); // short fill slightly low (worse)
  const rewardAt = (px: number) => (Efill - px) / risk; // short reward
  let banked = 0;
  let phase: 1 | 2 = 1;
  let lastClose = E;
  for (const c of candles) {
    const openMs = c[0];
    if (openMs < openedAtMs - CANDLE_MS) continue;
    if (openMs - openedAtMs > HOLD_MS) break;
    const high = Number(c[2]);
    const low = Number(c[3]);
    const close = Number(c[4]);
    if (Number.isFinite(close)) lastClose = close;
    const slHit = high >= S;
    if (v.scaleAt != null) {
      const tight = E - v.scaleAt * risk; // first target
      if (phase === 1) {
        if (slHit && low <= tight) return -1 + costR; // stop-first ambiguity
        if (slHit) return -1 + costR;
        if (low <= tight) { banked = 0.5 * v.scaleAt; phase = 2; continue; }
      } else {
        // runner: stop at BE (E), exit if back to E
        if (high >= E) return banked + 0.5 * rewardAt(E) + costR;
        // ride; no upper target
      }
      continue;
    }
    const target = E - (v.tpR ?? 1) * risk;
    const tpHit = low <= target;
    if (slHit && tpHit) return -1 + costR; // stop-first
    if (slHit) return -1 + costR;
    if (tpHit) return (v.tpR ?? 1) + costR;
  }
  // hold cap → MTM
  const mtm = (Efill - lastClose * (1 + STOP_SLIP)) / risk + costR;
  if (v.scaleAt != null && phase === 2) return banked + 0.5 * mtm;
  return mtm;
}

function agg(rs: number[]) {
  const n = rs.length;
  if (!n) return { n: 0, wr: 0, avg: 0 };
  return { n, wr: (100 * rs.filter((r) => r > 0).length) / n, avg: rs.reduce((a, b) => a + b, 0) / n };
}

function norm(r: string | null | undefined): string {
  const s = (r ?? "").toLowerCase();
  if (s.includes("bearish")) return "BEARISH";
  if (s.includes("bullish")) return "BULLISH";
  if (s.includes("mixed") || s.includes("rotation")) return "MIXED";
  return "OTHER";
}

async function main(): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const backup = path.join(import.meta.dirname, "../data/paper-execution-router.2026-06-11.bak");
  const all = JSON.parse(fs.readFileSync(backup, "utf-8")).orders as OrderLike[];
  const shorts = all.filter(
    (o) => o.direction === "SHORT" && (o.selectedLaneId ?? "").includes("CG_WIDE") &&
      (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS" || o.paperStatus === "PAPER_SUBMITTED"),
  );
  console.log(`CG_WIDE SHORT orders: ${shorts.length}`);
  const binance = new BinanceClient();
  const nowMs = Date.parse("2026-06-14T02:00:00Z");
  const res: Record<string, { all: number[]; BEARISH: number[]; MIXED: number[]; BULLISH: number[] }> = {};
  for (const v of VARIANTS) res[v.key] = { all: [], BEARISH: [], MIXED: [], BULLISH: [] };
  let done = 0;
  for (const o of shorts) {
    const openedAtMs = Date.parse(o.openedAt);
    if (!Number.isFinite(openedAtMs)) continue;
    let candles: Tuple[];
    try {
      const startTime = openedAtMs - CANDLE_MS;
      const endTime = Math.min(nowMs, openedAtMs + 5 * 24 * 60 * 60 * 1000);
      const raw = await binance.getCandles(o.symbol, "5m", Math.min(Math.max(Math.ceil((endTime - startTime) / CANDLE_MS) + 2, 12), 1000), { startTime, endTime });
      candles = raw.map((c) => [c.openTime, "0", String(c.high), String(c.low), String(c.close), "0", c.openTime + CANDLE_MS] as Tuple);
    } catch { continue; }
    const reg = norm(o.regime);
    for (const v of VARIANTS) {
      const r = sim(o, candles, v, openedAtMs);
      if (r == null) continue;
      res[v.key]!.all.push(r);
      (res[v.key] as Record<string, number[]>)[reg]?.push(r);
    }
    if (++done % 300 === 0) console.error(`  …${done}/${shorts.length}`);
  }
  const f = (a: ReturnType<typeof agg>) => `n=${String(a.n).padStart(4)} WR=${a.wr.toFixed(1).padStart(5)}% avgR=${a.avg.toFixed(3).padStart(7)}`;
  console.log("\n===== CG_WIDE SHORT geometry search (slippage) =====");
  console.log(`${"variant".padEnd(24)} | ${"ALL".padEnd(30)} | ${"BEARISH".padEnd(30)}`);
  for (const v of VARIANTS) {
    const a = agg(res[v.key]!.all), b = agg(res[v.key]!.BEARISH);
    const flag = a.avg > 0.02 ? " ✅" : a.avg < -0.02 ? " ❌" : " ·";
    console.log(`${v.key.padEnd(24)} | ${f(a)} | ${f(b)}${flag}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
