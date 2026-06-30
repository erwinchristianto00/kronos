/**
 * Cross-sectional market-neutral measurement lane (report-only).
 *
 * Each cycle ranks the scanner universe by a cross-sectional MOMENTUM score (N-bar return), then
 * (hypothetically) goes LONG the top-k and SHORT the bottom-k at EQUAL notional, and measures the
 * basket's forward return over a fixed horizon. Equal long/short notional cancels market beta, so
 * the P&L is the cross-sectional DISPERSION — "do the strong outperform the weak?" — which can be
 * positive in BOTH bull and bear. That is the all-weather property the directional lanes lack: you
 * don't need an absolute long edge, only relative (long stronger than short).
 *
 * Report-only like fade-long / h6-trend: NEVER touches the allocator, paper book, or live engine.
 * Env-gated (CROSS_SECTIONAL_EDGE_DISABLED=1). It is a HYPOTHESIS — crypto is highly correlated, so
 * dispersion (the fuel) can collapse in risk-on/off; prove OOS across bull AND bear before any read.
 */
import type { Candle } from "@dtc/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function envNumPos(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envNumNonNeg(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function envSymbolSet(key: string, fallback: string): ReadonlySet<string> {
  const raw = process.env[key] ?? fallback;
  return new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
}

const INTERVAL_MS: Record<string, number> = {
  "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000, "6h": 6 * 60 * 60_000, "1d": 24 * 60 * 60_000,
};

