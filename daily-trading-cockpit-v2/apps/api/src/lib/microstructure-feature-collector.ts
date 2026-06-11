/**
 * MICROSTRUCTURE FEATURE COLLECTOR V1 (DATA COLLECTOR ONLY)
 *
 * Captures book ticker, top-of-book depth, taker delta, funding rate, open
 * interest, and (best-effort) liquidations for a sampled set of symbols.
 *
 * Lane label: MICROSTRUCTURE_FEATURE_COLLECTOR_V1
 * Storage:    apps/api/data/microstructure-feature-snapshots.jsonl
 *
 * STRICTLY DATA COLLECTOR — no trading logic, no signal generation, no
 * admission decisions. Every external fetch wrapped in try/catch; never
 * throws into the caller. Disabled via MICROSTRUCTURE_COLLECTOR_DISABLED=1.
 */

import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

export const MICROSTRUCTURE_COLLECTOR_LANE =
  "MICROSTRUCTURE_FEATURE_COLLECTOR_V1" as const;
export const MICROSTRUCTURE_RICH_SCHEMA_VERSION =
  "microstructure-v2-rich-fields" as const;

// ── Types ─────────────────────────────────────────────────────────────────

export interface MicrostructureSnapshot {
  reportOnly: true;
  laneVersion: typeof MICROSTRUCTURE_COLLECTOR_LANE;
  collectorVersion?: string;
  capturedAt: string;
  symbol: string;

  // Book
  bestBid: number | null;
  bestAsk: number | null;
  spreadBps: number | null;
  bookTickerBidQty: number | null;
  bookTickerAskQty: number | null;

  // Depth
  bidDepth5Levels: number | null;
  askDepth5Levels: number | null;
  topBidQty?: number | null;
  topAskQty?: number | null;
  bidDepthNotional5?: number | null;
  askDepthNotional5?: number | null;
  depthImbalance5?: number | null;

  // Trades (rolling 1 min)
  takerBuyVolume1m: number | null;
  takerSellVolume1m: number | null;
  takerDelta1m: number | null;

  // Funding
  fundingRate: number | null;
  fundingTimeMs: number | null;

  // Open interest
  openInterest: number | null;

  // Liquidations (rolling 5 min)
  liquidationLongUsd5m: number | null;
  liquidationShortUsd5m: number | null;

  // Diagnostics
  fieldsAvailable: string[];
  fieldsMissing: string[];
  errors: string[];
  endpointResults?: MicrostructureEndpointResult[];
}

export type MicrostructureEndpointStatus =
  | "SUCCESS"
  | "FAILED"
  | "DISABLED"
  | "UNAVAILABLE";

export interface MicrostructureEndpointResult {
  endpoint: string;
  status: MicrostructureEndpointStatus;
  error?: string;
}

// ── Store ─────────────────────────────────────────────────────────────────

export class MicrostructureSnapshotStore {
  private readonly file: string;
  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "microstructure-feature-snapshots.jsonl");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // never throw on dir creation
    }
  }
  get path(): string {
    return this.file;
  }
  append(snapshot: MicrostructureSnapshot): void {
    try {
      appendFileSync(this.file, JSON.stringify(snapshot) + "\n", "utf-8");
    } catch {
      // silently swallow — collector must never break the scan
    }
  }
}

let singleton: MicrostructureSnapshotStore | null = null;
export function getMicrostructureSnapshotStore(
  dataDir = "data",
): MicrostructureSnapshotStore {
  if (!singleton) singleton = new MicrostructureSnapshotStore(dataDir);
  return singleton;
}
export function _resetMicrostructureSnapshotStoreForTests(): void {
  singleton = null;
}

// ── Collector ─────────────────────────────────────────────────────────────

/**
 * Loose interface so callers can pass either the real BinanceClient or a
 * test double. None of these methods are required to exist on every client —
 * the collector probes for `undefined` and records `fieldsMissing` instead.
 */
