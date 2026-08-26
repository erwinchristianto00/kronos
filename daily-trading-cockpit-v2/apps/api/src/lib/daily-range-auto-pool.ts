/**
 * Auto-discovered, execution-grade universe for the isolated Testnet Daily Range lane.
 *
 * This deliberately does not reuse the Dynamic MOM36/Cross-Sectional pool. Binance USD-M is a
 * one-way netted account, so a symbol that a basket can own must never quietly become eligible for
 * the Daily Range lane as well. The pool is rebuilt from public USD-M perpetual metadata and then
 * filtered by the Daily lane's C1-C6 contract.
 *
 * Missing public evidence is a rejection, never a default pass. Existing Daily trades retain their
 * immutable UTC-day snapshot and native exchange brackets; this module only affects a later day.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DAILY_RANGE_AUTO_POOL_VERSION = 2;
export const DAILY_RANGE_AUTO_POOL_MIN_SYMBOLS = 8;
export const DAILY_RANGE_TARGET_LIQUIDITY_24H_USD = 20_000_000;
export const DAILY_RANGE_LIQUIDITY_HYSTERESIS = 0.10;
export const DAILY_RANGE_MAX_MIN_NOTIONAL_USD = 25;
export const DAILY_RANGE_MAX_MIN_QTY_NOTIONAL_USD = 25;
export const DAILY_RANGE_MAX_STEP_NOTIONAL_USD = 2.5;
export const DAILY_RANGE_MEDIAN_SPREAD_MAX_BPS = 5;
export const DAILY_RANGE_HARD_SPREAD_MAX_BPS = 10;
export const DAILY_RANGE_MIN_LISTING_DAYS = 60;

const MAINNET_USDM = "https://fapi.binance.com";
const DAY_MS = 86_400_000;
const FIVE_MIN_MS = 5 * 60_000;
const FOUR_HOURS_MS = 4 * 60 * 60_000;
const DEFAULT_REFRESH_MS = 5 * 60_000;
const DEFAULT_MAX_DATA_AGE_MS = 10 * 60_000;
const STALE_RETRY_FLOOR_MS = 60_000;
const SPREAD_SAMPLE_COUNT = 3;
const DEFAULT_SPREAD_SAMPLE_DELAY_MS = 1_000;
const SPREAD_HISTORY_LIMIT = 12;
const SPREAD_HISTORY_MAX_AGE_MS = 6 * 60 * 60_000;
const KLINE_CONCURRENCY = 6;
const FIVE_MIN_COMPLETED_BARS = 12;
const FOUR_HOUR_COMPLETED_BARS = 3;
const FIVE_MIN_FRESHNESS_MS = 10 * 60_000;
const FOUR_HOUR_FRESHNESS_MS = 8 * 60 * 60_000;

export type DailyRangeAutoPoolState = "DISABLED" | "ACTIVE" | "INSUFFICIENT_ELIGIBLE" | "STALE_DATA";
export type DailyRangePoolFailure =
  | "C1_MIN_NOTIONAL"
  | "C1_MIN_QTY_NOTIONAL"
  | "C1_STEP_NOTIONAL"
  | "C1_EXECUTABILITY_UNMEASURED"
  | "C2_LIQUIDITY"
  | "C3_SPREAD_UNMEASURED"
  | "C3_MEDIAN_SPREAD"
  | "C3_HARD_SPREAD"
  | "C4_5M_DATA"
  | "C4_4H_DATA"
  | "C5_LISTING_AGE"
  | "C6_CROSS_SECTIONAL_OVERLAP"
  | "C6_STRATEGY_POSITION"
  | "EXCHANGE_SYMBOL_UNAVAILABLE";

export interface DailyRangeAutoPoolInput {
  /** Every symbol the cross-sectional strategy may select, not just an active basket. */
  crossSectionalUniverse: readonly string[];
  /** Symbols currently owned by a non-Daily strategy in the shared one-way-netted account. */
  strategyOwnedSymbols: readonly string[];
}

export interface DailyRangePoolSymbolAudit {
  symbol: string;
  eligible: boolean;
  failures: DailyRangePoolFailure[];
  quoteVolume24hUsd: number | null;
  minNotionalUsd: number | null;
  minQtyNotionalUsd: number | null;
  stepNotionalUsd: number | null;
  listedDays: number | null;
  medianSpreadBps: number | null;
  maxObservedSpreadBps: number | null;
  fiveMinuteData: "OK" | "MISSING" | "STALE" | "GAPPED";
  fourHourData: "OK" | "MISSING" | "STALE" | "GAPPED";
}

