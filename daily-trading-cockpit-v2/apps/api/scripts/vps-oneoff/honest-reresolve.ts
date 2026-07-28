/**
 * One-off forensic: re-run the FIXED resolver (72h max-hold MTM) against the
 * pre-reset backup to get the TRUE economics once the 1203 hidden CG_WIDE shorts
 * are forced to book. Read-only on the real store: copies the backup into a temp
 * dir and resolves THAT. Needs WARP (live market data).
 */
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinanceClient } from "../src/lib/binance.js";
import {
  PaperExecutionRouterStore,
  resolvePaperOrders,
  type PaperKlineTuple,
  type PaperOrder,
} from "../src/lib/paper-execution-router.js";
import {
  RegimeEdgeMemoryStore,
  normalizeRegimeFamily,
  edgeVerdict,
  type EdgeSeedRow,
} from "../src/lib/regime-edge-memory.js";

const SEED = process.argv.includes("--seed");
const DATA_DIR = join(import.meta.dirname, "../data");

const BACKUP = join(import.meta.dirname, "../data/paper-execution-router.2026-06-11.bak");

function econ(rows: PaperOrder[]): { n: number; wr: number; sumR: number; avgR: number } {
  const r = rows.filter((o) => typeof o.netR === "number") as (PaperOrder & { netR: number })[];
  const n = r.length;
  if (n === 0) return { n: 0, wr: 0, sumR: 0, avgR: 0 };
  const wins = r.filter((o) => o.netR > 0).length;
  const sumR = r.reduce((a, o) => a + o.netR, 0);
  return { n, wr: (100 * wins) / n, sumR, avgR: sumR / n };
}

