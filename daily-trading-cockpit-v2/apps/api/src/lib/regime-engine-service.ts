/**
 * Regime switching engine — VPS runtime cycle (REPORT-ONLY).
 *
 * Every scan cycle (env-gated REGIME_ENGINE_ENABLED=1) this fetches real Binance
 * market data — BTC 1h/4h/1d + ETH 1h candles, a liquid-universe breadth sweep,
 * BTC book spread, 24h quote volume, and funding — feeds it through the
 * hypothesis framework (breadthFromCandles → contextFromCandles →
 * buildTradingDecision), and RECORDS the decision + trace to a bounded history.
 *
 * It never places an order and is not wired to any execution path. The point is
 * to accrue an out-of-sample record of what the regime engine WOULD do, cycle by
 * cycle, before any of it is trusted with money — the same measure-first
 * discipline as the fresh feed / fade-long / H6 lanes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { BinanceClient } from "./binance.js";
import { fetchCrowdingSnapshot } from "./derivatives-crowding.js";
import { breadthFromCandles } from "../trading/features/breadthFromCandles.js";
import { contextFromCandles } from "../trading/features/contextFromCandles.js";
import { buildTradingDecision } from "../trading/decision/buildTradingDecision.js";
import type { BreadthMetrics } from "../trading/features/breadthFromCandles.js";

/** Liquid universe used for the breadth sweep (matches the scanner's usual book). */
export const REGIME_ENGINE_BREADTH_UNIVERSE = [
  "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT",
  "DOGEUSDT", "NEARUSDT", "SUIUSDT", "SEIUSDT", "INJUSDT", "WLDUSDT", "FETUSDT",
] as const;

export interface RegimeEngineSnapshot {
  at: string;
  btcPrice: number | null;
  regime: string;
  action: "ENTER_LONG" | "ENTER_SHORT" | "NO_TRADE";
  lane: string | null;
  rejectedBy: string | null;
  noTradeReason: string[] | null;
  contradictions: string[];
  spreadBps: number | null;
  fundingRate: number | null;
  fundingRiskAbnormal: boolean;
  breadth: {
    advancersPct: number | null;
    altAdvancersPct: number | null;
    percentAboveEma20: number | null;
    btcReturn24h: number | null;
    unavailableReason: string | null;
  };
}

interface RegimeEngineHistoryFile {
  version: number;
  snapshots: RegimeEngineSnapshot[];
}

const HISTORY_VERSION = 1;
const MAX_SNAPSHOTS = 3000; // ~2 weeks at 7-min cycles
const MIN_CYCLE_GAP_MS = 5 * 60_000;

export class RegimeEngineStore {
  private readonly file: string;
  private data: RegimeEngineHistoryFile;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "regime-engine-history.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.data = this._load();
  }

  private _load(): RegimeEngineHistoryFile {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
        if (parsed && Array.isArray(parsed.snapshots)) return parsed as RegimeEngineHistoryFile;
      }
    } catch {
      // corrupt — start fresh (report-only diagnostic data)
    }
    return { version: HISTORY_VERSION, snapshots: [] };
  }

  get snapshots(): RegimeEngineSnapshot[] {
    return this.data.snapshots;
  }

  append(snapshot: RegimeEngineSnapshot): void {
    this.data.snapshots.push(snapshot);
    if (this.data.snapshots.length > MAX_SNAPSHOTS) {
      this.data.snapshots = this.data.snapshots.slice(-MAX_SNAPSHOTS);
    }
    try {
      writeFileSync(this.file, JSON.stringify(this.data), "utf-8");
    } catch {
      // diagnostic history only — never let a write failure break the scan
    }
  }
}

let storeSingleton: RegimeEngineStore | null = null;
export function getRegimeEngineStore(): RegimeEngineStore {
  if (!storeSingleton) storeSingleton = new RegimeEngineStore();
  return storeSingleton;
}
export function _resetRegimeEngineStoreForTests(store: RegimeEngineStore | null): void {
  storeSingleton = store;
}

