/**
 * MOONSHOT_LOTTERY_LANE — feature extraction + demo cycle + store (priorities 7-9).
 *
 * Reuses the existing Binance market-data client (NO new WebSocket): 1m candles (price-change
 * 1/3/5m + volume ratio), futures flow (funding / OI delta / taker buy-sell), order-book depth
 * (spread + depth 0.5%/1%), mark price (vs last divergence). minNotional comes from exchange
 * filters; the symbol MAX LEVERAGE has no public fetch here (signed endpoint), so demo uses a
 * conservative default — the EXECUTION phase MUST re-check the real leverage bracket before any order.
 *
 * v1 is DEMO / REPORT-ONLY: it generates + LOGS signals and rejections (the safety-log requirement),
 * never places orders. A cheap pre-filter keeps the expensive per-symbol calls to the top movers so
 * we don't REST-spam the whole universe. Env-gated MOONSHOT_LOTTERY_ENABLED=1.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  evaluateMoonshot,
  emptyMoonshotDailyState,
  MOONSHOT_SCORE_MIN,
  type MoonshotFeatures,
  type MoonshotDailyState,
  type MoonshotEvaluation,
} from "./moonshot-lottery-lane.js";
import { getNewCoinRadarStore } from "./new-coin-radar.js";

function envNum(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
export const MOONSHOT_DEFAULT_MAX_LEVERAGE = envNum("MOONSHOT_DEFAULT_MAX_LEVERAGE", 50); // demo cap until the real bracket is fetched at execution
export const MOONSHOT_MAX_DEEP_EXTRACT = envNum("MOONSHOT_MAX_DEEP_EXTRACT", 8); // cap expensive per-symbol fetches per cycle
export const MOONSHOT_PREFILTER_MIN_1M_PCT = Number(process.env.MOONSHOT_PREFILTER_MIN_1M_PCT ?? 0.5);
export const MOONSHOT_PREFILTER_MIN_VOL_RATIO = envNum("MOONSHOT_PREFILTER_MIN_VOL_RATIO", 2);
const LOG_KEEP = envNum("MOONSHOT_LOG_KEEP", 400);

type Candle = { close: number; volume: number };
type DepthSide = Array<[number, number]>; // [price, qty]

export interface MoonshotExtractionCtx {
  getCandles1m: (symbol: string, limit: number) => Promise<Candle[]>;
  getFlow: (symbol: string) => Promise<{ fundingRate: number | null; openInterestChangePercent: number | null; takerBuySellRatio: number | null }>;
  getDepth: (symbol: string) => Promise<{ bids: DepthSide; asks: DepthSide }>;
  getMarkPrice: (symbol: string) => Promise<number | null>;
  minNotionalUsd: (symbol: string) => number;
  maxLeverage: (symbol: string) => number;
}

function pctChange(a: number, b: number): number {
  return b > 0 ? ((a - b) / b) * 100 : 0;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/** Cheap first pass from 1m candles only — used to pick which symbols deserve the expensive fetches. */
export function moonshotPrefilter(candles: Candle[]): { pass: boolean; price1mPct: number; volRatio: number } {
  if (candles.length < 6) return { pass: false, price1mPct: 0, volRatio: 0 };
  const c = candles.map((x) => x.close);
  const v = candles.map((x) => x.volume);
  const price1mPct = pctChange(c[c.length - 1]!, c[c.length - 2]!);
  const avgVol = mean(v.slice(-6, -1));
  const volRatio = avgVol > 0 ? v[v.length - 1]! / avgVol : 0;
  return { pass: price1mPct >= MOONSHOT_PREFILTER_MIN_1M_PCT && volRatio >= MOONSHOT_PREFILTER_MIN_VOL_RATIO, price1mPct, volRatio };
}

function depthWithinPct(bids: DepthSide, asks: DepthSide, mid: number, pct: number): number {
  const lo = mid * (1 - pct);
  const hi = mid * (1 + pct);
  let usd = 0;
  for (const [p, q] of bids) if (p >= lo) usd += p * q;
  for (const [p, q] of asks) if (p <= hi) usd += p * q;
  return usd;
}

