/**
 * Comprehensive LANE-level edge seed (regime × direction × lane) + direction
 * seed, with realistic slippage. Each historical order is re-simulated under:
 *   - its OWN stored geometry → its actual lane's honest edge (BASELINE, CG_WIDE…)
 *   - if a CG_WIDE LONG → the CG_WIDE_LONG_RUNNER geometry (wide stop, 3R, 144h)
 *   - if a CG_WIDE SHORT → the CG_WIDE_FAST_SHORT geometry (wide stop, 0.5R)
 * so the lane gate knows which lanes are proven-positive. Writes both seedStats
 * (direction) and laneSeedStats (lane). Needs WARP.
 */
import { BinanceClient } from "../src/lib/binance.js";
import {
  RegimeEdgeMemoryStore,
  normalizeRegimeFamily,
  laneOf,
  edgeVerdict,
  type EdgeSeedRow,
} from "../src/lib/regime-edge-memory.js";

interface OrderLike {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
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
type Tuple = [number, string, string, string, string, string, number];

// tp1_full intrabar sim with slippage + max-hold MTM. target is an absolute price.
function sim(dir: "LONG" | "SHORT", E: number, S: number, target: number, stopBps: number, candles: Tuple[], openedAtMs: number, holdMs: number): number | null {
  const risk = Math.abs(E - S);
  if (!(risk > 0)) return null;
  const costR = -(TAKER_BPS / stopBps);
  const Efill = dir === "LONG" ? E * (1 + ENTRY_SLIP) : E * (1 - ENTRY_SLIP);
  const reward = (px: number) => (dir === "LONG" ? (px - Efill) / risk : (Efill - px) / risk);
  let lastClose = E;
  for (const c of candles) {
    const openMs = c[0];
    if (openMs < openedAtMs - CANDLE_MS) continue;
    if (openMs - openedAtMs > holdMs) break;
    const high = Number(c[2]);
    const low = Number(c[3]);
    const close = Number(c[4]);
    if (Number.isFinite(close)) lastClose = close;
    const slHit = dir === "LONG" ? low <= S : high >= S;
    const tpHit = dir === "LONG" ? high >= target : low <= target;
    if (slHit) return reward(dir === "LONG" ? S * (1 - STOP_SLIP) : S * (1 + STOP_SLIP)) + costR; // stop-first
    if (tpHit) return reward(target) + costR;
  }
  return reward(dir === "LONG" ? lastClose * (1 - STOP_SLIP) : lastClose * (1 + STOP_SLIP)) + costR;
}

async function main(): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dataDir = path.join(import.meta.dirname, "../data");
  const all = JSON.parse(fs.readFileSync(path.join(dataDir, "paper-execution-router.2026-06-11.bak"), "utf-8")).orders as OrderLike[];
  const orders = all.filter((o) => (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS" || o.paperStatus === "PAPER_SUBMITTED") && (o.direction === "LONG" || o.direction === "SHORT"));
  console.log(`orders: ${orders.length}`);

  const binance = new BinanceClient();
  const nowMs = Date.parse("2026-06-14T03:00:00Z");
  const dirRows = new Map<string, EdgeSeedRow>();
  const laneRows = new Map<string, EdgeSeedRow>();
  const add = (m: Map<string, EdgeSeedRow>, regime: string, dir: "LONG" | "SHORT", lane: string | undefined, netR: number) => {
    const k = lane ? `${regime}::${dir}::${lane}` : `${regime}::${dir}`;
    const r = m.get(k) ?? { regime, direction: dir, lane, n: 0, wins: 0, sumNetR: 0 };
    r.n += 1; r.wins += netR > 0 ? 1 : 0; r.sumNetR += netR; m.set(k, r);
  };

  let done = 0;
  for (const o of orders) {
    const openedAtMs = Date.parse(o.openedAt);
    if (!Number.isFinite(openedAtMs)) continue;
    let candles: Tuple[];
    try {
      const startTime = openedAtMs - CANDLE_MS;
      const endTime = Math.min(nowMs, openedAtMs + 8 * 24 * 60 * 60 * 1000);
      const raw = await binance.getCandles(o.symbol, "5m", Math.min(Math.max(Math.ceil((endTime - startTime) / CANDLE_MS) + 2, 12), 1000), { startTime, endTime });
      candles = raw.map((c) => [c.openTime, "0", String(c.high), String(c.low), String(c.close), "0", c.openTime + CANDLE_MS] as Tuple);
    } catch { continue; }
    const regime = normalizeRegimeFamily(o.regime);
    const dir = o.direction;
    const lane = laneOf(o.selectedLaneId);
    const E = o.entryPrice, S = o.stopLoss, T = o.takeProfitLevels?.[0];
    // 1) actual lane under its stored geometry (72h hold)
    if (typeof T === "number" && Number.isFinite(T)) {
      const r = sim(dir, E, S, T, o.plannedStopDistanceBps, candles, openedAtMs, 72 * 3600e3);
      if (r != null) { add(laneRows, regime, dir, lane, r); add(dirRows, regime, dir, undefined, r); }
    }
    // 2) CG_WIDE LONG → RUNNER (wide stop kept, TP 3R, 144h)
    if (dir === "LONG" && lane === "CG_WIDE_STOP_TP_WIDE") {
      const risk = E - S;
      const r = sim("LONG", E, S, E + 3 * risk, o.plannedStopDistanceBps, candles, openedAtMs, 144 * 3600e3);
      if (r != null) add(laneRows, regime, "LONG", "CG_WIDE_LONG_RUNNER", r);
    }
    // 3) CG_WIDE SHORT → FAST (wide stop kept, TP 0.5R, 72h)
    if (dir === "SHORT" && lane === "CG_WIDE_STOP_TP_WIDE") {
      const risk = S - E;
      const r = sim("SHORT", E, S, E - 0.5 * risk, o.plannedStopDistanceBps, candles, openedAtMs, 72 * 3600e3);
      if (r != null) add(laneRows, regime, "SHORT", "CG_WIDE_FAST_SHORT", r);
    }
    if (++done % 400 === 0) console.error(`  …${done}/${orders.length}`);
  }

  const rows = [...dirRows.values(), ...laneRows.values()];
  const store = new RegimeEdgeMemoryStore(dataDir);
  store.seed(rows, "lane-seed:stored+RUNNER+FAST(slip)");
  store.save();

  console.log("\n===== LANE seed (proven slices, n>=30) =====");
  for (const r of [...laneRows.values()].filter((r) => r.n >= 30).sort((a, b) => b.sumNetR / b.n - a.sumNetR / a.n)) {
    const v = edgeVerdict({ n: r.n, wins: r.wins, sumNetR: r.sumNetR, avgNetR: r.sumNetR / r.n, winRate: 0 });
    console.log(`  ${`${r.regime} × ${r.direction} × ${r.lane}`.padEnd(50)} n=${String(r.n).padStart(4)} avgR=${(r.sumNetR / r.n).toFixed(3).padStart(7)} → ${v.allowed ? "ALLOW" : "VETO"}`);
  }
  console.log("\n===== hasPositiveLane / direction verdict per regime =====");
  for (const reg of ["Bullish expansion", "Bearish pressure", "Mixed rotation"]) {
    for (const d of ["LONG", "SHORT"] as const) {
      const dv = store.verdict(reg, d);
      const hp = store.hasPositiveLane(reg, d);
      console.log(`  ${reg.padEnd(20)} ${d} dirAvgR=${dv.stat.avgNetR.toFixed(3).padStart(7)} dirAllowed=${dv.allowed} hasPositiveLane=${hp}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