export interface DailyRangeAutoPoolSnapshot {
  version: number;
  enabled: boolean;
  state: DailyRangeAutoPoolState;
  source: "BINANCE_USDM_MAINNET_PUBLIC" | null;
  activeSymbols: string[];
  updatedAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  refreshEveryMs: number;
  thresholds: {
    minNotionalUsd: number;
    maxMinQtyNotionalUsd: number;
    maxStepNotionalUsd: number;
    targetLiquidity24hUsd: number;
    liquidityEnter24hUsd: number;
    liquidityLeave24hUsd: number;
    liquidityHysteresisFraction: number;
    medianSpreadMaxBps: number;
    hardSpreadMaxBps: number;
    minListingDays: number;
    fiveMinuteFreshnessMs: number;
    fourHourFreshnessMs: number;
  };
  reconciliation: {
    changed: boolean;
    adds: string[];
    drops: string[];
    exchangePerpetualCandidates: number;
    eligibleCount: number;
    rejectionCounts: Partial<Record<DailyRangePoolFailure, number>>;
    crossSectionalExcluded: string[];
    strategyOwnedExcluded: string[];
  } | null;
}

/**
 * Immutable copy of the exact C1-C6 evidence which supplied a Daily UTC-day
 * universe.  The operational pool is deliberately refreshed often; research
 * must not silently substitute a later rolling audit for the one known when a
 * symbol became eligible.
 */
export interface DailyRangePoolEvidence {
  schemaVersion: 1;
  poolVersion: number;
  state: DailyRangeAutoPoolState;
  source: DailyRangeAutoPoolSnapshot["source"];
  /** Timestamp of the successful public-market read, not the later day freeze. */
  capturedAt: string | null;
  activeSymbols: string[];
  thresholds: DailyRangeAutoPoolSnapshot["thresholds"];
  reconciliation: DailyRangeAutoPoolSnapshot["reconciliation"];
  /** C1-C6 values for the symbols actually frozen into the day universe only. */
  auditBySymbol: Record<string, DailyRangePoolSymbolAudit>;
  /** Never guessed: makes a partial audit explicit without changing entry behavior. */
  missingAuditSymbols: string[];
}

interface SpreadSample {
  atMs: number;
  bps: number;
}

interface PersistedState {
  version: number;
  activeSymbols: string[];
  updatedAtMs: number | null;
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastError: string | null;
  reconciliation: DailyRangeAutoPoolSnapshot["reconciliation"];
  spreadSamples: Record<string, SpreadSample[]>;
  audit: Record<string, DailyRangePoolSymbolAudit>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

interface Candidate {
  symbol: string;
  minNotionalUsd: number | null;
  minQty: number | null;
  stepSize: number | null;
  price: number | null;
  quoteVolume24hUsd: number | null;
  listedDays: number | null;
}

interface KlineQuality {
  state: "OK" | "MISSING" | "STALE" | "GAPPED";
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : null;

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function normalizeSymbols(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()).filter(Boolean))].sort();
}

function iso(ms: number | null): string | null {
  return ms !== null && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function positiveMs(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : fallback;
}

function isEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.DAILY_RANGE_AUTO_POOL_ENABLED === "1";
}

function median(values: readonly number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] ?? null : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function emptyState(): PersistedState {
  return {
    version: DAILY_RANGE_AUTO_POOL_VERSION,
    activeSymbols: [],
    updatedAtMs: null,
    lastAttemptAtMs: null,
    lastSuccessAtMs: null,
    lastError: null,
    reconciliation: null,
    spreadSamples: {},
    audit: {},
  };
}

function defaultAudit(symbol: string): DailyRangePoolSymbolAudit {
  return {
    symbol,
    eligible: false,
    failures: [],
    quoteVolume24hUsd: null,
    minNotionalUsd: null,
    minQtyNotionalUsd: null,
    stepNotionalUsd: null,
    listedDays: null,
    medianSpreadBps: null,
    maxObservedSpreadBps: null,
    fiveMinuteData: "MISSING",
    fourHourData: "MISSING",
  };
}

function cloneAudit(audit: DailyRangePoolSymbolAudit): DailyRangePoolSymbolAudit {
  return { ...audit, failures: [...audit.failures] };
}

