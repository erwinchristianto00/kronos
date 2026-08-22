/**
 * Runtime-managed eligibility pool for the executed FILTERED cross-sectional lane.
 *
 * The scanner candidate universe remains deliberately fixed and audited.  This module does
 * NOT discover every new Binance listing and cannot widen that candidate universe.  It only
 * rotates membership inside the supplied candidates using the same C1/C2 criteria shown on the
 * operator pool page:
 *   C1: public USD-M 24h quote volume, with a 10% entry/exit hysteresis band;
 *   C2: one executable lot must fit within 50% of the actual configured leg.
 *
 * There is no P&L, score, symbol preference, or per-regime tuning input.  A failed public market
 * read keeps the most recently durable pool (or the configured fallback at first boot); it never
 * turns an outage into a mass removal or an all-symbol allowlist.  Existing baskets keep their
 * frozen legs and exits regardless of a later membership change.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { DEFAULT_ELIGIBILITY, effectiveLegUsd, oneLotNotionalUsd } from "./symbol-eligibility.js";
import { poolReconciliationPlan, type PoolDecision } from "./symbol-pool-reconciliation.js";

const VERSION = 1;
const MAINNET_USDM = "https://fapi.binance.com";
const DEFAULT_REFRESH_MS = 15 * 60_000;
const MIN_POOL_SIZE = 8;
const HYSTERESIS = 0.10;

export type CrossSectionalAutoPoolState = "DISABLED" | "ACTIVE" | "STALE_FALLBACK";

export interface CrossSectionalAutoPoolSnapshot {
  version: number;
  enabled: boolean;
  state: CrossSectionalAutoPoolState;
  source: "BINANCE_USDM_MAINNET_PUBLIC" | null;
  candidateUniverse: string[];
  activeSymbols: string[];
  updatedAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  refreshEveryMs: number;
  thresholds: {
    minLiquidityUsdPerHour: number;
    maxLotFractionOfLeg: number;
    hysteresisFraction: number;
    minPoolSize: number;
    effectiveLegUsd: number | null;
    oneLotCeilingUsd: number | null;
  };
  reconciliation: {
    changed: boolean;
    adds: string[];
    drops: string[];
    held: Array<{ symbol: string; action: string; reason: string }>;
    unmeasured: boolean;
  } | null;
}

export interface CrossSectionalAutoPoolRefreshInput {
  /** Fixed candidate universe. Membership may rotate only within this set. */
  candidateUniverse: readonly string[];
  /** Proven static pool used for a first boot or a failed public market read. */
  fallbackSymbols: readonly string[];
  /** Base per-leg target used by the executor. */
  baseLegUsd: number;
  /** Testnet learning multiplier, or 1 on live/normal size. */
  sizeMultiplier: number;
}

interface PersistedAutoPoolState {
  version: number;
  activeSymbols: string[];
  updatedAtMs: number | null;
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastError: string | null;
  lastReconciliation: CrossSectionalAutoPoolSnapshot["reconciliation"];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

function envEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSS_SECTIONAL_AUTO_POOL_ENABLED === "1";
}

function positiveMs(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= 60_000 ? value : fallback;
}

function normalizedSymbols(symbols: readonly string[], candidateSet?: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const raw of symbols) {
    const symbol = raw.trim().toUpperCase();
    if (!symbol || (candidateSet && !candidateSet.has(symbol))) continue;
    out.add(symbol);
  }
  return [...out].sort();
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function finitePositive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function emptyReconciliation(): CrossSectionalAutoPoolSnapshot["reconciliation"] {
  return null;
}