export function isRegimeEngineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REGIME_ENGINE_ENABLED === "1";
}

let running = false;
let lastRunMs = 0;

/** Single-flight + min-interval guard; safe to fire-and-forget from the scan cycle. */
export function runRegimeEngineCycleGuarded(client: BinanceClient, nowIso: string): void {
  const nowMs = new Date(nowIso).getTime();
  if (running || nowMs - lastRunMs < MIN_CYCLE_GAP_MS) return;
  running = true;
  lastRunMs = nowMs;
  void runRegimeEngineCycle(client, nowIso)
    .catch(() => {
      // report-only — a failed cycle just means no snapshot this round
    })
    .finally(() => {
      running = false;
    });
}

export async function runRegimeEngineCycle(client: BinanceClient, nowIso: string): Promise<RegimeEngineSnapshot> {
  const asOf = new Date(nowIso).getTime();

  // ── market data (all real Binance) ─────────────────────────────────────────
  const [btcH1, btcH4, btcD1, ethH1, book, ticker, crowding] = await Promise.all([
    client.getCandles("BTCUSDT", "1h", 200),
    client.getCandles("BTCUSDT", "4h", 120),
    client.getCandles("BTCUSDT", "1d", 40),
    client.getCandles("ETHUSDT", "1h", 60),
    client.getBookTicker("BTCUSDT"),
    client.getTicker24h("BTCUSDT"),
    fetchCrowdingSnapshot(client, "BTCUSDT", nowIso).catch(() => null),
  ]);

  // Breadth sweep over the liquid universe (best-effort per symbol).
  const universeMaybe = await Promise.all(
    REGIME_ENGINE_BREADTH_UNIVERSE.map(async (symbol) => {
      try {
        return { symbol: symbol as string, h1: await client.getCandles(symbol, "1h", 48) };
      } catch {
        return null;
      }
    }),
  );
  const universe = universeMaybe.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const breadthOut = breadthFromCandles({
    asOf,
    btc: btcH1,
    universe,
    universeKind: "CURRENT_LIQUID_UNIVERSE",
    universeDescription: "scanner liquid universe (14 alts); not the full historical crypto universe",
  });

  // ── microstructure (BTC as the venue proxy) ────────────────────────────────
  const spreadBps =
    book.bid !== null && book.ask !== null && book.bid > 0 && book.ask > book.bid
      ? ((book.ask - book.bid) / ((book.ask + book.bid) / 2)) * 10_000
      : null;
  const fundingRate = crowding?.fundingRate ?? null;
  const fundingRiskAbnormal = crowding?.crowdingLevel === "EXTREME";
  const btcPrice = btcH1.length > 0 ? btcH1[btcH1.length - 1]!.close : null;

  const ctx = contextFromCandles({
    asOf,
    btc: { h1: btcH1, h4: btcH4, d1: btcD1 },
    eth: { h1: ethH1 },
    breadth: breadthOut.breadth,
    microstructure: {
      spreadBps: spreadBps ?? 1,
      // Slippage is not observable from candles/book alone; use the spread as a
      // conservative taker proxy (labelled honest: report-only, never executes).
      slippageBps: spreadBps !== null ? Math.min(10, Math.max(1, spreadBps)) : 2,
      liquidityTier: "MAJOR",
      quoteVolumeUsd24h: ticker.quoteVolume24h ?? undefined,
      fundingRiskAbnormal,
    },
    governance: {
      // Report-only engine holds no positions; governance counters are neutral.
      dailyLossPct: 0,
      consecutiveLosses: 0,
      openPositions: 0,
      tradesToday: 0,
    },
    overrides: breadthOut.flags,
  });

  const decision = buildTradingDecision(ctx);

  const snapshot: RegimeEngineSnapshot = {
    at: nowIso,
    btcPrice,
    regime: decision.trace?.detectedRegime ?? "NO_TRADE",
    action: decision.action,
    lane: decision.action === "NO_TRADE" ? null : decision.lane,
    rejectedBy: decision.trace?.rejectedBy ?? null,
    noTradeReason: decision.trace?.noTradeReason?.slice(0, 4) ?? null,
    contradictions: decision.trace?.contradictions ?? [],
    spreadBps,
    fundingRate,
    fundingRiskAbnormal,
    breadth: {
      advancersPct: breadthOut.breadth?.advancersPct ?? null,
      altAdvancersPct: breadthOut.breadth?.altAdvancersPct ?? null,
      percentAboveEma20: breadthOut.metrics?.percentAboveEma20 ?? null,
      btcReturn24h: breadthOut.metrics?.btcReturn24h ?? null,
      unavailableReason: breadthOut.unavailableReason ?? null,
    },
  };
  getRegimeEngineStore().append(snapshot);
  return snapshot;
}