function cloneReconciliation(
  reconciliation: DailyRangeAutoPoolSnapshot["reconciliation"],
): DailyRangeAutoPoolSnapshot["reconciliation"] {
  if (!reconciliation) return null;
  return {
    ...reconciliation,
    adds: [...reconciliation.adds],
    drops: [...reconciliation.drops],
    rejectionCounts: { ...reconciliation.rejectionCounts },
    crossSectionalExcluded: [...reconciliation.crossSectionalExcluded],
    strategyOwnedExcluded: [...reconciliation.strategyOwnedExcluded],
  };
}

function safeAudit(value: unknown): DailyRangePoolSymbolAudit | null {
  const row = asRecord(value);
  if (!row || typeof row.symbol !== "string" || typeof row.eligible !== "boolean" || !Array.isArray(row.failures)) return null;
  const failures = row.failures.filter((failure): failure is DailyRangePoolFailure => typeof failure === "string");
  const dataState = (raw: unknown): "OK" | "MISSING" | "STALE" | "GAPPED" =>
    raw === "OK" || raw === "MISSING" || raw === "STALE" || raw === "GAPPED" ? raw : "MISSING";
  return {
    symbol: row.symbol.toUpperCase(),
    eligible: row.eligible,
    failures,
    quoteVolume24hUsd: finite(row.quoteVolume24hUsd),
    minNotionalUsd: finite(row.minNotionalUsd),
    minQtyNotionalUsd: finite(row.minQtyNotionalUsd),
    stepNotionalUsd: finite(row.stepNotionalUsd),
    listedDays: finite(row.listedDays),
    medianSpreadBps: finite(row.medianSpreadBps),
    maxObservedSpreadBps: finite(row.maxObservedSpreadBps),
    fiveMinuteData: dataState(row.fiveMinuteData),
    fourHourData: dataState(row.fourHourData),
  };
}

/**
 * Candidate discovery happens from current Binance metadata. There is deliberately no manual
 * DAILY_RANGE_AUTO_POOL_CANDIDATES override and no static fallback catalog.
 */
export function resolveDailyRangeAutoPoolInput(
  crossSectionalUniverse: readonly string[],
  strategyOwnedSymbols: readonly string[] = [],
): DailyRangeAutoPoolInput {
  return {
    crossSectionalUniverse: normalizeSymbols(crossSectionalUniverse),
    strategyOwnedSymbols: normalizeSymbols(strategyOwnedSymbols),
  };
}

/**
 * Dedicated implementation instead of a parametrized CrossSectionalAutoPool. The Daily lane has
 * spread, candle-quality, listing-age, and ownership rules that a C1/C2 basket pool cannot supply.
 */
export class DailyRangeAutoPool {
  private readonly file: string;
  private readonly fetchImpl: FetchLike;
  private readonly nowMs: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spreadSampleDelayMs: number;
  private state: PersistedState;
  private inFlight: Promise<DailyRangeAutoPoolSnapshot> | null = null;

  constructor(opts: {
    dataDir?: string;
    fileName?: string;
    fetchImpl?: FetchLike;
    nowMs?: () => number;
    env?: NodeJS.ProcessEnv;
    spreadSampleDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}) {
    this.file = resolve(opts.dataDir ?? "data", opts.fileName ?? "daily-range-auto-pool.json");
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.env = opts.env ?? process.env;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
    this.spreadSampleDelayMs = Math.max(0, Math.round(opts.spreadSampleDelayMs ?? DEFAULT_SPREAD_SAMPLE_DELAY_MS));
    this.state = this.read();
  }

  refreshEveryMs(): number {
    return positiveMs(this.env.DAILY_RANGE_AUTO_POOL_REFRESH_MS, DEFAULT_REFRESH_MS);
  }

