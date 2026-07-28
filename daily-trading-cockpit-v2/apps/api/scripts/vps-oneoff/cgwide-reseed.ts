/**
 * Re-seed the regime edge gate's LONG slices to reflect the IMPROVED CG_WIDE
 * geometry (CG_WIDE_LONG_RUNNER: wide stop, far 3R TP, ~6-day hold), WITH
 * realistic slippage. The original seed measured longs under the old 1R payoff
 * (≈breakeven-negative → vetoed). Going forward longs route to the new lane, so
 * the prior must reflect that lane. SHORT slices are kept as-is (negative under
 * every geometry → stay vetoed). Needs WARP. Run after the geometry change.
 */
import { BinanceClient } from "../src/lib/binance.js";
import {
  RegimeEdgeMemoryStore,
  normalizeRegimeFamily,
  edgeVerdict,
  type EdgeSeedRow,
  type EdgeStat,
} from "../src/lib/regime-edge-memory.js";

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
const TP_R = 3;
const HOLD_MS = 144 * 3600 * 1000;
// realistic fills (PAPER_EXECUTION_MODEL_REALISTIC): entry 2bps worse, stop 5bps worse
const ENTRY_SLIP = 2 / 10000;
const STOP_SLIP = 5 / 10000;

type Tuple = [number, string, string, string, string, string, number];

// LONG-only let-it-run simulation with slippage. Returns netR.
function simLongRunner(o: OrderLike, candles: Tuple[], openedAtMs: number): number | null {
  const E = o.entryPrice;
  const S = o.stopLoss;
  const risk = Math.abs(E - S);
  if (!(risk > 0)) return null;
  const Efill = E * (1 + ENTRY_SLIP); // enter slightly high (worse for long)
  const target = E + TP_R * risk;
  const costR = -(TAKER_BPS / o.plannedStopDistanceBps);
  let lastClose = E;
  for (const c of candles) {
    const openMs = c[0];
    if (openMs < openedAtMs - CANDLE_MS) continue;
    if (openMs - openedAtMs > HOLD_MS) break;
    const high = Number(c[2]);
    const low = Number(c[3]);
    const close = Number(c[4]);
    if (Number.isFinite(close)) lastClose = close;
    const slHit = low <= S;
    const tpHit = high >= target;
    if (slHit && tpHit) return (S * (1 - STOP_SLIP) - Efill) / risk + costR; // stop-first
    if (slHit) return (S * (1 - STOP_SLIP) - Efill) / risk + costR;
    if (tpHit) return (target - Efill) / risk + costR;
  }
  return (lastClose * (1 - STOP_SLIP) - Efill) / risk + costR; // MTM at hold cap
}

async function main(): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dataDir = path.join(import.meta.dirname, "../data");
  const backup = path.join(dataDir, "paper-execution-router.2026-06-11.bak");
  const all = JSON.parse(fs.readFileSync(backup, "utf-8")).orders as OrderLike[];
  // Longs that actually entered, on the wide lane (the representative long book).
  const longs = all.filter(
    (o) =>
      o.direction === "LONG" &&
      (o.selectedLaneId ?? "").includes("CG_WIDE") &&
      (o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS" || o.paperStatus === "PAPER_SUBMITTED"),
  );
  console.log(`CG_WIDE LONG orders re-simulated under let-it-run (3R / 144h / slippage): ${longs.length}`);

  const binance = new BinanceClient();
  const nowMs = Date.parse("2026-06-14T01:30:00Z");
  const byRegime = new Map<string, EdgeSeedRow>();
  let done = 0;
  for (const o of longs) {
    const openedAtMs = Date.parse(o.openedAt);
    if (!Number.isFinite(openedAtMs)) continue;
    const startTime = openedAtMs - CANDLE_MS;
    const endTime = Math.min(nowMs, openedAtMs + 8 * 24 * 60 * 60 * 1000);
    let candles: Tuple[];
    try {
      const raw = await binance.getCandles(o.symbol, "5m", Math.min(Math.max(Math.ceil((endTime - startTime) / CANDLE_MS) + 2, 12), 1000), { startTime, endTime });
      candles = raw.map((c) => [c.openTime, "0", String(c.high), String(c.low), String(c.close), "0", c.openTime + CANDLE_MS] as Tuple);
    } catch {
      continue;
    }
    const netR = simLongRunner(o, candles, openedAtMs);
    if (netR == null) continue;
    const regime = normalizeRegimeFamily(o.regime);
    const k = `${regime}::LONG`;
    const r = byRegime.get(k) ?? { regime, direction: "LONG" as const, n: 0, wins: 0, sumNetR: 0 };
    r.n += 1;
    r.wins += netR > 0 ? 1 : 0;
    r.sumNetR += netR;
    byRegime.set(k, r);
    if (++done % 200 === 0) console.error(`  …${done}/${longs.length}`);
  }

  console.log("\n----- NEW LONG edge (let-it-run + slippage) by regime -----");
  for (const r of byRegime.values()) {
    const v = edgeVerdict({ n: r.n, wins: r.wins, sumNetR: r.sumNetR, avgNetR: r.sumNetR / r.n, winRate: (100 * r.wins) / r.n });
    console.log(`  ${`${r.regime} × LONG`.padEnd(30)} n=${String(r.n).padStart(4)} avgR=${(r.sumNetR / r.n).toFixed(3).padStart(7)} → ${v.decision}`);
  }

  // Merge: keep existing SHORT seed slices, replace LONG slices with the new sim.
  const store = new RegimeEdgeMemoryStore(dataDir);
  const snap = store.snapshot();
  const rows: EdgeSeedRow[] = [];
  for (const [key, st] of Object.entries(snap.seedStats as Record<string, EdgeStat>)) {
    const [regime, direction] = key.split("::");
    if (direction === "SHORT") rows.push({ regime: regime!, direction: "SHORT", n: st.n, wins: st.wins, sumNetR: st.sumNetR });
  }
  for (const r of byRegime.values()) rows.push(r);
  store.seed(rows, "cgwide-reseed:CG_WIDE_LONG_RUNNER(3R/144h/slip)+orig-short");
  store.save();

  console.log("\n===== EDGE MEMORY RE-SEEDED — verdicts now =====");
  for (const regime of ["Bullish expansion", "Bearish pressure", "Mixed rotation"]) {
    for (const d of ["LONG", "SHORT"] as const) {
      const v = store.verdict(regime, d);
      console.log(`  ${regime.padEnd(20)} ${d.padEnd(5)} n=${String(v.stat.n).padStart(4)} avgR=${v.stat.avgNetR.toFixed(3).padStart(7)} → ${v.allowed ? "ALLOW" : "VETO"} (${v.decision})`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