// ── report ────────────────────────────────────────────────────────────────────

export interface RegimeEngineReport {
  enabled: boolean;
  snapshotCount: number;
  latest: RegimeEngineSnapshot | null;
  regimeCounts: Record<string, number>;
  /** Subset of regimeCounts where contradictions were non-empty, i.e. `s.regime` was
   *  detected but the decision was actually forced to NO_TRADE by detectContradictions
   *  before that label could route to a lane. `s.regime` records the PRE-contradiction
   *  detected label (buildTradingDecision.ts sets trace.detectedRegime before running
   *  the contradiction check), so regimeCounts alone can overstate how often a regime
   *  was genuinely clean — this lets a reader subtract out the contradiction-flagged
   *  share before trusting a count as "real" (e.g. after the 2026-07-10 retest62000Hold
   *  fix widened the price range where retestFailed/retest62000Hold can theoretically
   *  co-occur). */
  regimeContradictionFlaggedCounts: Record<string, number>;
  actionCounts: Record<string, number>;
  rejectedByCounts: Record<string, number>;
  /** at + regime for each regime CHANGE (transitions), most recent last. */
  transitions: Array<{ at: string; from: string; to: string }>;
  recent: RegimeEngineSnapshot[];
  breadthMetricsLatest: BreadthMetrics | null;
}

export function buildRegimeEngineReport(recentCount = 50): Omit<RegimeEngineReport, "enabled" | "breadthMetricsLatest"> {
  const snapshots = getRegimeEngineStore().snapshots;
  const regimeCounts: Record<string, number> = {};
  const regimeContradictionFlaggedCounts: Record<string, number> = {};
  const actionCounts: Record<string, number> = {};
  const rejectedByCounts: Record<string, number> = {};
  const transitions: Array<{ at: string; from: string; to: string }> = [];
  let prevRegime: string | null = null;
  for (const s of snapshots) {
    regimeCounts[s.regime] = (regimeCounts[s.regime] ?? 0) + 1;
    if (s.contradictions.length > 0) {
      regimeContradictionFlaggedCounts[s.regime] = (regimeContradictionFlaggedCounts[s.regime] ?? 0) + 1;
    }
    actionCounts[s.action] = (actionCounts[s.action] ?? 0) + 1;
    if (s.rejectedBy) rejectedByCounts[s.rejectedBy] = (rejectedByCounts[s.rejectedBy] ?? 0) + 1;
    if (prevRegime !== null && prevRegime !== s.regime) transitions.push({ at: s.at, from: prevRegime, to: s.regime });
    prevRegime = s.regime;
  }
  return {
    snapshotCount: snapshots.length,
    latest: snapshots.length > 0 ? snapshots[snapshots.length - 1]! : null,
    regimeCounts,
    regimeContradictionFlaggedCounts,
    actionCounts,
    rejectedByCounts,
    transitions: transitions.slice(-40),
    recent: snapshots.slice(-recentCount),
  };
}