  /** Status only; never sends an exchange request. */
  getSnapshot(input: DailyRangeAutoPoolInput): DailyRangeAutoPoolSnapshot {
    const now = this.nowMs();
    const crossSet = new Set(normalizeSymbols(input.crossSectionalUniverse));
    const ownedSet = new Set(normalizeSymbols(input.strategyOwnedSymbols));
    const fresh = this.state.lastSuccessAtMs !== null && now - this.state.lastSuccessAtMs <= DEFAULT_MAX_DATA_AGE_MS;
    const effectiveSymbols = fresh && isEnabled(this.env)
      ? normalizeSymbols(this.state.activeSymbols).filter((symbol) => !crossSet.has(symbol) && !ownedSet.has(symbol))
      : [];
    const state: DailyRangeAutoPoolState = !isEnabled(this.env)
      ? "DISABLED"
      : !fresh
        ? "STALE_DATA"
        : effectiveSymbols.length >= DAILY_RANGE_AUTO_POOL_MIN_SYMBOLS
          ? "ACTIVE"
          : "INSUFFICIENT_ELIGIBLE";
    const activeSymbols = state === "ACTIVE" ? effectiveSymbols : [];
    const enter = DAILY_RANGE_TARGET_LIQUIDITY_24H_USD * (1 + DAILY_RANGE_LIQUIDITY_HYSTERESIS);
    const leave = DAILY_RANGE_TARGET_LIQUIDITY_24H_USD * (1 - DAILY_RANGE_LIQUIDITY_HYSTERESIS);
    return {
      version: DAILY_RANGE_AUTO_POOL_VERSION,
      enabled: isEnabled(this.env),
      state,
      source: isEnabled(this.env) ? "BINANCE_USDM_MAINNET_PUBLIC" : null,
      activeSymbols,
      updatedAt: iso(this.state.updatedAtMs),
      lastAttemptAt: iso(this.state.lastAttemptAtMs),
      lastSuccessAt: iso(this.state.lastSuccessAtMs),
      lastError: this.state.lastError,
      refreshEveryMs: this.refreshEveryMs(),
      thresholds: {
        minNotionalUsd: DAILY_RANGE_MAX_MIN_NOTIONAL_USD,
        maxMinQtyNotionalUsd: DAILY_RANGE_MAX_MIN_QTY_NOTIONAL_USD,
        maxStepNotionalUsd: DAILY_RANGE_MAX_STEP_NOTIONAL_USD,
        targetLiquidity24hUsd: DAILY_RANGE_TARGET_LIQUIDITY_24H_USD,
        liquidityEnter24hUsd: enter,
        liquidityLeave24hUsd: leave,
        liquidityHysteresisFraction: DAILY_RANGE_LIQUIDITY_HYSTERESIS,
        medianSpreadMaxBps: DAILY_RANGE_MEDIAN_SPREAD_MAX_BPS,
        hardSpreadMaxBps: DAILY_RANGE_HARD_SPREAD_MAX_BPS,
        minListingDays: DAILY_RANGE_MIN_LISTING_DAYS,
        fiveMinuteFreshnessMs: FIVE_MIN_FRESHNESS_MS,
        fourHourFreshnessMs: FOUR_HOUR_FRESHNESS_MS,
      },
      reconciliation: cloneReconciliation(this.state.reconciliation),
    };
  }

  /**
   * Produces a detached, compact proof of the pool read used for one frozen
   * Daily universe.  It performs no network access and never feeds a ranking
   * or selection result back into the live lane.
   */
  getEvidence(
    input: DailyRangeAutoPoolInput,
    snapshot: DailyRangeAutoPoolSnapshot = this.getSnapshot(input),
  ): DailyRangePoolEvidence {
    const activeSymbols = normalizeSymbols(snapshot.activeSymbols);
    const auditBySymbol: Record<string, DailyRangePoolSymbolAudit> = {};
    const missingAuditSymbols: string[] = [];
    for (const symbol of activeSymbols) {
      const audit = this.state.audit[symbol];
      if (audit) auditBySymbol[symbol] = cloneAudit(audit);
      else missingAuditSymbols.push(symbol);
    }
    return {
      schemaVersion: 1,
      poolVersion: snapshot.version,
      state: snapshot.state,
      source: snapshot.source,
      capturedAt: snapshot.lastSuccessAt,
      activeSymbols,
      thresholds: { ...snapshot.thresholds },
      reconciliation: cloneReconciliation(snapshot.reconciliation),
      auditBySymbol,
      missingAuditSymbols,
    };
  }