/** Build the full feature object for one symbol. Returns null if data is missing/degenerate. */
export async function extractMoonshotFeatures(
  symbol: string,
  candles: Candle[],
  btc1mPct: number,
  ctx: MoonshotExtractionCtx,
): Promise<MoonshotFeatures | null> {
  if (candles.length < 6) return null;
  const c = candles.map((x) => x.close);
  const v = candles.map((x) => x.volume);
  const last = c[c.length - 1]!;
  if (!(last > 0)) return null;

  const [flow, depth, mark] = await Promise.all([
    ctx.getFlow(symbol).catch(() => ({ fundingRate: null, openInterestChangePercent: null, takerBuySellRatio: null })),
    ctx.getDepth(symbol).catch(() => ({ bids: [] as DepthSide, asks: [] as DepthSide })),
    ctx.getMarkPrice(symbol).catch(() => null),
  ]);
  const bestBid = depth.bids[0]?.[0];
  const bestAsk = depth.asks[0]?.[0];
  if (!(bestBid && bestAsk && bestBid > 0 && bestAsk > 0)) return null;
  const mid = (bestBid + bestAsk) / 2;

  return {
    symbol,
    priceChange1mPct: pctChange(last, c[c.length - 2]!),
    priceChange3mPct: pctChange(last, c[c.length - 4]!),
    priceChange5mPct: pctChange(last, c[c.length - 6]!),
    volumeRatio1m: mean(v.slice(-6, -1)) > 0 ? v[v.length - 1]! / mean(v.slice(-6, -1)) : 0,
    takerBuySellRatio: flow.takerBuySellRatio ?? 1,
    oiDelta3mPct: flow.openInterestChangePercent ?? 0,
    fundingRate: flow.fundingRate ?? 0,
    spreadBps: ((bestAsk - bestBid) / mid) * 10_000,
    depth05PctUsd: depthWithinPct(depth.bids, depth.asks, mid, 0.005),
    depth1PctUsd: depthWithinPct(depth.bids, depth.asks, mid, 0.01),
    btc1mPct,
    markVsLastDivergenceBps: mark && mark > 0 ? (Math.abs(mark - last) / last) * 10_000 : 0,
    minNotionalUsd: ctx.minNotionalUsd(symbol),
    maxLeverage: ctx.maxLeverage(symbol),
  };
}

// ─── store (signals + daily state + safety log) ──────────────────────────────

export interface MoonshotLogEntry {
  ts: string;
  symbol: string;
  decision: "SIGNAL" | "REJECT";
  moonshotScore: number;
  riskScore: number;
  finalLeverage: number;
  isSniper: boolean;
  reasons: string[]; // signal reasons OR reject reasons
}

export interface MoonshotLastCycle {
  ts: string;
  scanned: number;
  prefiltered: number;
  signals: number;
  rejects: number;
  /** The universe actually scanned this cycle (meme-focused since 2026-07-08). */
  universe?: string[];
}

/** 10 buckets of width 10 over the 0–100 moonshot score (index = floor(score/10)). */
export const MOONSHOT_SCORE_BUCKETS = 10;
const emptyHistogram = (): number[] => new Array(MOONSHOT_SCORE_BUCKETS).fill(0);

interface MoonshotStoreState {
  version: number;
  daily: MoonshotDailyState;
  log: MoonshotLogEntry[];
  lastCycle: MoonshotLastCycle | null;
  scoreHistogram: number[];
}