export interface MicrostructureBinanceLike {
  getBookTicker?: (
    symbol: string,
  ) => Promise<{ bid: number | null; ask: number | null }>;
  /** Optional richer book ticker that returns bid/ask quantities too. */
  getBookTickerWithQty?: (
    symbol: string,
  ) => Promise<{
    bid: number | null;
    ask: number | null;
    bidQty: number | null;
    askQty: number | null;
  }>;
  getDepth?: (
    symbol: string,
    limit: number,
  ) => Promise<{
    bids: Array<[string, string]>;
    asks: Array<[string, string]>;
  }>;
  getAggTrades?: (
    symbol: string,
    opts: { startTime: number; endTime: number; limit: number },
  ) => Promise<Array<{ price: number; quantity: number; isBuyerMaker: boolean }>>;
  getPremiumIndex?: (
    symbol: string,
  ) => Promise<{ fundingRate: number | null; nextFundingTime: number | null }>;
  getOpenInterest?: (symbol: string) => Promise<{ openInterest: number | null }>;
  getForceOrders?: (
    symbol: string,
    opts: { startTime: number; endTime: number },
  ) => Promise<Array<{ side: "BUY" | "SELL"; price: number; quantity: number }>>;
}

export interface MicrostructureCollectionOptions {
  nowMs?: number;
  depthEnabled?: boolean;
  tradesEnabled?: boolean;
  openInterestEnabled?: boolean;
  fundingEnabled?: boolean;
  liquidationsEnabled?: boolean;
  depthLimit?: number;
  aggTradesLimit?: number;
}

function sumDepthQuantity(levels: Array<[string, string]> | undefined): number | null {
  if (!Array.isArray(levels)) return null;
  let total = 0;
  let any = false;
  for (const [, qty] of levels) {
    const n = Number(qty);
    if (Number.isFinite(n)) {
      total += n;
      any = true;
    }
  }
  return any ? total : null;
}

function sumDepthNotional(levels: Array<[string, string]> | undefined): number | null {
  if (!Array.isArray(levels)) return null;
  let total = 0;
  let any = false;
  for (const [price, qty] of levels) {
    const p = Number(price);
    const q = Number(qty);
    if (Number.isFinite(p) && Number.isFinite(q)) {
      total += p * q;
      any = true;
    }
  }
  return any ? total : null;
}

function firstLevelQty(levels: Array<[string, string]> | undefined): number | null {
  if (!Array.isArray(levels) || !levels[0]) return null;
  const n = Number(levels[0][1]);
  return Number.isFinite(n) ? n : null;
}