  async refreshIfDue(input: DailyRangeAutoPoolInput): Promise<DailyRangeAutoPoolSnapshot> {
    const baseline = this.getSnapshot(input);
    if (!baseline.enabled) return baseline;
    if (this.inFlight) return this.inFlight;
    const now = this.nowMs();
    // A data-quality pool may not wait out normal cadence while stale. The next lane tick attempts
    // a new read rather than freezing tomorrow's daily universe from old candle evidence.
    if (baseline.state !== "STALE_DATA" && this.state.lastAttemptAtMs !== null && now - this.state.lastAttemptAtMs < baseline.refreshEveryMs) {
      return baseline;
    }
    // Fail closed while stale, but do not turn an upstream 418/timeout into a 30-second burst of
    // metadata plus kline requests. The normal 5m cadence resumes immediately after a good read.
    if (baseline.state === "STALE_DATA" && this.state.lastAttemptAtMs !== null && now - this.state.lastAttemptAtMs < STALE_RETRY_FLOOR_MS) {
      return baseline;
    }
    this.inFlight = this.refresh(input, now).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async refresh(input: DailyRangeAutoPoolInput, now: number): Promise<DailyRangeAutoPoolSnapshot> {
    this.state.lastAttemptAtMs = now;
    try {
      const results = await Promise.all([
        this.fetchJson(MAINNET_USDM + "/fapi/v1/exchangeInfo"),
        this.fetchJson(MAINNET_USDM + "/fapi/v1/ticker/24hr"),
        this.collectBookSamples(),
      ]);
      const candidates = this.parseCandidates(results[0], results[1], now);
      if (candidates.length === 0) throw new Error("Binance USD-M returned no TRADING USDT perpetual candidates");

      const crossSet = new Set(normalizeSymbols(input.crossSectionalUniverse));
      const ownedSet = new Set(normalizeSymbols(input.strategyOwnedSymbols));
      const priorActive = new Set(normalizeSymbols(this.state.activeSymbols));
      const audits = new Map<string, DailyRangePoolSymbolAudit>();
      const preliminary: Candidate[] = [];

      for (const candidate of candidates) {
        const audit = defaultAudit(candidate.symbol);
        audit.quoteVolume24hUsd = candidate.quoteVolume24hUsd;
        audit.minNotionalUsd = candidate.minNotionalUsd;
        audit.minQtyNotionalUsd = candidate.minQty !== null && candidate.price !== null ? candidate.minQty * candidate.price : null;
        audit.stepNotionalUsd = candidate.stepSize !== null && candidate.price !== null ? candidate.stepSize * candidate.price : null;
        audit.listedDays = candidate.listedDays;
        if (crossSet.has(candidate.symbol)) audit.failures.push("C6_CROSS_SECTIONAL_OVERLAP");
        if (ownedSet.has(candidate.symbol)) audit.failures.push("C6_STRATEGY_POSITION");
        this.applyC1(audit);
        this.applyC2(audit, priorActive.has(candidate.symbol));
        this.applyC5(audit);
        if (audit.failures.length === 0) preliminary.push(candidate);
        audits.set(candidate.symbol, audit);
      }

      this.applySpreadEvidence(preliminary, audits, results[2], now);
      const qualityCandidates = preliminary.filter((candidate) => (audits.get(candidate.symbol)?.failures.length ?? 1) === 0);
      const qualityRows = await mapLimited(
        qualityCandidates,
        KLINE_CONCURRENCY,
        async (candidate) => [candidate.symbol, await this.fetchDataQuality(candidate.symbol, now)] as const,
      );
      for (const [symbol, quality] of qualityRows) {
        const audit = audits.get(symbol);
        if (!audit) continue;
        audit.fiveMinuteData = quality.fiveMinute.state;
        audit.fourHourData = quality.fourHour.state;
        if (quality.fiveMinute.state !== "OK") audit.failures.push("C4_5M_DATA");
        if (quality.fourHour.state !== "OK") audit.failures.push("C4_4H_DATA");
      }

      const candidateSet = new Set(candidates.map((candidate) => candidate.symbol));
      for (const symbol of priorActive) {
        if (candidateSet.has(symbol)) continue;
        const audit = defaultAudit(symbol);
        audit.failures.push("EXCHANGE_SYMBOL_UNAVAILABLE");
        audits.set(symbol, audit);
      }

      const eligible = [...audits.values()].filter((audit) => audit.failures.length === 0).map((audit) => audit.symbol).sort();
      const prior = [...priorActive].sort();
      const eligibleSet = new Set(eligible);
      const adds = eligible.filter((symbol) => !priorActive.has(symbol));
      const drops = prior.filter((symbol) => !eligibleSet.has(symbol));
      const rejectionCounts: Partial<Record<DailyRangePoolFailure, number>> = {};
      for (const audit of audits.values()) {
        audit.eligible = audit.failures.length === 0;
        for (const failure of audit.failures) rejectionCounts[failure] = (rejectionCounts[failure] ?? 0) + 1;
      }

      this.state.activeSymbols = eligible;
      this.state.updatedAtMs = now;
      this.state.lastSuccessAtMs = now;
      this.state.lastError = null;
      this.state.audit = Object.fromEntries([...audits.entries()].sort(([a], [b]) => a.localeCompare(b)));
      this.state.reconciliation = {
        changed: adds.length > 0 || drops.length > 0,
        adds,
        drops,
        exchangePerpetualCandidates: candidates.length,
        eligibleCount: eligible.length,
        rejectionCounts,
        crossSectionalExcluded: [...crossSet].filter((symbol) => candidateSet.has(symbol)).sort(),
        strategyOwnedExcluded: [...ownedSet].filter((symbol) => candidateSet.has(symbol)).sort(),
      };
      this.persist();
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error);
      // Do not replace a failed read with the old 10-symbol catalog. Once the short freshness
      // lease expires getSnapshot returns STALE_DATA and Daily Range fails closed for a new day.
      this.persist();
    }
    return this.getSnapshot(input);
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("public USD-M request failed for " + new URL(url).pathname);
    return response.json();
  }