export const CROSS_SECTIONAL_INTERVAL = process.env.CROSS_SECTIONAL_INTERVAL || "1h";
export const CROSS_SECTIONAL_MOMENTUM_BARS = envNumPos("CROSS_SECTIONAL_MOMENTUM_BARS", 24); // ROC lookback
export const CROSS_SECTIONAL_K = envNumPos("CROSS_SECTIONAL_K", 3); // legs per side (long-k / short-k)
export const CROSS_SECTIONAL_HORIZON_BARS = envNumPos("CROSS_SECTIONAL_HORIZON_BARS", 24); // forward hold (bars)
export const CROSS_SECTIONAL_ROUNDTRIP_BPS = Number(process.env.CROSS_SECTIONAL_ROUNDTRIP_BPS ?? 12); // per-position round-trip cost
export const CROSS_SECTIONAL_FILTERED_SIGNAL = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}_FILTERED`;
export const CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP = envNumNonNeg("CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP", 0.02); // 24h momentum spread floor
export const CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS = envNumNonNeg("CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS", 25); // proof target
export const CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST",
  "SOLUSDT,AVAXUSDT,ETHUSDT,SUIUSDT,ADAUSDT,BNBUSDT,RNDRUSDT",
);
export const CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST = envSymbolSet(
  "CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST",
  "WLDUSDT,DOGEUSDT,PEPEUSDT,APTUSDT,OPUSDT,SEIUSDT",
);
export const CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST = envSymbolSet(
  "CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST",
  "FETUSDT,INJUSDT,NEARUSDT",
);
const BAR_MS = INTERVAL_MS[CROSS_SECTIONAL_INTERVAL] ?? INTERVAL_MS["1h"]!;
export const CROSS_SECTIONAL_HORIZON_MS = CROSS_SECTIONAL_HORIZON_BARS * BAR_MS;
const EXPIRY_MS = CROSS_SECTIONAL_HORIZON_MS * 3; // give up on a basket missing prices well past its horizon

export type CrossSectionalStatus = "OPEN" | "CLOSED" | "EXPIRED";
export type CrossSectionalVariant = "RAW" | "FILTERED";

export interface CrossSectionalLeg {
  symbol: string;
  entryPrice: number;
  exitPrice: number | null;
}

export interface CrossSectionalObservation {
  observationId: string;
  openedAt: string;
  openedAtMs: number;
  horizonMs: number;
  signal: string;
  variant?: CrossSectionalVariant;
  k: number;
  longLeg: CrossSectionalLeg[];
  shortLeg: CrossSectionalLeg[];
  status: CrossSectionalStatus;
  scoreGap?: number | null;
  /** Return on deployed capital after market-beta cancels = the cross-sectional dispersion. */
  grossReturn: number | null;
  costReturn: number | null;
  netReturn: number | null;
  longLegReturn: number | null;
  shortLegReturn: number | null;
  resolvedAt: string | null;
}

export interface ScoredSymbol {
  symbol: string;
  score: number;
  price: number;
}

interface CrossSectionalBasketOpts {
  k: number;
  signal: string;
  now: string;
  openedAtMs: number;
  horizonMs: number;
  variant?: CrossSectionalVariant;
  longAllowlist?: ReadonlySet<string> | null;
  shortAllowlist?: ReadonlySet<string> | null;
  shortBlocklist?: ReadonlySet<string> | null;
  minScoreGap?: number;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function allowed(symbol: string, allowlist?: ReadonlySet<string> | null, blocklist?: ReadonlySet<string> | null): boolean {
  const s = symbol.toUpperCase();
  if (blocklist?.has(s)) return false;
  return !allowlist || allowlist.size === 0 || allowlist.has(s);
}

/** N-bar return (ROC) from candles + the latest close. null if not enough history. */
export function crossSectionalMomentumScore(candles: Candle[], bars: number): { score: number; price: number } | null {
  if (!Array.isArray(candles) || candles.length < bars + 1) return null;
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1]!;
  const past = closes[closes.length - 1 - bars]!;
  if (!(price > 0) || !(past > 0)) return null;
  return { score: (price - past) / past, price };
}

/** Rank scored symbols and build an equal-notional long-top-k / short-bottom-k basket. */
export function buildCrossSectionalBasket(
  scored: ScoredSymbol[],
  opts: CrossSectionalBasketOpts,
): CrossSectionalObservation | null {
  const valid = scored.filter((s) => Number.isFinite(s.score) && Number.isFinite(s.price) && s.price > 0);
  const longPool = valid.filter((s) => allowed(s.symbol, opts.longAllowlist));
  const longSorted = [...longPool].sort((a, b) => b.score - a.score); // strongest first
  const selectedLongs = longSorted.slice(0, opts.k);
  const longSymbols = new Set(selectedLongs.map((s) => s.symbol));
  const shortPool = valid.filter((s) => !longSymbols.has(s.symbol) && allowed(s.symbol, opts.shortAllowlist, opts.shortBlocklist));
  const shortSorted = [...shortPool].sort((a, b) => a.score - b.score); // weakest first
  const selectedShorts = shortSorted.slice(0, opts.k);
  if (selectedLongs.length < opts.k || selectedShorts.length < opts.k) return null;
  const scoreGap = selectedLongs[selectedLongs.length - 1]!.score - selectedShorts[selectedShorts.length - 1]!.score;
  if (opts.minScoreGap !== undefined && scoreGap < opts.minScoreGap) return null;
  const toLeg = (s: ScoredSymbol): CrossSectionalLeg => ({ symbol: s.symbol, entryPrice: s.price, exitPrice: null });
  return {
    observationId: `xsec:${opts.signal}:${opts.openedAtMs}`,
    openedAt: opts.now,
    openedAtMs: opts.openedAtMs,
    horizonMs: opts.horizonMs,
    signal: opts.signal,
    variant: opts.variant ?? "RAW",
    k: opts.k,
    longLeg: selectedLongs.map(toLeg),
    shortLeg: selectedShorts.map(toLeg),
    status: "OPEN",
    scoreGap,
    grossReturn: null,
    costReturn: null,
    netReturn: null,
    longLegReturn: null,
    shortLegReturn: null,
    resolvedAt: null,
  };
}

export function buildFilteredCrossSectionalBasket(
  scored: ScoredSymbol[],
  opts: Omit<CrossSectionalBasketOpts, "variant" | "signal" | "longAllowlist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap"> &
    Partial<Pick<CrossSectionalBasketOpts, "signal" | "longAllowlist" | "shortAllowlist" | "shortBlocklist" | "minScoreGap">>,
): CrossSectionalObservation | null {
  return buildCrossSectionalBasket(scored, {
    ...opts,
    signal: opts.signal ?? CROSS_SECTIONAL_FILTERED_SIGNAL,
    variant: "FILTERED",
    longAllowlist: opts.longAllowlist ?? CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST,
    shortAllowlist: opts.shortAllowlist ?? CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST,
    shortBlocklist: opts.shortBlocklist ?? CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST,
    minScoreGap: opts.minScoreGap ?? CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP,
  });
}

/**
 * Resolve a matured basket given current prices. Market-neutral return on deployed capital =
 * (meanLongPnL + meanShortPnL) / 2, where long pnl = (exit−entry)/entry and short pnl =
 * (entry−exit)/entry. A uniform market move cancels (long gains it, short loses it); the residual
 * is the dispersion. Untouched until horizon; EXPIRED if prices stay missing past EXPIRY_MS.
 */
export function resolveCrossSectional(
  obs: CrossSectionalObservation,
  pricesBySymbol: Record<string, number>,
  now: string,
  roundtripBps: number,
): CrossSectionalObservation {
  if (obs.status !== "OPEN") return obs;
  const ageMs = new Date(now).getTime() - obs.openedAtMs;
  if (ageMs < obs.horizonMs) return obs;

  const all = [...obs.longLeg, ...obs.shortLeg];
  const price = (s: string): number | null => {
    const p = pricesBySymbol[s];
    return Number.isFinite(p) && p > 0 ? p : null;
  };
  if (!all.every((l) => price(l.symbol) !== null)) {
    return ageMs > EXPIRY_MS ? { ...obs, status: "EXPIRED", resolvedAt: now } : obs;
  }

  const longLeg = obs.longLeg.map((l) => ({ ...l, exitPrice: price(l.symbol)! }));
  const shortLeg = obs.shortLeg.map((l) => ({ ...l, exitPrice: price(l.symbol)! }));
  const longLegReturn = mean(longLeg.map((l) => (l.exitPrice - l.entryPrice) / l.entryPrice));
  const shortLegReturn = mean(shortLeg.map((l) => (l.entryPrice - l.exitPrice) / l.entryPrice));
  const grossReturn = (longLegReturn + shortLegReturn) / 2;
  const costReturn = roundtripBps / 10_000;
  return {
    ...obs,
    longLeg,
    shortLeg,
    status: "CLOSED",
    grossReturn,
    costReturn,
    netReturn: grossReturn - costReturn,
    longLegReturn,
    shortLegReturn,
    resolvedAt: now,
  };
}

// ─── store ───────────────────────────────────────────────────────────────────

interface CrossSectionalState {
  version: number;
  observations: CrossSectionalObservation[];
  lastCycleAt: string | null;
}

export class CrossSectionalStore {
  private readonly file: string;
  private state: CrossSectionalState;

  constructor(dataDir = "data") {
    this.file = resolve(dataDir, "cross-sectional-edge.json");
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this.load();
  }

  private load(): CrossSectionalState {
    for (const path of [this.file, `${this.file}.bak`]) {
      try {
        if (!existsSync(path)) continue;
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CrossSectionalState>;
        if (Array.isArray(parsed.observations)) {
          return { version: parsed.version ?? 1, observations: parsed.observations, lastCycleAt: parsed.lastCycleAt ?? null };
        }
      } catch {
        // fall through to the next candidate / empty
      }
    }
    return { version: 1, observations: [], lastCycleAt: null };
  }

  get all(): CrossSectionalObservation[] {
    return this.state.observations;
  }

  get lastCycleAt(): string | null {
    return this.state.lastCycleAt;
  }

  markCycle(ts: string): void {
    this.state.lastCycleAt = ts;
  }

  add(obs: CrossSectionalObservation): void {
    this.state.observations.push(obs);
  }

  replace(observationId: string, next: CrossSectionalObservation): void {
    const idx = this.state.observations.findIndex((o) => o.observationId === observationId);
    if (idx >= 0) this.state.observations[idx] = next;
  }

  save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
      if (existsSync(this.file)) {
        try {
          copyFileSync(this.file, `${this.file}.bak`);
        } catch {
          // best-effort backup
        }
      }
      renameSync(tmp, this.file);
    } catch {
      // report-only persistence failures must never affect the app
    }
  }
}

let singleton: CrossSectionalStore | null = null;
export function getCrossSectionalStore(dataDir = "data"): CrossSectionalStore {
  if (!singleton) singleton = new CrossSectionalStore(dataDir);
  return singleton;
}
export function _resetCrossSectionalStoreForTests(): void {
  singleton = null;
}

// ─── cycle ─────────────────────────────────────────────────────────────────

export interface CrossSectionalCycleResult {
  opened: number;
  openedRaw?: number;
  openedFiltered?: number;
  resolved: number;
  expired: number;
}

/**
 * One measurement cycle: fetch the universe once, resolve matured open baskets against the latest
 * closes, then open at most one new basket per interval bucket. Pure data accrual — report-only.
 */
export async function runCrossSectionalCycle(opts: {
  store: CrossSectionalStore;
  universe: string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
}): Promise<CrossSectionalCycleResult> {
  const result: CrossSectionalCycleResult = { opened: 0, resolved: 0, expired: 0 };
  const nowIso = new Date(opts.now).toISOString();

  const candlesBySymbol: Record<string, Candle[]> = {};
  await Promise.allSettled(
    opts.universe.map(async (s) => {
      try {
        candlesBySymbol[s] = await opts.fetchCandles(s);
      } catch {
        // a missing symbol just drops out of this cycle
      }
    }),
  );

  const pricesBySymbol: Record<string, number> = {};
  const scored: ScoredSymbol[] = [];
  for (const symbol of opts.universe) {
    const candles = candlesBySymbol[symbol];
    if (!candles?.length) continue;
    const last = candles[candles.length - 1]!;
    if (last.close > 0) pricesBySymbol[symbol] = last.close;
    const sc = crossSectionalMomentumScore(candles, CROSS_SECTIONAL_MOMENTUM_BARS);
    if (sc) scored.push({ symbol, score: sc.score, price: sc.price });
  }

  // 1. resolve matured open baskets against the latest closes
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const next = resolveCrossSectional(obs, pricesBySymbol, nowIso, CROSS_SECTIONAL_ROUNDTRIP_BPS);
    if (next.status !== obs.status) {
      opts.store.replace(obs.observationId, next);
      if (next.status === "CLOSED") result.resolved += 1;
      else if (next.status === "EXPIRED") result.expired += 1;
    }
  }

  // 2. open at most ONE new basket per interval bucket (the 7-min ticker fires faster than the bars)
  const bucket = Math.floor(opts.now / BAR_MS);
  const alreadyThisBucket = (signal: string) => opts.store.all.some((o) => o.signal === signal && Math.floor(o.openedAtMs / BAR_MS) === bucket);
  const rawSignal = `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}`;
  if (!alreadyThisBucket(rawSignal)) {
    const basket = buildCrossSectionalBasket(scored, {
      k: CROSS_SECTIONAL_K,
      signal: rawSignal,
      variant: "RAW",
      now: nowIso,
      openedAtMs: opts.now,
      horizonMs: CROSS_SECTIONAL_HORIZON_MS,
    });
    if (basket) {
      opts.store.add(basket);
      result.opened += 1;
      result.openedRaw = (result.openedRaw ?? 0) + 1;
    }
  }
  if (!isCrossSectionalFilteredDisabled() && !alreadyThisBucket(CROSS_SECTIONAL_FILTERED_SIGNAL)) {
    const basket = buildFilteredCrossSectionalBasket(scored, {
      k: CROSS_SECTIONAL_K,
      now: nowIso,
      openedAtMs: opts.now,
      horizonMs: CROSS_SECTIONAL_HORIZON_MS,
    });
    if (basket) {
      opts.store.add(basket);
      result.opened += 1;
      result.openedFiltered = (result.openedFiltered ?? 0) + 1;
    }
  }

  opts.store.markCycle(nowIso);
  opts.store.save();
  return result;
}

let cycleRunning = false;
/** Overlap-guarded wrapper so the 7-min ticker can't stack two cycles on the singleton store. */
export async function runCrossSectionalCycleGuarded(opts: {
  store: CrossSectionalStore;
  universe: string[];
  now: number;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
}): Promise<CrossSectionalCycleResult | null> {
  if (cycleRunning) return null;
  cycleRunning = true;
  try {
    return await runCrossSectionalCycle(opts);
  } finally {
    cycleRunning = false;
  }
}

// ─── report ────────────────────────────────────────────────────────────────

export interface CrossSectionalReport {
  signal: string;
  variant: CrossSectionalVariant;
  horizonBars: number;
  k: number;
  open: number;
  closed: number;
  expired: number;
  netAvgReturn: number;
  grossAvgReturn: number;
  winRate: number;
  totalNetReturn: number;
  sharpeLike: number | null; // mean/stdev of net returns (per-basket), not annualized
  longLegAvgReturn: number;
  shortLegAvgReturn: number;
  lastCycleAt: string | null;
  /** ms until the OLDEST open basket reaches its horizon (when the first "closed" appears). null if none open. */
  nextResolveInMs: number | null;
  /** the net returns of recent closed baskets, for a distribution sparkline. */
  recentNetReturns: number[];
  targetGrossReturn: number;
  edgeReady: boolean;
}

function observationVariant(o: Pick<CrossSectionalObservation, "variant" | "signal">): CrossSectionalVariant {
  return o.variant === "FILTERED" || o.signal === CROSS_SECTIONAL_FILTERED_SIGNAL ? "FILTERED" : "RAW";
}

export function buildCrossSectionalReport(
  store: CrossSectionalStore,
  nowMs: number = Date.now(),
  opts: { variant?: CrossSectionalVariant; signal?: string } = {},
): CrossSectionalReport {
  const variant = opts.variant ?? (opts.signal === CROSS_SECTIONAL_FILTERED_SIGNAL ? "FILTERED" : "RAW");
  const all = store.all.filter((o) => opts.signal ? o.signal === opts.signal : observationVariant(o) === variant);
  const closed = all.filter((o) => o.status === "CLOSED" && o.netReturn !== null);
  const nets = closed.map((o) => o.netReturn!);
  const gross = closed.map((o) => o.grossReturn ?? 0);
  const m = mean(nets);
  const sd = nets.length > 1 ? Math.sqrt(mean(nets.map((x) => (x - m) ** 2))) : 0;
  const grossAvg = mean(gross);
  const targetGrossReturn = (variant === "FILTERED" ? CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS : CROSS_SECTIONAL_ROUNDTRIP_BPS) / 10_000;
  const openRemaining = all
    .filter((o) => o.status === "OPEN")
    .map((o) => Math.max(0, o.openedAtMs + o.horizonMs - nowMs));
  return {
    lastCycleAt: store.lastCycleAt,
    nextResolveInMs: openRemaining.length ? Math.min(...openRemaining) : null,
    recentNetReturns: nets.slice(-30),
    signal: opts.signal ?? (variant === "FILTERED" ? CROSS_SECTIONAL_FILTERED_SIGNAL : `MOM${CROSS_SECTIONAL_MOMENTUM_BARS}`),
    variant,
    horizonBars: CROSS_SECTIONAL_HORIZON_BARS,
    k: CROSS_SECTIONAL_K,
    open: all.filter((o) => o.status === "OPEN").length,
    closed: closed.length,
    expired: all.filter((o) => o.status === "EXPIRED").length,
    netAvgReturn: m,
    grossAvgReturn: grossAvg,
    winRate: closed.length ? closed.filter((o) => o.netReturn! > 0).length / closed.length : 0,
    totalNetReturn: nets.reduce((a, b) => a + b, 0),
    sharpeLike: sd > 0 ? m / sd : null,
    longLegAvgReturn: mean(closed.map((o) => o.longLegReturn ?? 0)),
    shortLegAvgReturn: mean(closed.map((o) => o.shortLegReturn ?? 0)),
    targetGrossReturn,
    edgeReady: closed.length >= 20 && grossAvg >= targetGrossReturn && m > 0,
  };
}

export function isCrossSectionalEdgeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_EDGE_DISABLED === "1";
}

export function isCrossSectionalFilteredDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_FILTERED_DISABLED === "1";
}

export function getCrossSectionalFilteredConfig(): {
  signal: string;
  minScoreGap: number;
  targetGrossReturn: number;
  longAllowlist: string[];
  shortAllowlist: string[];
  shortBlocklist: string[];
} {
  return {
    signal: CROSS_SECTIONAL_FILTERED_SIGNAL,
    minScoreGap: CROSS_SECTIONAL_FILTERED_MIN_SCORE_GAP,
    targetGrossReturn: CROSS_SECTIONAL_FILTERED_MIN_GROSS_BPS / 10_000,
    longAllowlist: [...CROSS_SECTIONAL_FILTERED_LONG_ALLOWLIST].sort(),
    shortAllowlist: [...CROSS_SECTIONAL_FILTERED_SHORT_ALLOWLIST].sort(),
    shortBlocklist: [...CROSS_SECTIONAL_FILTERED_SHORT_BLOCKLIST].sort(),
  };
}