export class MoonshotStore {
  private readonly file: string;
  private state: MoonshotStoreState;
  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "moonshot-lottery.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      /* best-effort */
    }
    this.state = this.load();
  }
  private load(): MoonshotStoreState {
    for (const p of [this.file, `${this.file}.bak`]) {
      try {
        if (!existsSync(p)) continue;
        const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<MoonshotStoreState>;
        if (parsed.daily && Array.isArray(parsed.log)) {
          const hist = Array.isArray(parsed.scoreHistogram) && parsed.scoreHistogram.length === MOONSHOT_SCORE_BUCKETS ? parsed.scoreHistogram : emptyHistogram();
          return { version: parsed.version ?? 1, daily: parsed.daily, log: parsed.log, lastCycle: parsed.lastCycle ?? null, scoreHistogram: hist };
        }
      } catch {
        /* fall through */
      }
    }
    return { version: 1, daily: emptyMoonshotDailyState(new Date(0).toISOString().slice(0, 10)), log: [], lastCycle: null, scoreHistogram: emptyHistogram() };
  }
  get daily(): MoonshotDailyState {
    return this.state.daily;
  }
  get log(): MoonshotLogEntry[] {
    return this.state.log;
  }
  get lastCycle(): MoonshotLastCycle | null {
    return this.state.lastCycle;
  }
  recordCycle(c: MoonshotLastCycle): void {
    this.state.lastCycle = c;
  }
  get scoreHistogram(): number[] {
    return this.state.scoreHistogram;
  }
  incScoreBucket(score: number): void {
    const i = Math.max(0, Math.min(MOONSHOT_SCORE_BUCKETS - 1, Math.floor(score / 10)));
    this.state.scoreHistogram[i] = (this.state.scoreHistogram[i] ?? 0) + 1;
  }
  /** Roll the daily counters when the UTC date changes. */
  rollDaily(dateUtc: string): void {
    if (this.state.daily.dateUtc !== dateUtc) this.state.daily = emptyMoonshotDailyState(dateUtc);
  }
  recordSignalTaken(isSniper: boolean, finalLeverage: number): void {
    this.state.daily.tradesToday += 1;
    if (finalLeverage >= 100) this.state.daily.trades100xToday += 1;
    if (finalLeverage >= 50) this.state.daily.trades50xPlusToday += 1;
  }
  appendLog(entry: MoonshotLogEntry): void {
    this.state.log.push(entry);
    if (this.state.log.length > LOG_KEEP) this.state.log = this.state.log.slice(-LOG_KEEP);
  }
  save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
      if (existsSync(this.file)) {
        try {
          copyFileSync(this.file, `${this.file}.bak`);
        } catch {
          /* best-effort */
        }
      }
      renameSync(tmp, this.file);
    } catch {
      /* report-only persistence must never affect the app */
    }
  }
}

let singleton: MoonshotStore | null = null;
export function getMoonshotStore(dataDir = "data"): MoonshotStore {
  if (!singleton) singleton = new MoonshotStore(dataDir);
  return singleton;
}
export function _resetMoonshotStoreForTests(): void {
  singleton = null;
}

// ─── cycle ───────────────────────────────────────────────────────────────────

export interface MoonshotCycleResult {
  scanned: number;
  prefiltered: number;
  signals: number;
  rejects: number;
}

/**
 * MEME-COIN universe for the lottery (2026-07-08 operator: "bikin moonshot lottery fokus di meme
 * coin"): the 100x bursts this lane hunts live in memes, not in the majors/L1 scanner universe.
 * The candidate list is a hand-audited seed of Binance USD-M meme perpetuals — but it is NEVER
 * trusted raw: every cycle uses only the candidates confirmed TRADING by the exchange's own
 * exchangeInfo (the PEPEUSDT-vs-1000PEPEUSDT lesson — a wrong symbol must fail loudly at resolve,
 * not silently forever downstream). Env override: MOONSHOT_MEME_UNIVERSE=comma,separated,symbols.
 */
export const MOONSHOT_DEFAULT_MEME_CANDIDATES = [
  "1000PEPEUSDT",
  "DOGEUSDT",
  "1000SHIBUSDT",
  "1000BONKUSDT",
  "WIFUSDT",
  "1000FLOKIUSDT",
  "MEMEUSDT",
  "BOMEUSDT",
  "POPCATUSDT",
  "PNUTUSDT",
  "NEIROUSDT",
  "MEWUSDT",
  "1000SATSUSDT",
  "1000RATSUSDT",
  "ACTUSDT",
  "GOATUSDT",
  "MOODENGUSDT",
  "TURBOUSDT",
  "DOGSUSDT",
  "1MBABYDOGEUSDT",
  "TRUMPUSDT",
  "FARTCOINUSDT",
  "PENGUUSDT",
  "CHILLGUYUSDT",
] as const;

/** Auto-discovered memes from the new-coin radar (2026-07-08 operator: "harusnya scan meme yang
 *  masih kecil dan belom terkenal, berpotensi terbang" ): every radar coin whose CoinGecko
 *  categories include "Meme" joins the lottery universe automatically — these are BY DEFINITION
 *  new Binance listings (≤120 hari), i.e. the small/viral tier the operator wants. Coins the
 *  radar hasn't enriched yet join as soon as their fundamentals arrive (never guessed). */