export async function collectMicrostructureSnapshot(
  symbol: string,
  binanceClient: MicrostructureBinanceLike,
  opts?: MicrostructureCollectionOptions,
): Promise<MicrostructureSnapshot> {
  const now = opts?.nowMs ?? Date.now();
  const depthEnabled = opts?.depthEnabled ?? true;
  const tradesEnabled = opts?.tradesEnabled ?? true;
  const openInterestEnabled = opts?.openInterestEnabled ?? true;
  const fundingEnabled = opts?.fundingEnabled ?? true;
  const liquidationsEnabled = opts?.liquidationsEnabled ?? true;
  const depthLimit = opts?.depthLimit ?? 5;
  const aggTradesLimit = opts?.aggTradesLimit ?? 1000;
  const errors: string[] = [];
  const fieldsAvailable: string[] = [];
  const fieldsMissing: string[] = [];
  const endpointResults: MicrostructureEndpointResult[] = [];

  function recordEndpoint(
    endpoint: string,
    status: MicrostructureEndpointStatus,
    error?: unknown,
  ): void {
    const message =
      error instanceof Error ? error.message : error === undefined ? undefined : String(error);
    endpointResults.push(message ? { endpoint, status, error: message } : { endpoint, status });
  }

  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  let bookTickerBidQty: number | null = null;
  let bookTickerAskQty: number | null = null;
  let spreadBps: number | null = null;
  let bidDepth5: number | null = null;
  let askDepth5: number | null = null;
  let topBidQty: number | null = null;
  let topAskQty: number | null = null;
  let bidDepthNotional5: number | null = null;
  let askDepthNotional5: number | null = null;
  let depthImbalance5: number | null = null;
  let takerBuyVolume1m: number | null = null;
  let takerSellVolume1m: number | null = null;
  let takerDelta1m: number | null = null;
  let fundingRate: number | null = null;
  let fundingTimeMs: number | null = null;
  let openInterest: number | null = null;
  let liquidationLongUsd5m: number | null = null;
  let liquidationShortUsd5m: number | null = null;

  // Book ticker (try richer call first, fall back to basic)
  try {
    if (binanceClient.getBookTickerWithQty) {
      const bt = await binanceClient.getBookTickerWithQty(symbol);
      bestBid = bt?.bid ?? null;
      bestAsk = bt?.ask ?? null;
      bookTickerBidQty = bt?.bidQty ?? null;
      bookTickerAskQty = bt?.askQty ?? null;
      recordEndpoint("bookTicker", "SUCCESS");
    } else if (binanceClient.getBookTicker) {
      const bt = await binanceClient.getBookTicker(symbol);
      bestBid = bt?.bid ?? null;
      bestAsk = bt?.ask ?? null;
      recordEndpoint("bookTicker", "SUCCESS");
    } else {
      recordEndpoint("bookTicker", "UNAVAILABLE");
    }
    if (bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk > 0) {
      const mid = (bestBid + bestAsk) / 2;
      spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : null;
    }
  } catch (err) {
    recordEndpoint("bookTicker", "FAILED", err);
    errors.push(`bookTicker:${err instanceof Error ? err.message : String(err)}`);
  }

  // Depth (top 5)
  try {
    if (!depthEnabled) {
      recordEndpoint("depth", "DISABLED");
    } else if (binanceClient.getDepth) {
      const depth = await binanceClient.getDepth(symbol, depthLimit);
      const bids = depth?.bids?.slice(0, 5);
      const asks = depth?.asks?.slice(0, 5);
      bidDepth5 = sumDepthQuantity(bids);
      askDepth5 = sumDepthQuantity(asks);
      topBidQty = firstLevelQty(bids);
      topAskQty = firstLevelQty(asks);
      bidDepthNotional5 = sumDepthNotional(bids);
      askDepthNotional5 = sumDepthNotional(asks);
      const denom = (bidDepthNotional5 ?? 0) + (askDepthNotional5 ?? 0);
      depthImbalance5 =
        denom > 0 && bidDepthNotional5 !== null && askDepthNotional5 !== null
          ? (bidDepthNotional5 - askDepthNotional5) / denom
          : null;
      recordEndpoint("depth", "SUCCESS");
    } else {
      recordEndpoint("depth", "UNAVAILABLE");
    }
  } catch (err) {
    recordEndpoint("depth", "FAILED", err);
    errors.push(`depth:${err instanceof Error ? err.message : String(err)}`);
  }

  // Agg trades (last 60s, taker buy/sell volume)
  try {
    if (!tradesEnabled) {
      recordEndpoint("aggTrades", "DISABLED");
    } else if (binanceClient.getAggTrades) {
      const trades = await binanceClient.getAggTrades(symbol, {
        startTime: now - 60_000,
        endTime: now,
        limit: aggTradesLimit,
      });
      let buyVol = 0;
      let sellVol = 0;
      for (const t of trades ?? []) {
        const q = Number(t.quantity);
        if (!Number.isFinite(q)) continue;
        if (t.isBuyerMaker) sellVol += q;
        else buyVol += q;
      }
      takerBuyVolume1m = buyVol;
      takerSellVolume1m = sellVol;
      takerDelta1m = buyVol - sellVol;
      recordEndpoint("aggTrades", "SUCCESS");
    } else {
      recordEndpoint("aggTrades", "UNAVAILABLE");
    }
  } catch (err) {
    recordEndpoint("aggTrades", "FAILED", err);
    errors.push(`aggTrades:${err instanceof Error ? err.message : String(err)}`);
  }

  // Funding
  try {
    if (!fundingEnabled) {
      recordEndpoint("premiumIndex", "DISABLED");
    } else if (binanceClient.getPremiumIndex) {
      const pi = await binanceClient.getPremiumIndex(symbol);
      fundingRate = pi?.fundingRate ?? null;
      fundingTimeMs = pi?.nextFundingTime ?? null;
      recordEndpoint("premiumIndex", "SUCCESS");
    } else {
      recordEndpoint("premiumIndex", "UNAVAILABLE");
    }
  } catch (err) {
    recordEndpoint("premiumIndex", "FAILED", err);
    errors.push(`premiumIndex:${err instanceof Error ? err.message : String(err)}`);
  }

  // Open interest
  try {
    if (!openInterestEnabled) {
      recordEndpoint("openInterest", "DISABLED");
    } else if (binanceClient.getOpenInterest) {
      const oi = await binanceClient.getOpenInterest(symbol);
      openInterest = oi?.openInterest ?? null;
      recordEndpoint("openInterest", "SUCCESS");
    } else {
      recordEndpoint("openInterest", "UNAVAILABLE");
    }
  } catch (err) {
    recordEndpoint("openInterest", "FAILED", err);
    errors.push(`openInterest:${err instanceof Error ? err.message : String(err)}`);
  }

  // Force orders (liquidations rolling 5 min)
  try {
    if (!liquidationsEnabled) {
      recordEndpoint("forceOrders", "DISABLED");
    } else if (binanceClient.getForceOrders) {
      const forces = await binanceClient.getForceOrders(symbol, {
        startTime: now - 5 * 60_000,
        endTime: now,
      });
      let longLiq = 0;
      let shortLiq = 0;
      for (const f of forces ?? []) {
        const price = Number(f.price);
        const qty = Number(f.quantity);
        if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
        const usd = price * qty;
        // SELL force orders → forced sale of a long → long liquidation
        if (f.side === "SELL") longLiq += usd;
        else if (f.side === "BUY") shortLiq += usd;
      }
      liquidationLongUsd5m = longLiq;
      liquidationShortUsd5m = shortLiq;
      recordEndpoint("forceOrders", "SUCCESS");
    } else {
      recordEndpoint("forceOrders", "UNAVAILABLE");
    }
  } catch (err) {
    recordEndpoint("forceOrders", "FAILED", err);
    errors.push(`forceOrders:${err instanceof Error ? err.message : String(err)}`);
  }

  function classify(name: string, v: unknown): void {
    if (v === null || v === undefined) fieldsMissing.push(name);
    else fieldsAvailable.push(name);
  }
  classify("bestBid", bestBid);
  classify("bestAsk", bestAsk);
  classify("spreadBps", spreadBps);
  classify("bookTickerBidQty", bookTickerBidQty);
  classify("bookTickerAskQty", bookTickerAskQty);
  classify("bidDepth5Levels", bidDepth5);
  classify("askDepth5Levels", askDepth5);
  classify("topBidQty", topBidQty);
  classify("topAskQty", topAskQty);
  classify("bidDepthNotional5", bidDepthNotional5);
  classify("askDepthNotional5", askDepthNotional5);
  classify("depthImbalance5", depthImbalance5);
  classify("takerBuyVolume1m", takerBuyVolume1m);
  classify("takerSellVolume1m", takerSellVolume1m);
  classify("takerDelta1m", takerDelta1m);
  classify("fundingRate", fundingRate);
  classify("fundingTimeMs", fundingTimeMs);
  classify("openInterest", openInterest);
  classify("liquidationLongUsd5m", liquidationLongUsd5m);
  classify("liquidationShortUsd5m", liquidationShortUsd5m);

  return {
    reportOnly: true,
    laneVersion: MICROSTRUCTURE_COLLECTOR_LANE,
    collectorVersion: MICROSTRUCTURE_RICH_SCHEMA_VERSION,
    capturedAt: new Date(now).toISOString(),
    symbol,
    bestBid,
    bestAsk,
    spreadBps,
    bookTickerBidQty,
    bookTickerAskQty,
    bidDepth5Levels: bidDepth5,
    askDepth5Levels: askDepth5,
    topBidQty,
    topAskQty,
    bidDepthNotional5,
    askDepthNotional5,
    depthImbalance5,
    takerBuyVolume1m,
    takerSellVolume1m,
    takerDelta1m,
    fundingRate,
    fundingTimeMs,
    openInterest,
    liquidationLongUsd5m,
    liquidationShortUsd5m,
    fieldsAvailable,
    fieldsMissing,
    errors,
    endpointResults,
  };
}