function snapshot(label: string, orders: PaperOrder[]): void {
  const byStatus: Record<string, number> = {};
  for (const o of orders) byStatus[o.paperStatus] = (byStatus[o.paperStatus] ?? 0) + 1;
  console.log(`\n===== ${label} =====`);
  console.log("status:", JSON.stringify(byStatus));
  const closed = orders.filter(
    (o) => o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS",
  );
  for (const dir of ["LONG", "SHORT"] as const) {
    const e = econ(closed.filter((o) => o.direction === dir));
    console.log(
      `  ${dir.padEnd(5)}: n=${String(e.n).padStart(4)}  WR=${e.wr.toFixed(1).padStart(5)}%  sumNetR=${e.sumR.toFixed(1).padStart(8)}  avgR=${e.avgR.toFixed(3)}`,
    );
  }
  const all = econ(closed);
  console.log(`  TOTAL: n=${all.n}  sumNetR=${all.sumR.toFixed(1)}  avgR=${all.avgR.toFixed(3)}`);
  // close-reason breakdown for newly resolved
  const reasons: Record<string, number> = {};
  for (const o of closed) reasons[o.closeReason ?? "?"] = (reasons[o.closeReason ?? "?"] ?? 0) + 1;
  console.log("  closeReasons:", JSON.stringify(reasons));
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "honest-reresolve-"));
  copyFileSync(BACKUP, join(tmp, "paper-execution-router.json"));
  const store = new PaperExecutionRouterStore(tmp);

  snapshot("BEFORE (as displayed — winners closed, 1498 SHORT/LONG parked open)", store.all);

  const binance = new BinanceClient();
  const client = {
    getKlines: async (
      symbol: string,
      interval: string,
      opts: { startTime: number; endTime: number; limit: number },
    ): Promise<PaperKlineTuple[]> => {
      const candles = await binance.getCandles(symbol, interval, opts.limit, {
        startTime: opts.startTime,
        endTime: opts.endTime,
      });
      return candles.map(
        (c) =>
          [c.openTime, "0", String(c.high), String(c.low), String(c.close), "0", c.openTime + 300_000] as PaperKlineTuple,
      );
    },
  };

  console.log("\nResolving (live candles via WARP)… this walks ~1500 unresolved orders.");
  const result = await resolvePaperOrders(store, client);
  console.log("resolve result:", JSON.stringify(result));

  snapshot("AFTER (fixed resolver — hidden losers booked at SL or 72h MTM)", store.all);

  // ── Honest edge table for SEEDING the smart gate: (regime × direction) and
  //    (lane × direction). This is the prior the edge-memory starts from.
  const closed = store.all.filter(
    (o) => o.paperStatus === "PAPER_CLOSED_WIN" || o.paperStatus === "PAPER_CLOSED_LOSS",
  );
  const norm = (r: string | null | undefined): string => {
    const s = (r ?? "").toLowerCase();
    if (s.includes("bullish") && (s.includes("expansion") || s.includes("pressure") || s.includes("breakout"))) return "BULLISH_EXPANSION";
    if (s.includes("bearish") && (s.includes("expansion") || s.includes("pressure") || s.includes("breakdown"))) return "BEARISH_EXPANSION";
    if (s.includes("mixed") || s.includes("rotation")) return "MIXED_ROTATION";
    return (r ?? "NONE").toUpperCase().replace(/\s+/g, "_");
  };
  const table = (keyFn: (o: PaperOrder) => string, title: string): void => {
    const groups = new Map<string, PaperOrder[]>();
    for (const o of closed) {
      const k = keyFn(o);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(o);
    }
    const rows = [...groups.entries()]
      .map(([k, rs]) => ({ k, ...econ(rs) }))
      .sort((a, b) => b.avgR - a.avgR);
    console.log(`\n----- ${title} (sorted by avgR) -----`);
    for (const r of rows) {
      const flag = r.n >= 30 && r.avgR > 0.02 ? " ✅POS" : r.n >= 30 && r.avgR < -0.02 ? " ❌NEG" : " ·thin";
      console.log(`  ${r.k.padEnd(40)} n=${String(r.n).padStart(4)}  WR=${r.wr.toFixed(1).padStart(5)}%  sumR=${r.sumR.toFixed(1).padStart(8)}  avgR=${r.avgR.toFixed(3).padStart(7)}${flag}`);
    }
  };
  table((o) => `${norm(o.regime)} × ${o.direction}`, "EDGE BY REGIME × DIRECTION");
  table((o) => `${(o.selectedLaneId ?? "NONE").split(":").pop()} × ${o.direction}`, "EDGE BY LANE × DIRECTION");

  // ── Seed the honest-edge gate's frozen prior from this re-resolve ──────────
  if (SEED) {
    const rows = new Map<string, EdgeSeedRow>();
    for (const o of closed) {
      const dir = o.direction;
      // SEED uses ALL honestly-resolved historical orders as the frozen prior —
      // the 2026-06-11 backup is entirely DIAGNOSTIC_ONLY (the paper book of that
      // era), so excluding diagnostics would leave the prior empty. The live
      // aggregate (updateFromClosedOrders) deliberately tracks only forward
      // HEADLINE closes, so the prior is refined toward real-trading edge.
      if (dir !== "LONG" && dir !== "SHORT") continue;
      if (typeof o.netR !== "number" || !Number.isFinite(o.netR)) continue;
      const regime = normalizeRegimeFamily(o.regime);
      const k = `${regime}::${dir}`;
      const r = rows.get(k) ?? { regime, direction: dir, n: 0, wins: 0, sumNetR: 0 };
      r.n += 1;
      r.wins += o.netR > 0 ? 1 : 0;
      r.sumNetR += o.netR;
      rows.set(k, r);
    }
    const seedStore = new RegimeEdgeMemoryStore(DATA_DIR);
    seedStore.seed([...rows.values()], "honest-reresolve:paper-execution-router.2026-06-11.bak");
    seedStore.save();
    console.log(`\n===== SEEDED regime-edge-memory.json (${rows.size} slices) =====`);
    for (const r of [...rows.values()].sort((a, b) => b.sumNetR / b.n - a.sumNetR / a.n)) {
      const v = edgeVerdict({ n: r.n, wins: r.wins, sumNetR: r.sumNetR, avgNetR: r.sumNetR / r.n, winRate: (100 * r.wins) / r.n });
      console.log(`  ${`${r.regime} × ${r.direction}`.padEnd(34)} n=${String(r.n).padStart(4)} avgR=${(r.sumNetR / r.n).toFixed(3).padStart(7)}  → ${v.decision} (${v.allowed ? "ALLOW" : "VETO"})`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
