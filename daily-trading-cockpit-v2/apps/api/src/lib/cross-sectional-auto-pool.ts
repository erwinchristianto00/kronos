/**
 * Runtime-managed eligibility pool for the executed FILTERED cross-sectional lane.
 *
 * The candidate universe remains fixed and audited. This module never discovers a new Binance
 * listing; it only rotates membership inside that candidate set using the C1/C2 criteria shown
 * to the operator: public USD-M liquidity and an executable lot no larger than half a leg.
 * Existing baskets are not touched by a later pool update.
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
  /** Membership can rotate only inside this fixed candidate universe. */
  candidateUniverse: readonly string[];
  /** Existing operator list used only at first boot or during a public-market outage. */
  fallbackSymbols: readonly string[];
  baseLegUsd: number;
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

function enabled(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] === "1";
}

function positiveMs(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= 60_000 ? value : fallback;
}

function symbols(values: readonly string[], candidateSet?: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const raw of values) {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function finiteOrNull(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function emptyState(): PersistedAutoPoolState {
  return {
    version: VERSION,
    activeSymbols: [],
    updatedAtMs: null,
    lastAttemptAtMs: null,
    lastSuccessAtMs: null,
    lastError: null,
    lastReconciliation: null,
  };
}

/**
 * Both environments use mainnet public USD-M metadata. Testnet liquidity is synthetic; using it
 * would make testnet and live choose different symbols for a non-market reason. Actual entry
 * remains validated by the respective exchange client.
 */
export class CrossSectionalAutoPool {
  private readonly file: string;
  private readonly fetchImpl: FetchLike;
  private readonly nowMs: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly enabledEnvKey: string;
  private readonly refreshEveryMsEnvKey: string;
  private state: PersistedAutoPoolState;
  private inFlight: Promise<CrossSectionalAutoPoolSnapshot> | null = null;

  constructor(opts: {
    dataDir?: string;
    fileName?: string;
    fetchImpl?: FetchLike;
    nowMs?: () => number;
    env?: NodeJS.ProcessEnv;
    /** Allows an isolated lane to own its automation switch without sharing cross-basket state. */
    enabledEnvKey?: string;
    /** Allows an isolated lane to own its refresh cadence without sharing cross-basket state. */
    refreshEveryMsEnvKey?: string;
  } = {}) {
    const dataDir = opts.dataDir ?? "data";
    this.file = resolve(dataDir, opts.fileName ?? "cross-sectional-auto-pool.json");
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.env = opts.env ?? process.env;
    this.enabledEnvKey = opts.enabledEnvKey ?? "CROSS_SECTIONAL_AUTO_POOL_ENABLED";
    this.refreshEveryMsEnvKey = opts.refreshEveryMsEnvKey ?? "CROSS_SECTIONAL_AUTO_POOL_REFRESH_MS";
    this.state = this.read();
  }

  refreshEveryMs(): number {
    return positiveMs(this.env[this.refreshEveryMsEnvKey], DEFAULT_REFRESH_MS);
  }

  /** Synchronous status only; this never sends a public-market request. */
  getSnapshot(input: CrossSectionalAutoPoolRefreshInput): CrossSectionalAutoPoolSnapshot {
    const candidateUniverse = symbols(input.candidateUniverse);
    const candidateSet = new Set(candidateUniverse);
    const fallback = symbols(input.fallbackSymbols, candidateSet);
    const persisted = symbols(this.state.activeSymbols, candidateSet);
    const hasDurablePool = persisted.length >= MIN_POOL_SIZE;
    const activeSymbols = hasDurablePool ? persisted : fallback;
    const effectiveLegUsd = effectiveLegUsdFor(input.baseLegUsd, input.sizeMultiplier);
    const on = enabled(this.env, this.enabledEnvKey);
    return {
      version: VERSION,
      enabled: on,
      state: !on ? "DISABLED" : hasDurablePool ? "ACTIVE" : "STALE_FALLBACK",
      source: on ? "BINANCE_USDM_MAINNET_PUBLIC" : null,
      candidateUniverse,
      activeSymbols,
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
        effectiveLegUsd,
        oneLotCeilingUsd: effectiveLegUsd === null ? null : effectiveLegUsd * DEFAULT_ELIGIBILITY.maxLotFractionOfLeg,
      },
      reconciliation: this.state.lastReconciliation,
    };
  }

  async refreshIfDue(input: CrossSectionalAutoPoolRefreshInput): Promise<CrossSectionalAutoPoolSnapshot> {
    const baseline = this.getSnapshot(input);
    if (!baseline.enabled) return baseline;
    // A report request can arrive while process-start priming (or a formation cycle) already owns
    // the same public refresh. Join it before applying the cadence shortcut; otherwise the second
    // reader observes the old durable snapshot and caches it for fifteen minutes even though the
    // refresh succeeds moments later.
    if (this.inFlight) return this.inFlight;
    const now = this.nowMs();
    if (this.state.lastAttemptAtMs !== null && now - this.state.lastAttemptAtMs < baseline.refreshEveryMs) return baseline;
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
      if (!info || !Array.isArray(info.symbols) || !Array.isArray(tickerPayload)) {
        throw new Error("public USD-M metadata shape is invalid");
      }

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

      const candidateUniverse = symbols(input.candidateUniverse);
      const candidateSet = new Set(candidateUniverse);
      const fallback = symbols(input.fallbackSymbols, candidateSet);
      const current = symbols(this.state.activeSymbols, candidateSet);
      const active = current.length >= MIN_POOL_SIZE ? current : fallback;
      const leg = effectiveLegUsdFor(input.baseLegUsd, input.sizeMultiplier);
      const maxOneLotUsd = leg === null ? Number.NaN : leg * DEFAULT_ELIGIBILITY.maxLotFractionOfLeg;
      if (!Number.isFinite(maxOneLotUsd) || maxOneLotUsd <= 0) throw new Error("effective basket leg is unavailable");

      const activeSet = new Set(active);
      const plan = poolReconciliationPlan(
        candidateUniverse.map((symbol) => {
          const filter = filters.get(symbol);
          const ticker = ticks.get(symbol);
          return {
            symbol,
            liquidityUsdPerHour: ticker?.quoteVolume == null ? null : ticker.quoteVolume / 24,
            oneLotUsd: oneLotNotionalUsd({
              price: ticker?.price ?? null,
              minNotionalUsd: filter?.minNotional ?? null,
              stepSize: filter?.stepSize ?? null,
              minQty: filter?.minQty ?? null,
            }),
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

      this.state.activeSymbols = symbols(plan.proposedPool, candidateSet);
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
      // An outage is never evidence that a symbol failed. Preserve the last durable pool.
      this.persist();
    }
    return this.getSnapshot(input);
  }

  private read(): PersistedAutoPoolState {
    try {
      if (!existsSync(this.file)) return emptyState();
      const parsed = asRecord(JSON.parse(readFileSync(this.file, "utf8")));
      if (!parsed || parsed.version !== VERSION) return emptyState();
      const asMs = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
      const rawReconciliation = asRecord(parsed.lastReconciliation);
      const held = Array.isArray(rawReconciliation?.held)
        ? rawReconciliation.held.flatMap((row) => {
            const item = asRecord(row);
            return item && typeof item.symbol === "string" && typeof item.action === "string" && typeof item.reason === "string"
              ? [{ symbol: item.symbol, action: item.action, reason: item.reason }]
              : [];
          })
        : [];
      return {
        version: VERSION,
        activeSymbols: Array.isArray(parsed.activeSymbols)
          ? symbols(parsed.activeSymbols.filter((value): value is string => typeof value === "string"))
          : [],
        updatedAtMs: asMs(parsed.updatedAtMs),
        lastAttemptAtMs: asMs(parsed.lastAttemptAtMs),
        lastSuccessAtMs: asMs(parsed.lastSuccessAtMs),
        lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
        lastReconciliation: rawReconciliation && typeof rawReconciliation.changed === "boolean" && Array.isArray(rawReconciliation.adds) && Array.isArray(rawReconciliation.drops)
          ? {
              changed: rawReconciliation.changed,
              adds: rawReconciliation.adds.filter((value): value is string => typeof value === "string"),
              drops: rawReconciliation.drops.filter((value): value is string => typeof value === "string"),
              held,
              unmeasured: rawReconciliation.unmeasured === true,
            }
          : null,
      };
    } catch {
      return emptyState();
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.state, null, 2));
      renameSync(temporary, this.file);
    } catch {
      // The in-memory pool remains safe; the next successful refresh retries persistence.
    }
  }
}

function effectiveLegUsdFor(baseLegUsd: number, sizeMultiplier: number): number | null {
  return effectiveLegUsd(finitePositive(baseLegUsd), finitePositive(sizeMultiplier));
}