// ── Report builder ────────────────────────────────────────────────────────

export interface MicrostructureCollectorReport {
  reportOnly: true;
  computedAt: string;
  snapshotsCollected: number;
  richSchemaSnapshots: number;
  symbolsCovered: string[];
  allTimeCompleteness: Record<string, number>;
  postUpgradeCompleteness: Record<string, number>;
  latestSpreadDistribution: {
    p50: number | null;
    p90: number | null;
    p99: number | null;
  };
  depthAvailability: number;
  depthImbalanceAvailability: number;
  bookTickerQtyAvailability: number;
  openInterestAvailability: number;
  fundingRateAvailability: number;
  tradeDeltaAvailability: number;
  liquidationAvailability: number;
  endpointDiagnostics: Record<
    string,
    {
      success: number;
      failed: number;
      disabled: number;
      unavailable: number;
    }
  >;
  dataQualityWarnings: string[];
}

const TRACKED_FIELDS = [
  "bestBid",
  "bestAsk",
  "spreadBps",
  "bookTickerBidQty",
  "bookTickerAskQty",
  "bidDepth5Levels",
  "askDepth5Levels",
  "topBidQty",
  "topAskQty",
  "bidDepthNotional5",
  "askDepthNotional5",
  "depthImbalance5",
  "takerBuyVolume1m",
  "takerSellVolume1m",
  "takerDelta1m",
  "fundingRate",
  "fundingTimeMs",
  "openInterest",
  "liquidationLongUsd5m",
  "liquidationShortUsd5m",
] as const;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx]!;
}