  private parseCandidates(exchangeInfo: unknown, tickerPayload: unknown, now: number): Candidate[] {
    const info = asRecord(exchangeInfo);
    if (!info || !Array.isArray(info.symbols) || !Array.isArray(tickerPayload)) {
      throw new Error("public USD-M exchangeInfo/ticker payload shape is invalid");
    }
    const tickers = new Map<string, { price: number | null; quoteVolume24hUsd: number | null }>();
    for (const raw of tickerPayload) {
      const row = asRecord(raw);
      if (!row || typeof row.symbol !== "string") continue;
      tickers.set(row.symbol.toUpperCase(), {
        price: positive(row.lastPrice),
        quoteVolume24hUsd: positive(row.quoteVolume),
      });
    }
    const candidates: Candidate[] = [];
    for (const raw of info.symbols) {
      const row = asRecord(raw);
      if (!row || row.status !== "TRADING" || row.contractType !== "PERPETUAL" || row.quoteAsset !== "USDT" || typeof row.symbol !== "string") continue;
      const symbol = row.symbol.toUpperCase();
      const filters = Array.isArray(row.filters) ? row.filters.map(asRecord) : [];
      const lot = filters.find((filter) => filter?.filterType === "LOT_SIZE") ?? null;
      const minNotional = filters.find((filter) => filter?.filterType === "MIN_NOTIONAL") ?? null;
      const listedAt = positive(row.onboardDate);
      const ticker = tickers.get(symbol);
      candidates.push({
        symbol,
        minNotionalUsd: positive(minNotional?.notional ?? minNotional?.minNotional),
        minQty: positive(lot?.minQty),
        stepSize: positive(lot?.stepSize),
        price: ticker?.price ?? null,
        quoteVolume24hUsd: ticker?.quoteVolume24hUsd ?? null,
        listedDays: listedAt === null ? null : (now - listedAt) / DAY_MS,
      });
    }
    return candidates.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  private applyC1(audit: DailyRangePoolSymbolAudit): void {
    if (audit.minNotionalUsd === null || audit.minQtyNotionalUsd === null || audit.stepNotionalUsd === null) {
      audit.failures.push("C1_EXECUTABILITY_UNMEASURED");
      return;
    }
    if (audit.minNotionalUsd > DAILY_RANGE_MAX_MIN_NOTIONAL_USD) audit.failures.push("C1_MIN_NOTIONAL");
    if (audit.minQtyNotionalUsd > DAILY_RANGE_MAX_MIN_QTY_NOTIONAL_USD) audit.failures.push("C1_MIN_QTY_NOTIONAL");
    if (audit.stepNotionalUsd > DAILY_RANGE_MAX_STEP_NOTIONAL_USD) audit.failures.push("C1_STEP_NOTIONAL");
  }

  private applyC2(audit: DailyRangePoolSymbolAudit, currentlyInPool: boolean): void {
    const threshold = DAILY_RANGE_TARGET_LIQUIDITY_24H_USD * (currentlyInPool
      ? 1 - DAILY_RANGE_LIQUIDITY_HYSTERESIS
      : 1 + DAILY_RANGE_LIQUIDITY_HYSTERESIS);
    if (audit.quoteVolume24hUsd === null || audit.quoteVolume24hUsd < threshold) audit.failures.push("C2_LIQUIDITY");
  }

  private applyC5(audit: DailyRangePoolSymbolAudit): void {
    if (audit.listedDays === null || audit.listedDays < DAILY_RANGE_MIN_LISTING_DAYS) audit.failures.push("C5_LISTING_AGE");
  }

  private async collectBookSamples(): Promise<Array<Map<string, number | null>>> {
    const samples: Array<Map<string, number | null>> = [];
    for (let index = 0; index < SPREAD_SAMPLE_COUNT; index++) {
      const payload = await this.fetchJson(MAINNET_USDM + "/fapi/v1/ticker/bookTicker");
      if (!Array.isArray(payload)) throw new Error("public USD-M bookTicker payload shape is invalid");
      const sample = new Map<string, number | null>();
      for (const raw of payload) {
        const row = asRecord(raw);
        if (!row || typeof row.symbol !== "string") continue;
        const bid = positive(row.bidPrice);
        const ask = positive(row.askPrice);
        const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
        sample.set(row.symbol.toUpperCase(), mid !== null && ask !== null && bid !== null ? ((ask - bid) / mid) * 10_000 : null);
      }
      samples.push(sample);
      if (index + 1 < SPREAD_SAMPLE_COUNT && this.spreadSampleDelayMs > 0) await this.sleep(this.spreadSampleDelayMs);
    }
    return samples;
  }

  private applySpreadEvidence(
    candidates: readonly Candidate[],
    audits: ReadonlyMap<string, DailyRangePoolSymbolAudit>,
    samples: ReadonlyArray<ReadonlyMap<string, number | null>>,
    now: number,
  ): void {
    const nextHistory: Record<string, SpreadSample[]> = {};
    for (const candidate of candidates) {
      const audit = audits.get(candidate.symbol);
      if (!audit) continue;
      const current = samples
        .map((sample) => sample.get(candidate.symbol) ?? null)
        .filter((spread): spread is number => spread !== null && Number.isFinite(spread) && spread >= 0);
      if (current.length !== SPREAD_SAMPLE_COUNT) {
        audit.failures.push("C3_SPREAD_UNMEASURED");
        continue;
      }
      const prior = (this.state.spreadSamples[candidate.symbol] ?? [])
        .filter((sample) => Number.isFinite(sample.atMs) && sample.atMs >= now - SPREAD_HISTORY_MAX_AGE_MS && Number.isFinite(sample.bps) && sample.bps >= 0);
      const combined = [...prior, ...current.map((bps) => ({ atMs: now, bps }))].slice(-SPREAD_HISTORY_LIMIT);
      nextHistory[candidate.symbol] = combined;
      audit.medianSpreadBps = median(combined.map((sample) => sample.bps));
      audit.maxObservedSpreadBps = Math.max(...current);
      if ((audit.maxObservedSpreadBps ?? Number.POSITIVE_INFINITY) > DAILY_RANGE_HARD_SPREAD_MAX_BPS) audit.failures.push("C3_HARD_SPREAD");
      else if (audit.medianSpreadBps === null || audit.medianSpreadBps > DAILY_RANGE_MEDIAN_SPREAD_MAX_BPS) audit.failures.push("C3_MEDIAN_SPREAD");
    }
    this.state.spreadSamples = nextHistory;
  }

  private async fetchDataQuality(symbol: string, now: number): Promise<{ fiveMinute: KlineQuality; fourHour: KlineQuality }> {
    try {
      const payloads = await Promise.all([
        this.fetchJson(MAINNET_USDM + "/fapi/v1/klines?symbol=" + encodeURIComponent(symbol) + "&interval=5m&limit=" + (FIVE_MIN_COMPLETED_BARS + 1)),
        this.fetchJson(MAINNET_USDM + "/fapi/v1/klines?symbol=" + encodeURIComponent(symbol) + "&interval=4h&limit=" + (FOUR_HOUR_COMPLETED_BARS + 1)),
      ]);
      return {
        fiveMinute: this.klineQuality(payloads[0], FIVE_MIN_MS, FIVE_MIN_COMPLETED_BARS, FIVE_MIN_FRESHNESS_MS, now),
        fourHour: this.klineQuality(payloads[1], FOUR_HOURS_MS, FOUR_HOUR_COMPLETED_BARS, FOUR_HOUR_FRESHNESS_MS, now),
      };
    } catch {
      return { fiveMinute: { state: "MISSING" }, fourHour: { state: "MISSING" } };
    }
  }

  private klineQuality(raw: unknown, intervalMs: number, requiredBars: number, freshnessMs: number, now: number): KlineQuality {
    if (!Array.isArray(raw)) return { state: "MISSING" };
    const parsed = raw.flatMap((row) => {
      if (!Array.isArray(row) || row.length < 7) return [];
      const openTime = finite(row[0]);
      const open = positive(row[1]);
      const high = positive(row[2]);
      const low = positive(row[3]);
      const close = positive(row[4]);
      const closeTime = finite(row[6]);
      if (openTime === null || closeTime === null || open === null || high === null || low === null || close === null || high < low || closeTime < openTime) return [];
      return [{ openTime, closeTime }];
    }).sort((a, b) => a.openTime - b.openTime);
    const completed = parsed.filter((bar) => bar.closeTime < now).slice(-requiredBars);
    if (completed.length < requiredBars) return { state: "MISSING" };
    for (let index = 1; index < completed.length; index++) {
      if ((completed[index]?.openTime ?? 0) - (completed[index - 1]?.openTime ?? 0) !== intervalMs) return { state: "GAPPED" };
    }
    const newest = completed.at(-1);
    if (!newest || now - newest.closeTime > freshnessMs) return { state: "STALE" };
    return { state: "OK" };
  }

  private read(): PersistedState {
    for (const file of [this.file, this.file + ".bak"]) {
      try {
        if (!existsSync(file)) continue;
        const parsed = asRecord(JSON.parse(readFileSync(file, "utf8")));
        if (!parsed || parsed.version !== DAILY_RANGE_AUTO_POOL_VERSION) continue;
        const asMs = (value: unknown): number | null => {
          const parsedValue = finite(value);
          return parsedValue !== null && parsedValue >= 0 ? parsedValue : null;
        };
        const rawSamples = asRecord(parsed.spreadSamples) ?? {};
        const spreadSamples = Object.fromEntries(Object.entries(rawSamples).map(([symbol, value]) => [
          symbol.toUpperCase(),
          Array.isArray(value)
            ? value.flatMap((sample) => {
                const row = asRecord(sample);
                const atMs = finite(row?.atMs);
                const bps = finite(row?.bps);
                return atMs !== null && bps !== null && atMs >= 0 && bps >= 0 ? [{ atMs, bps }] : [];
              }).slice(-SPREAD_HISTORY_LIMIT)
            : [],
        ]).filter(([, samples]) => samples.length > 0));
        const rawAudit = asRecord(parsed.audit) ?? {};
        const audit = Object.fromEntries(Object.entries(rawAudit).flatMap(([symbol, value]) => {
          const valid = safeAudit(value);
          return valid ? [[symbol.toUpperCase(), valid]] : [];
        }));
        const reconciliation = asRecord(parsed.reconciliation);
        const validReconciliation = reconciliation && typeof reconciliation.changed === "boolean" && Array.isArray(reconciliation.adds) && Array.isArray(reconciliation.drops)
          ? reconciliation as unknown as DailyRangeAutoPoolSnapshot["reconciliation"]
          : null;
        return {
          version: DAILY_RANGE_AUTO_POOL_VERSION,
          activeSymbols: Array.isArray(parsed.activeSymbols) ? normalizeSymbols(parsed.activeSymbols.filter((symbol): symbol is string => typeof symbol === "string")) : [],
          updatedAtMs: asMs(parsed.updatedAtMs),
          lastAttemptAtMs: asMs(parsed.lastAttemptAtMs),
          lastSuccessAtMs: asMs(parsed.lastSuccessAtMs),
          lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
          reconciliation: validReconciliation,
          spreadSamples,
          audit,
        };
      } catch {
        // Try the atomic backup before treating the pool as empty.
      }
    }
    return emptyState();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const encoded = JSON.stringify(this.state, null, 2);
    const temp = this.file + "." + process.pid + ".tmp";
    writeFileSync(temp, encoded, "utf8");
    renameSync(temp, this.file);
    const backupTemp = this.file + ".bak." + process.pid + ".tmp";
    writeFileSync(backupTemp, encoded, "utf8");
    renameSync(backupTemp, this.file + ".bak");
  }
}

async function mapLimited<T, R>(items: readonly T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await task(items[index] as T);
    }
  });
  await Promise.all(workers);
  return output;
}