function defaultPersisted(): PersistedAutoPoolState {
  return {
    version: VERSION,
    activeSymbols: [],
    updatedAtMs: null,
    lastAttemptAtMs: null,
    lastSuccessAtMs: null,
    lastError: null,
    lastReconciliation: emptyReconciliation(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function finiteOrNull(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * The data source intentionally remains mainnet public USD-M on BOTH environments. Testnet volume
 * is synthetic, so using it as a liquidity criterion would make the testnet and live pools drift
 * for a non-market reason. The exchange/order client still revalidates filters on actual entry.
 */
export class CrossSectionalAutoPool {
  private readonly file: string;
  private readonly fetchImpl: FetchLike;
  private readonly nowMs: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private state: PersistedAutoPoolState;
  private inFlight: Promise<CrossSectionalAutoPoolSnapshot> | null = null;

  constructor(opts: {
    dataDir?: string;
    fileName?: string;
    fetchImpl?: FetchLike;
    nowMs?: () => number;
    env?: NodeJS.ProcessEnv;
  } = {}) {
    const dataDir = opts.dataDir ?? "data";
    this.file = resolve(dataDir, opts.fileName ?? "cross-sectional-auto-pool.json");
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.env = opts.env ?? process.env;
    this.state = this.read();
  }

  refreshEveryMs(): number {
    return positiveMs(this.env.CROSS_SECTIONAL_AUTO_POOL_REFRESH_MS, DEFAULT_REFRESH_MS);
  }

  /** A synchronous status read for dashboards; it never makes a public request. */
  getSnapshot(input: CrossSectionalAutoPoolRefreshInput): CrossSectionalAutoPoolSnapshot {
    const candidates = normalizedSymbols(input.candidateUniverse);
    const candidateSet = new Set(candidates);
    const fallback = normalizedSymbols(input.fallbackSymbols, candidateSet);
    const effectiveLeg = effectiveLegUsd(finitePositive(input.baseLegUsd), finitePositive(input.sizeMultiplier));
    const persisted = normalizedSymbols(this.state.activeSymbols, candidateSet);
    const active = persisted.length >= MIN_POOL_SIZE ? persisted : fallback;
    const enabled = envEnabled(this.env);
    const hasDurablePool = persisted.length >= MIN_POOL_SIZE;
    return {
      version: VERSION,
      enabled,
      state: !enabled ? "DISABLED" : hasDurablePool ? "ACTIVE" : "STALE_FALLBACK",
      source: enabled ? "BINANCE_USDM_MAINNET_PUBLIC" : null,
      candidateUniverse: candidates,
      activeSymbols: active,
      updatedAt: iso(this.state.updatedAtMs),
      lastAttemptAt: iso(this.state.lastAttemptAtMs),
      lastSuccessAt: iso(this.state.lastSuccessAtMs),
      lastError: this.state.lastError,
      refreshEveryMs: this.refreshEveryMs(),
      thresholds: {
        minLiquidityUsdPerHour: DEFAULT_ELIGIBILITY.minLiquidityUsdPerHour,
        maxLotFractionOfLeg: DEFAULT_ELIGIBILITY.maxLotFractionOfLeg,
        hysteresisFraction: HYSTERESIS,
        minPoolSize: MIN_POOL_SIZE,
        effectiveLegUsd: effectiveLeg,
        oneLotCeilingUsd: effectiveLeg === null ? null : effectiveLeg * DEFAULT_ELIGIBILITY.maxLotFractionOfLeg,
      },
      reconciliation: this.state.lastReconciliation,
    };
  }

  async refreshIfDue(input: CrossSectionalAutoPoolRefreshInput): Promise<CrossSectionalAutoPoolSnapshot> {
    const baseline = this.getSnapshot(input);
    if (!baseline.enabled) return baseline;

    const now = this.nowMs();
    if (this.state.lastAttemptAtMs !== null && now - this.state.lastAttemptAtMs < baseline.refreshEveryMs) return baseline;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh(input, now).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async refresh(input: CrossSectionalAutoPoolRefreshInput, now: number): Promise<CrossSectionalAutoPoolSnapshot> {
    this.state.lastAttemptAtMs = now;
    try {
      const [infoResponse, tickerResponse] = await Promise.all([
        this.fetchImpl(`${MAINNET_USDM}/fapi/v1/exchangeInfo`),
        this.fetchImpl(`${MAINNET_USDM}/fapi/v1/ticker/24hr`),
      ]);
      if (!infoResponse.ok || !tickerResponse.ok) {
        throw new Error(`public USD-M metadata failed (${infoResponse.ok ? "ticker" : "exchangeInfo"})`);
      }
      const [infoPayload, tickerPayload] = await Promise.all([infoResponse.json(), tickerResponse.json()]);
      const info = asRecord(infoPayload);
      if (!info || !Array.isArray(info.symbols) || !Array.isArray(tickerPayload)) throw new Error("public USD-M metadata shape is invalid");

      const filters = new Map<string, { minNotional: number | null; stepSize: number | null; minQty: number | null }>();
      for (const row of info.symbols) {
        const symbolRow = asRecord(row);
        if (!symbolRow || typeof symbolRow.symbol !== "string") continue;
        const filterRows = Array.isArray(symbolRow.filters) ? symbolRow.filters : [];
        const lot = filterRows.map(asRecord).find((filter) => filter?.filterType === "LOT_SIZE") ?? null;
        const minNotional = filterRows.map(asRecord).find((filter) => filter?.filterType === "MIN_NOTIONAL") ?? null;
        filters.set(symbolRow.symbol.toUpperCase(), {
          minNotional: finiteOrNull(minNotional?.notional ?? minNotional?.minNotional ?? null),
          stepSize: finiteOrNull(lot?.stepSize ?? null),
          minQty: finiteOrNull(lot?.minQty ?? null),
        });
      }
      const ticks = new Map<string, { price: number | null; quoteVolume: number | null }>();
      for (const row of tickerPayload) {
        const ticker = asRecord(row);
        if (!ticker || typeof ticker.symbol !== "string") continue;
        ticks.set(ticker.symbol.toUpperCase(), {
          price: finiteOrNull(ticker.lastPrice),
          quoteVolume: finiteOrNull(ticker.quoteVolume),
        });
      }
      if (!filters.size || !ticks.size) throw new Error("public USD-M metadata was empty");

      const candidates = normalizedSymbols(input.candidateUniverse);
      const candidateSet = new Set(candidates);
      const fallback = normalizedSymbols(input.fallbackSymbols, candidateSet);
      const current = normalizedSymbols(this.state.activeSymbols, candidateSet);
      const active = current.length >= MIN_POOL_SIZE ? current : fallback;
      const effectiveLeg = effectiveLegUsd(finitePositive(input.baseLegUsd), finitePositive(input.sizeMultiplier));
      const maxOneLotUsd = effectiveLeg === null
        ? Number.NaN
        : effectiveLeg * DEFAULT_ELIGIBILITY.maxLotFractionOfLeg;
      if (!Number.isFinite(maxOneLotUsd) || maxOneLotUsd <= 0) throw new Error("effective basket leg is unavailable");

      const activeSet = new Set(active);
      const plan = poolReconciliationPlan(
        candidates.map((symbol) => {
          const filter = filters.get(symbol);
          const ticker = ticks.get(symbol);
          const oneLotUsd = oneLotNotionalUsd({
            price: ticker?.price ?? null,
            minNotionalUsd: filter?.minNotional ?? null,
            stepSize: filter?.stepSize ?? null,
            minQty: filter?.minQty ?? null,
          });
          return {
            symbol,
            liquidityUsdPerHour: ticker?.quoteVolume === null || ticker?.quoteVolume === undefined
              ? null
              : ticker.quoteVolume / 24,
            oneLotUsd,
            inPool: activeSet.has(symbol),
          };
        }),
        {
          minLiquidityUsdPerHour: DEFAULT_ELIGIBILITY.minLiquidityUsdPerHour,
          maxOneLotUsd,
          hysteresisFraction: HYSTERESIS,
          minPoolSize: MIN_POOL_SIZE,
        },
      );
      if (plan.unmeasured || plan.proposedPool.length < MIN_POOL_SIZE) {
        throw new Error(plan.unmeasured ? "public USD-M eligibility was unmeasured" : "proposed pool would be below its safe minimum");
      }

      this.state.activeSymbols = normalizedSymbols(plan.proposedPool, candidateSet);
      this.state.updatedAtMs = now;
      this.state.lastSuccessAtMs = now;
      this.state.lastError = null;
      this.state.lastReconciliation = {
        changed: plan.changed,
        adds: [...plan.adds].sort(),
        drops: [...plan.drops].sort(),
        held: plan.heldDespiteFailure.map((decision: PoolDecision) => ({
          symbol: decision.symbol,
          action: decision.action,
          reason: decision.reason,
        })),
        unmeasured: plan.unmeasured,
      };
      this.persist();
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error);
      // Persisting the failed attempt makes a restart obey the same refresh cooldown, avoiding a
      // thundering herd of public requests during an outage. It never overwrites activeSymbols.
      this.persist();
    }
    return this.getSnapshot(input);
  }

  private read(): PersistedAutoPoolState {
    try {
      if (!existsSync(this.file)) return defaultPersisted();
      const parsed = asRecord(JSON.parse(readFileSync(this.file, "utf8")));
      if (!parsed || parsed.version !== VERSION) return defaultPersisted();
      const asMs = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
      const reconciliation = asRecord(parsed.lastReconciliation);
      const held = Array.isArray(reconciliation?.held)
        ? reconciliation!.held.flatMap((row) => {
            const item = asRecord(row);
            return item && typeof item.symbol === "string" && typeof item.action === "string" && typeof item.reason === "string"
              ? [{ symbol: item.symbol, action: item.action, reason: item.reason }]
              : [];
          })
        : [];
      return {
        version: VERSION,
        activeSymbols: Array.isArray(parsed.activeSymbols) ? normalizedSymbols(parsed.activeSymbols.filter((v): v is string => typeof v === "string")) : [],
        updatedAtMs: asMs(parsed.updatedAtMs),
        lastAttemptAtMs: asMs(parsed.lastAttemptAtMs),
        lastSuccessAtMs: asMs(parsed.lastSuccessAtMs),
        lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
        lastReconciliation: reconciliation && typeof reconciliation.changed === "boolean" && Array.isArray(reconciliation.adds) && Array.isArray(reconciliation.drops)
          ? {
              changed: reconciliation.changed,
              adds: reconciliation.adds.filter((v): v is string => typeof v === "string"),
              drops: reconciliation.drops.filter((v): v is string => typeof v === "string"),
              held,
              unmeasured: reconciliation.unmeasured === true,
            }
          : null,
      };
    } catch {
      return defaultPersisted();
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.state, null, 2));
      renameSync(temporary, this.file);
    } catch {
      // The live in-memory pool remains safe; a failed disk write must not stop exits or force an
      // accidental fallback-to-all-symbols. The next successful refresh will retry persistence.
    }
  }
}