/**
 * Streaming tail reader — reads last `tailLimit` lines of the JSONL store
 * without loading the whole file into memory.
 */
async function readTailSnapshots(
  filePath: string,
  tailLimit: number,
): Promise<MicrostructureSnapshot[]> {
  if (!existsSync(filePath)) return [];
  const lines: string[] = [];
  await new Promise<void>((resolveP) => {
    try {
      const stream = createReadStream(filePath, { encoding: "utf-8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (line.length === 0) return;
        lines.push(line);
        if (lines.length > tailLimit) lines.shift();
      });
      rl.on("close", () => resolveP());
      rl.on("error", () => resolveP());
      stream.on("error", () => resolveP());
    } catch {
      resolveP();
    }
  });
  const out: MicrostructureSnapshot[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as MicrostructureSnapshot);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export async function buildMicrostructureCollectorReport(
  store: MicrostructureSnapshotStore,
  opts?: { tailLimit?: number },
): Promise<MicrostructureCollectorReport> {
  const tailLimit = opts?.tailLimit ?? 1000;
  const snapshots = await readTailSnapshots(store.path, tailLimit);
  const richSchemaSnapshots = snapshots.filter(
    (snapshot) => snapshot.collectorVersion === MICROSTRUCTURE_RICH_SCHEMA_VERSION,
  );
  const symbols = Array.from(new Set(snapshots.map((s) => s.symbol)));
  const warnings: string[] = [];

  function buildCompleteness(input: MicrostructureSnapshot[]): Record<string, number> {
    const completeness: Record<string, number> = {};
    for (const field of TRACKED_FIELDS) {
      let populated = 0;
      for (const snapshot of input) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const value = (snapshot as any)[field];
        if (value !== null && value !== undefined) populated += 1;
      }
      completeness[field] = input.length > 0 ? populated / input.length : 0;
    }
    return completeness;
  }

  const allTimeCompleteness = buildCompleteness(snapshots);
  const postUpgradeCompleteness = buildCompleteness(richSchemaSnapshots);

  let fileBytes = 0;
  try {
    fileBytes = existsSync(store.path) ? statSync(store.path).size : 0;
  } catch {
    // ignore
  }
  if (fileBytes > 50 * 1024 * 1024) {
    warnings.push("snapshot file exceeds 50MB — consider rotation");
  }
  if (snapshots.length > 0 && symbols.length === 1) {
    warnings.push("only 1 symbol covered — broaden sample for distribution stats");
  }
  if (snapshots.length === 0) {
    warnings.push("no snapshots collected yet");
  }

  const spreads = snapshots
    .map((s) => s.spreadBps)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);

  const endpointDiagnostics: MicrostructureCollectorReport["endpointDiagnostics"] = {};
  function ensureEndpoint(endpoint: string) {
    endpointDiagnostics[endpoint] ??= {
      success: 0,
      failed: 0,
      disabled: 0,
      unavailable: 0,
    };
    return endpointDiagnostics[endpoint]!;
  }
  for (const s of snapshots) {
    for (const result of s.endpointResults ?? []) {
      const row = ensureEndpoint(result.endpoint);
      if (result.status === "SUCCESS") row.success += 1;
      else if (result.status === "FAILED") row.failed += 1;
      else if (result.status === "DISABLED") row.disabled += 1;
      else if (result.status === "UNAVAILABLE") row.unavailable += 1;
      if (
        result.status === "FAILED" &&
        result.error &&
        (result.error.includes("429") || result.error.toLowerCase().includes("rate"))
      ) {
        if (!warnings.includes("RATE_LIMIT_RISK")) warnings.push("RATE_LIMIT_RISK");
      }
    }
  }

  const bookTickerQtyAvailability = Math.min(
    postUpgradeCompleteness.bookTickerBidQty ?? 0,
    postUpgradeCompleteness.bookTickerAskQty ?? 0,
  );
  const depthAvailability = Math.min(
    postUpgradeCompleteness.bidDepth5Levels ?? 0,
    postUpgradeCompleteness.askDepth5Levels ?? 0,
  );
  const fundingRateAvailability = Math.min(
    postUpgradeCompleteness.fundingRate ?? 0,
    postUpgradeCompleteness.fundingTimeMs ?? 0,
  );
  const liquidationAvailability = Math.min(
    postUpgradeCompleteness.liquidationLongUsd5m ?? 0,
    postUpgradeCompleteness.liquidationShortUsd5m ?? 0,
  );

  if (richSchemaSnapshots.length === 0 && snapshots.length > 0) {
    warnings.push("no post-upgrade rich-schema snapshots collected yet");
  }
  if (richSchemaSnapshots.length > 0) {
    if (bookTickerQtyAvailability === 0) warnings.push("BOOK_QTY_MISSING");
    if (depthAvailability === 0) warnings.push("DEPTH_MISSING");
    if ((postUpgradeCompleteness.openInterest ?? 0) === 0) warnings.push("OPEN_INTEREST_MISSING");
    if (fundingRateAvailability === 0) warnings.push("FUNDING_MISSING");
    if ((postUpgradeCompleteness.takerDelta1m ?? 0) === 0) warnings.push("TRADE_FLOW_MISSING");
    if (liquidationAvailability === 0) warnings.push("LIQUIDATION_MISSING");
  }

  return {
    reportOnly: true,
    computedAt: new Date().toISOString(),
    snapshotsCollected: snapshots.length,
    richSchemaSnapshots: richSchemaSnapshots.length,
    symbolsCovered: symbols,
    allTimeCompleteness,
    postUpgradeCompleteness,
    latestSpreadDistribution: {
      p50: percentile(spreads, 50),
      p90: percentile(spreads, 90),
      p99: percentile(spreads, 99),
    },
    depthAvailability,
    depthImbalanceAvailability: postUpgradeCompleteness.depthImbalance5 ?? 0,
    bookTickerQtyAvailability,
    openInterestAvailability: postUpgradeCompleteness.openInterest ?? 0,
    fundingRateAvailability,
    tradeDeltaAvailability: postUpgradeCompleteness.takerDelta1m ?? 0,
    liquidationAvailability,
    endpointDiagnostics,
    dataQualityWarnings: warnings,
  };
}