function radarMemeSymbols(): string[] {
  try {
    return getNewCoinRadarStore()
      .getState()
      .coins.filter((c) => (c.fundamentals?.categories ?? []).some((cat) => /meme/i.test(cat)))
      .map((c) => c.symbol);
  } catch {
    return []; // radar store unavailable — seed list still covers the established memes
  }
}

function memeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.MOONSHOT_MEME_UNIVERSE ?? "").trim();
  const base = raw.length > 0
    ? raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [...MOONSHOT_DEFAULT_MEME_CANDIDATES];
  return [...new Set([...base, ...radarMemeSymbols()])];
}

let _memeUniverseCache: { resolvedAtMs: number; symbols: string[] } | null = null;
export function _resetMoonshotMemeUniverseCacheForTests(): void {
  _memeUniverseCache = null;
}

/** Candidates ∩ exchangeInfo(TRADING USDT perps). Cached 12h; on fetch failure the last good
 *  resolve is reused; with no cache at all it throws (guarded caller records lastCycleError) —
 *  an unvalidated meme list must never silently scan nothing or scan garbage. */
export async function resolveMoonshotMemeUniverse(opts: {
  nowMs: number;
  fetchJson?: (url: string) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const cacheMs = 12 * 3_600_000;
  if (_memeUniverseCache && opts.nowMs - _memeUniverseCache.resolvedAtMs < cacheMs) {
    return _memeUniverseCache.symbols;
  }
  const fetchJson =
    opts.fetchJson ??
    (async (url: string) => {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.json();
    });
  try {
    const info = (await fetchJson("https://fapi.binance.com/fapi/v1/exchangeInfo")) as {
      symbols?: Array<{ symbol: string; status: string; contractType?: string; quoteAsset?: string }>;
    };
    const trading = new Set(
      (info.symbols ?? [])
        .filter((s) => s.status === "TRADING" && s.contractType === "PERPETUAL" && s.quoteAsset === "USDT")
        .map((s) => s.symbol),
    );
    const candidates = memeCandidates(opts.env);
    const resolved = candidates.filter((s) => trading.has(s));
    const dropped = candidates.filter((s) => !trading.has(s));
    if (dropped.length > 0) {
      console.warn(`[moonshot] meme candidates not TRADING on Binance futures (dropped): ${dropped.join(", ")}`);
    }
    if (resolved.length === 0) throw new Error("meme universe resolved to ZERO trading symbols — refusing to scan");
    _memeUniverseCache = { resolvedAtMs: opts.nowMs, symbols: resolved };
    return resolved;
  } catch (error) {
    if (_memeUniverseCache) return _memeUniverseCache.symbols; // stale-but-validated beats nothing
    throw error;
  }
}

/**
 * One demo cycle: BTC guard once → cheap prefilter → deep-extract top movers → evaluate → LOG every
 * signal/reject. In demo we increment the daily trade counters per emitted SIGNAL (so the per-day caps
 * are exercised), but place NO orders. dailyRealizedLoss stays 0 until the execution phase feeds PnL.
 */
export async function runMoonshotCycle(opts: {
  universe: string[];
  ctx: MoonshotExtractionCtx;
  store: MoonshotStore;
  now: number;
  maxDeepExtract?: number;
}): Promise<MoonshotCycleResult> {
  const result: MoonshotCycleResult = { scanned: 0, prefiltered: 0, signals: 0, rejects: 0 };
  const nowIso = new Date(opts.now).toISOString();
  opts.store.rollDaily(nowIso.slice(0, 10));

  // BTC 1m guard once.
  let btc1mPct = 0;
  try {
    const btc = await opts.ctx.getCandles1m("BTCUSDT", 3);
    if (btc.length >= 2) btc1mPct = pctChange(btc[btc.length - 1]!.close, btc[btc.length - 2]!.close);
  } catch {
    /* BTC guard defaults to 0 (treated as calm) */
  }

  // Cheap prefilter pass across the universe.
  const prelim: Array<{ symbol: string; candles: Candle[]; volRatio: number }> = [];
  for (const symbol of opts.universe) {
    if (symbol === "BTCUSDT") continue;
    result.scanned += 1;
    let candles: Candle[] = [];
    try {
      candles = await opts.ctx.getCandles1m(symbol, 6);
    } catch {
      continue;
    }
    const pf = moonshotPrefilter(candles);
    if (pf.pass) prelim.push({ symbol, candles, volRatio: pf.volRatio });
  }
  // Deep-extract only the strongest movers (rate-limit discipline).
  prelim.sort((a, b) => b.volRatio - a.volRatio);
  const deep = prelim.slice(0, opts.maxDeepExtract ?? MOONSHOT_MAX_DEEP_EXTRACT);
  result.prefiltered = deep.length;

  for (const { symbol, candles } of deep) {
    const features = await extractMoonshotFeatures(symbol, candles, btc1mPct, opts.ctx);
    if (!features) continue;
    const evalResult: MoonshotEvaluation = evaluateMoonshot(features, opts.store.daily);
    opts.store.incScoreBucket(evalResult.moonshotScore); // every deep-extracted candidate feeds the distribution
    const entry: MoonshotLogEntry = {
      ts: nowIso,
      symbol,
      decision: evalResult.decision,
      moonshotScore: Number(evalResult.moonshotScore.toFixed(2)),
      riskScore: Number(evalResult.riskScore.toFixed(2)),
      finalLeverage: evalResult.leverage.finalLeverage,
      isSniper: evalResult.isSniper,
      reasons: evalResult.decision === "SIGNAL" ? (evalResult.signal?.reason ?? []) : evalResult.rejectReasons,
    };
    // Only log rejects that at least cleared the score floor (avoid logging the whole dead universe).
    if (evalResult.decision === "SIGNAL") {
      opts.store.appendLog(entry);
      opts.store.recordSignalTaken(evalResult.isSniper, evalResult.leverage.finalLeverage);
      result.signals += 1;
    } else if (evalResult.moonshotScore >= MOONSHOT_SCORE_MIN - 5) {
      opts.store.appendLog(entry);
      result.rejects += 1;
    }
  }
  opts.store.recordCycle({ ts: nowIso, scanned: result.scanned, prefiltered: result.prefiltered, signals: result.signals, rejects: result.rejects, universe: [...opts.universe] });
  opts.store.save();
  return result;
}

let cycleRunning = false;
export async function runMoonshotCycleGuarded(opts: Parameters<typeof runMoonshotCycle>[0]): Promise<MoonshotCycleResult | null> {
  if (cycleRunning) return null;
  cycleRunning = true;
  try {
    return await runMoonshotCycle(opts);
  } finally {
    cycleRunning = false;
  }
}

export interface MoonshotReport {
  daily: MoonshotDailyState;
  defaultMaxLeverage: number;
  totalLogged: number;
  signals24h: number;
  rejects24h: number;
  lastCycle: MoonshotLastCycle | null;
  /** lastCycle ran but found no bursting movers — the lane is alive, the market is just calm. */
  marketCalm: boolean;
  rejectReasons: Array<{ reason: string; count: number }>;
  /** distribution of moonshot scores across all deep-extracted candidates (10 buckets, 0–100). */
  scoreHistogram: number[];
  recent: MoonshotLogEntry[];
}
export function buildMoonshotReport(store: MoonshotStore, nowMs: number): MoonshotReport {
  const cutoff = nowMs - 24 * 60 * 60_000;
  const recent24 = store.log.filter((e) => new Date(e.ts).getTime() >= cutoff);
  const tally = new Map<string, number>();
  for (const e of store.log.filter((x) => x.decision === "REJECT").slice(-150)) {
    for (const r of e.reasons) {
      const key = r.split(/\s+-?\d/)[0]!.trim() || r; // group "moonshotScore 70 < 82" → "moonshotScore"
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  return {
    daily: store.daily,
    defaultMaxLeverage: MOONSHOT_DEFAULT_MAX_LEVERAGE,
    totalLogged: store.log.length,
    signals24h: recent24.filter((e) => e.decision === "SIGNAL").length,
    rejects24h: recent24.filter((e) => e.decision === "REJECT").length,
    lastCycle: store.lastCycle,
    marketCalm: store.lastCycle != null && store.lastCycle.prefiltered === 0,
    rejectReasons: [...tally.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    scoreHistogram: store.scoreHistogram,
    recent: store.log.slice(-30),
  };
}
