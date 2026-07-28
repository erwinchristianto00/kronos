/**
 * FUNDING-CARRY MARKET-NEUTRAL PAIR (report-only measurement lane).
 *
 * Perp funding rates diverge across CORRELATED symbols. This lane opens a delta-neutral SHADOW
 * pair: LONG the low/negative-funding leg, SHORT the high-funding leg, equal notional, both legs
 * inside the SAME correlation cluster (correlation-clusters.ts — the same coarse map the
 * position-concentration cap trusts), so beta approximately cancels and what remains is:
 *
 *   P&L = funding differential accrued over the hold        (the edge being measured)
 *       − simulated taker fees (4 legs round-trip)          (the certain cost)
 *       ± residual price divergence of the pair             (the risk — measured HONESTLY: the two
 *                                                            legs never cancel perfectly)
 *
 * Sign conventions (Binance): positive funding ⇒ longs pay shorts. We SHORT the high-funding leg
 * (we RECEIVE its funding while positive) and LONG the low-funding leg (we PAY its funding while
 * positive, RECEIVE while negative). Carry per 8h settlement per unit leg notional:
 *   carryPerInterval = shortLegFundingRate − longLegFundingRate   (> 0 at entry by construction)
 *
 * ACCRUAL IS DONE WITH THE ACTUAL RATE EACH INTERVAL, NOT THE ENTRY SNAPSHOT. Rates move — the
 * cycle observes both legs' CURRENT-period rate (premiumIndex.lastFundingRate — the rate that will
 * settle at the next boundary) every tick and, when an 8h settlement boundary is crossed, credits
 * that boundary using the last rates observed BEFORE it (within one cycle-tick of the true settled
 * rate). Boundaries missed entirely (process down) are credited at the currently-observed rate and
 * counted in `staleAccruals` — degraded honestly, never silently.
 *
 * Entry condition (break-even test): the differential must clear the round-trip fee bill within
 * the TARGET hold with a safety multiple:
 *   diffPerInterval × floor(targetHoldHours/8) ≥ pairFeeReturn × safetyMultiple
 * With the defaults (16 bps pair fees, 2.0 safety, 48h target = 6 intervals) that requires a
 * differential ≥ ~5.33 bps per 8h (~24% annualized) — attainable when one leg's funding is EXTREME
 * (see derivatives-crowding.ts's 7 bps threshold) while its cluster sibling is flat/negative.
 *
 * Exit: differential collapses below a floor, divergence stop (pair spread moved > stop against
 * us), or max-hold mark-to-market. R DENOMINATOR = the divergence-stop distance, frozen at open —
 * risk is defined as what the stop allows the pair to lose, so R is honest: the certain fee bill
 * alone costs ~0.11R and a stop-out books ≈ −1R (or WORSE when the spread gaps through the stop —
 * the loss is booked at the OBSERVED spread, never clamped to the stop).
 *
 * Pure measurement: records and resolves shadow observations, exposes a report. NO orders, NO
 * execution-engine wiring, NOTHING trades until the book proves positive (house rule: every new
 * lane proves edge in shadow first). Independent module: own store, cycle, resolver, report.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { clusterOf, OTHER_CLUSTER } from "./correlation-clusters.js";

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export const FC_PAPER_LANE_ID = "FUNDING_CARRY_NEUTRAL_PAIR" as const;

/** Binance USD-M funding settles every 8h at 00:00/08:00/16:00 UTC — epoch-aligned. */
export const FC_FUNDING_INTERVAL_MS = 8 * 3_600_000;

/** Same per-symbol taker round-trip assumption as every sibling measurement lane
 *  (short-fade-edge.ts / intraday-momentum-edge.ts / regime-composite-edge.ts:
 *  TAKER_ROUNDTRIP_BPS = 8 — ~0.04% per side, taker in + taker out). */
export const FC_TAKER_ROUNDTRIP_BPS_PER_LEG = 8;
/** A pair is 2 symbols × (taker in + taker out) = 4 taker legs = 2 single-symbol round trips. */
export const FC_PAIR_FEE_BPS = 2 * FC_TAKER_ROUNDTRIP_BPS_PER_LEG; // 16 bps of one leg's notional

/** Expected hold used by the break-even ENTRY test (not a commitment — max-hold is separate). */
export const FC_TARGET_HOLD_HOURS = envNum("FUNDING_CARRY_TARGET_HOLD_HOURS", 48);
/** Fees × this multiple must be covered by expected funding capture before a pair may open. */
export const FC_FEE_SAFETY_MULTIPLE = envNum("FUNDING_CARRY_FEE_SAFETY_MULTIPLE", 2);
/** Hard mark-to-market close after this many hours. */
export const FC_MAX_HOLD_HOURS = envNum("FUNDING_CARRY_MAX_HOLD_HOURS", 72);
/** Divergence stop: close when the pair spread has moved this far AGAINST us (bps of leg
 *  notional). Also the R denominator — risk per unit notional is frozen at this distance. */
export const FC_DIVERGENCE_STOP_BPS = envNum("FUNDING_CARRY_DIVERGENCE_STOP_BPS", 150);
/** Exit once the CURRENT differential (per 8h) drops below this floor (bps) — the carry is gone,
 *  every further cycle is pure spread/fee risk for nothing. */
export const FC_EXIT_DIFF_FLOOR_BPS = envNum("FUNDING_CARRY_EXIT_DIFF_FLOOR_BPS", 1);
export const FC_MAX_OPEN_PAIRS = envNum("FUNDING_CARRY_MAX_OPEN_PAIRS", 6);
export const FC_MAX_NEW_PAIRS_PER_CYCLE = envNum("FUNDING_CARRY_MAX_NEW_PAIRS_PER_CYCLE", 2);
/** Don't re-open the SAME (unordered) pair within this window of its last open. */
export const FC_PAIR_DEDUPE_WINDOW_MS = envNum("FUNDING_CARRY_PAIR_DEDUPE_WINDOW_MS", FC_FUNDING_INTERVAL_MS);
export const FC_MAX_STORED_OBSERVATIONS = envNum("FUNDING_CARRY_MAX_STORED_OBSERVATIONS", 400);
/** Shadow sizing — informational only (netR is notional-independent); matches the ~$50 leg scale
 *  the other measurement lanes assume. */
export const FC_NOTIONAL_USD_PER_LEG = envNum("FUNDING_CARRY_NOTIONAL_USD_PER_LEG", 50);

/** Liquid multi-cluster universe (env-overridable, comma-separated). Symbols spread across the
 *  correlation-clusters.ts map so every cluster can produce same-cluster pair candidates. Unknown
 *  symbols land in OTHER and are EXCLUDED from pairing (see selectFundingCarryCandidates) — the
 *  "beta cancels" premise only holds inside a real cluster. */
export const FC_UNIVERSE: readonly string[] = (
  process.env.FUNDING_CARRY_UNIVERSE ??
  "BTCUSDT,ETHUSDT,SOLUSDT,AVAXUSDT,NEARUSDT,SUIUSDT,ADAUSDT,DOTUSDT,APTUSDT,ATOMUSDT," +
    "LINKUSDT,ARBUSDT,OPUSDT,UNIUSDT,AAVEUSDT,DOGEUSDT,WIFUSDT,1000PEPEUSDT,FETUSDT,TAOUSDT,WLDUSDT"
)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// ── pure math ───────────────────────────────────────────────────────────────

/** Last funding-settlement boundary at or before `ms` (boundaries are epoch-aligned 8h marks). */
export function fundingBoundaryAtOrBefore(ms: number): number {
  return Math.floor(ms / FC_FUNDING_INTERVAL_MS) * FC_FUNDING_INTERVAL_MS;
}

export interface FundingCarryBreakEven {
  /** The pair's 4-leg taker fee bill, as a fraction of one leg's notional. */
  feeReturn: number;
  /** 8h settlements expected within the TARGET hold. */
  expectedIntervals: number;
  /** Minimum differential per 8h (fraction) that clears fees × safety within the target hold. */
  requiredDiffPerInterval: number;
  passes: boolean;
}

/**
 * ENTRY break-even test: `diffPerInterval` (fraction per 8h, short-leg funding − long-leg funding)
 * must satisfy  diffPerInterval × expectedIntervals ≥ feeReturn × safetyMultiple.
 * Differentials at/below the required floor NEVER open a pair.
 */
export function evaluateFundingCarryBreakEven(diffPerInterval: number): FundingCarryBreakEven {
  const feeReturn = FC_PAIR_FEE_BPS / 10_000;
  const expectedIntervals = Math.max(1, Math.floor(FC_TARGET_HOLD_HOURS / 8));
  const requiredDiffPerInterval = (feeReturn * FC_FEE_SAFETY_MULTIPLE) / expectedIntervals;
  return {
    feeReturn,
    expectedIntervals,
    requiredDiffPerInterval,
    passes: finite(diffPerInterval) && diffPerInterval >= requiredDiffPerInterval,
  };
}

// ── candidate selection ─────────────────────────────────────────────────────

/** Per-symbol data the cycle observed this tick (null field ⇒ that source was missing/stale). */
export interface FundingCarrySymbolSnapshot {
  symbol: string;
  /** Current-period funding rate (fraction per 8h) — settles at the NEXT boundary. */
  fundingRate: number | null;
  markPrice: number | null;
}

export interface FundingCarryCandidate {
  cluster: string;
  /** Low/negative-funding leg — we LONG it. */
  longSymbol: string;
  /** High-funding leg — we SHORT it (receive its funding while positive). */
  shortSymbol: string;
  longFundingRate: number;
  shortFundingRate: number;
  /** shortFundingRate − longFundingRate, always ≥ 0 by orientation. */
  diffPerInterval: number;
  longMarkPrice: number;
  shortMarkPrice: number;
}

export interface FundingCarryCandidateScan {
  candidates: FundingCarryCandidate[]; // break-even-passing, sorted by diff desc
  pairsEvaluated: number;
  belowBreakeven: number;
  skippedMissingData: number; // symbols without funding+mark this tick
  skippedOtherCluster: number; // symbols excluded because the cluster map doesn't know them
}

/**
 * Rank same-cluster pairs by funding differential and keep only those clearing the break-even
 * test. OTHER-cluster symbols never pair: the cluster map groups every UNKNOWN symbol there, so
 * two OTHER members have no established correlation and the delta-neutral premise would be a lie.
 */
export function selectFundingCarryCandidates(
  snapshots: readonly FundingCarrySymbolSnapshot[],
  clusterOfFn: (symbol: string) => string = clusterOf,
): FundingCarryCandidateScan {
  const scan: FundingCarryCandidateScan = {
    candidates: [],
    pairsEvaluated: 0,
    belowBreakeven: 0,
    skippedMissingData: 0,
    skippedOtherCluster: 0,
  };
  const byCluster = new Map<string, Array<FundingCarrySymbolSnapshot & { fundingRate: number; markPrice: number }>>();
  for (const snap of snapshots) {
    if (!finite(snap.fundingRate) || !finite(snap.markPrice) || !(snap.markPrice > 0)) {
      scan.skippedMissingData += 1;
      continue;
    }
    const cluster = clusterOfFn(snap.symbol);
    if (cluster === OTHER_CLUSTER) {
      scan.skippedOtherCluster += 1;
      continue;
    }
    const list = byCluster.get(cluster) ?? [];
    list.push(snap as FundingCarrySymbolSnapshot & { fundingRate: number; markPrice: number });
    byCluster.set(cluster, list);
  }

  for (const [cluster, members] of byCluster) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        scan.pairsEvaluated += 1;
        const a = members[i]!;
        const b = members[j]!;
        // Orient: SHORT the higher-funding leg, LONG the lower one.
        const [longLeg, shortLeg] = a.fundingRate <= b.fundingRate ? [a, b] : [b, a];
        const diffPerInterval = shortLeg.fundingRate - longLeg.fundingRate;
        if (!evaluateFundingCarryBreakEven(diffPerInterval).passes) {
          scan.belowBreakeven += 1;
          continue;
        }
        scan.candidates.push({
          cluster,
          longSymbol: longLeg.symbol,
          shortSymbol: shortLeg.symbol,
          longFundingRate: longLeg.fundingRate,
          shortFundingRate: shortLeg.fundingRate,
          diffPerInterval,
          longMarkPrice: longLeg.markPrice,
          shortMarkPrice: shortLeg.markPrice,
        });
      }
    }
  }
  scan.candidates.sort((x, y) => y.diffPerInterval - x.diffPerInterval);
  return scan;
}

// ── observation + resolution ────────────────────────────────────────────────

export type FundingCarryExitReason = "DIFF_COLLAPSED" | "DIVERGENCE_STOP" | "MAX_HOLD_MTM";

export interface FundingCarryObservation {
  observationId: string;
  pairKey: string; // unordered "A|B" (sorted) — dedupe key
  cluster: string;
  longSymbol: string;
  shortSymbol: string;
  openedAt: string;
  openedAtMs: number;
  longEntryPrice: number;
  shortEntryPrice: number;
  longFundingAtEntry: number;
  shortFundingAtEntry: number;
  diffAtEntry: number;
  notionalUsdPerLeg: number;
  /** R denominator, frozen at open: the divergence-stop distance as a fraction of leg notional. */
  divergenceStopReturn: number;
  // accrual state (mutated per cycle while OPEN)
  /** Funding captured so far, fraction of one leg's notional (signed). */
  fundingAccruedReturn: number;
  fundingIntervalsAccrued: number;
  /** Boundaries credited WITHOUT a fresh pre-boundary rate observation (process was down). */
  staleAccruals: number;
  /** Last settlement boundary already credited (never credit the same boundary twice). */
  lastAccrualBoundaryMs: number;
  /** Latest observed current-period rates — the rates that will settle at the NEXT boundary. */
  pendingLongRate: number | null;
  pendingShortRate: number | null;
  /** Latest observed pair spread (LONG-leg return − SHORT-leg price return), fraction. */
  lastMarkSpreadReturn: number | null;
  /** Cycles where one/both legs had no usable data — honest degradation counter. */
  dataGapCycles: number;
  status: "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "EXPIRED";
  exitReason: FundingCarryExitReason | null;
  /** Net-R components (all denominated in divergenceStopReturn): net = funding + divergence − cost. */
  fundingR: number | null;
  divergenceR: number | null;
  costR: number | null;
  netR: number | null;
  holdHours: number | null;
  resolvedAt: string | null;
}

/** What the cycle observed for an OPEN pair's two legs this tick (nulls ⇒ source missing). */
export interface FundingCarryLegObservation {
  longFundingRate: number | null;
  shortFundingRate: number | null;
  longMarkPrice: number | null;
  shortMarkPrice: number | null;
}

function pairSpreadReturn(obs: FundingCarryObservation, longMark: number, shortMark: number): number {
  const longLegReturn = longMark / obs.longEntryPrice - 1;
  const shortLegPriceReturn = shortMark / obs.shortEntryPrice - 1;
  // LONG leg profits when it rises; SHORT leg profits when it falls. Positive ⇒ in our favor.
  return longLegReturn - shortLegPriceReturn;
}

function finalizeClose(
  obs: FundingCarryObservation,
  accrual: Pick<FundingCarryObservation, "fundingAccruedReturn" | "fundingIntervalsAccrued" | "staleAccruals" | "lastAccrualBoundaryMs">,
  spreadReturn: number,
  exitReason: FundingCarryExitReason,
  nowMs: number,
): Partial<FundingCarryObservation> {
  const feeReturn = FC_PAIR_FEE_BPS / 10_000;
  const stop = obs.divergenceStopReturn;
  const fundingR = accrual.fundingAccruedReturn / stop;
  const divergenceR = spreadReturn / stop;
  const costR = feeReturn / stop;
  const netR = fundingR + divergenceR - costR;
  return {
    ...accrual,
    lastMarkSpreadReturn: spreadReturn,
    status: netR >= 0 ? "CLOSED_WIN" : "CLOSED_LOSS",
    exitReason,
    fundingR,
    divergenceR,
    costR,
    netR,
    holdHours: (nowMs - obs.openedAtMs) / 3_600_000,
    resolvedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Advance one OPEN observation by one cycle tick: accrue any crossed 8h settlement boundaries
 * (using the ACTUAL rates observed each interval — pre-boundary pending rates when available,
 * currently-observed rates flagged `staleAccruals` when a boundary was missed entirely), then
 * check exits (divergence stop → max hold → differential collapse), then refresh pending state.
 *
 * Pure function; returns the patch to apply (never mutates `obs`), or null when nothing changed.
 * Exactly-once: callers only invoke this for status === "OPEN" observations, and any returned
 * closing patch flips status so a second invocation can never re-resolve the same observation.
 */
export function updateOpenFundingCarryObservation(
  obs: FundingCarryObservation,
  legs: FundingCarryLegObservation,
  nowMs: number,
): Partial<FundingCarryObservation> | null {
  if (obs.status !== "OPEN") return null;

  const currentLong = finite(legs.longFundingRate) ? legs.longFundingRate : null;
  const currentShort = finite(legs.shortFundingRate) ? legs.shortFundingRate : null;
  const haveMarks =
    finite(legs.longMarkPrice) && legs.longMarkPrice > 0 && finite(legs.shortMarkPrice) && legs.shortMarkPrice > 0;

  // 1. accrue crossed settlement boundaries.
  const accrual = {
    fundingAccruedReturn: obs.fundingAccruedReturn,
    fundingIntervalsAccrued: obs.fundingIntervalsAccrued,
    staleAccruals: obs.staleAccruals,
    lastAccrualBoundaryMs: obs.lastAccrualBoundaryMs,
  };
  const latestBoundary = fundingBoundaryAtOrBefore(nowMs);
  let firstCrossing = true;
  while (accrual.lastAccrualBoundaryMs < latestBoundary) {
    // First crossed boundary since the last tick: the rates observed on the PREVIOUS tick
    // (pending*) are the current-period rates just before settlement — the honest approximation
    // of what actually settled. Any FURTHER boundary in the same catch-up loop means the process
    // wasn't running to observe its period at all: credit at the currently-observed rate and
    // count it stale. If NO rate is available at all for a boundary, do NOT advance past it —
    // a later tick with data will credit it (stale-flagged) rather than silently dropping it.
    const longRate = firstCrossing ? obs.pendingLongRate ?? currentLong : currentLong;
    const shortRate = firstCrossing ? obs.pendingShortRate ?? currentShort : currentShort;
    const usedStaleRate = firstCrossing ? obs.pendingLongRate === null || obs.pendingShortRate === null : true;
    if (!finite(longRate) || !finite(shortRate)) break; // no data to credit with — defer, don't drop
    accrual.fundingAccruedReturn += shortRate - longRate;
    accrual.fundingIntervalsAccrued += 1;
    if (usedStaleRate) accrual.staleAccruals += 1;
    accrual.lastAccrualBoundaryMs += FC_FUNDING_INTERVAL_MS;
    firstCrossing = false;
  }

  // 2. current pair spread (residual divergence — the honest risk term).
  const spreadReturn = haveMarks ? pairSpreadReturn(obs, legs.longMarkPrice as number, legs.shortMarkPrice as number) : null;

  // 3. exit checks — risk control first.
  if (spreadReturn !== null && spreadReturn <= -obs.divergenceStopReturn) {
    // Book at the OBSERVED spread — a gap through the stop books WORSE than −1R, never clamped.
    return finalizeClose(obs, accrual, spreadReturn, "DIVERGENCE_STOP", nowMs);
  }
  const heldMs = nowMs - obs.openedAtMs;
  if (heldMs >= FC_MAX_HOLD_HOURS * 3_600_000) {
    const mtmSpread = spreadReturn ?? obs.lastMarkSpreadReturn;
    if (mtmSpread !== null) {
      return finalizeClose(obs, accrual, mtmSpread, "MAX_HOLD_MTM", nowMs);
    }
    // Never observed a spread and can't observe one now: past 3× max-hold this is un-resolvable.
    if (heldMs > FC_MAX_HOLD_HOURS * 3_600_000 * 3) {
      return { ...accrual, status: "EXPIRED", resolvedAt: new Date(nowMs).toISOString() };
    }
  }
  if (currentLong !== null && currentShort !== null) {
    const currentDiff = currentShort - currentLong;
    if (currentDiff < FC_EXIT_DIFF_FLOOR_BPS / 10_000 && spreadReturn !== null) {
      // The carry is gone — holding on is pure spread/fee risk for nothing. MTM out.
      return finalizeClose(obs, accrual, spreadReturn, "DIFF_COLLAPSED", nowMs);
    }
  }

  // 4. still open — refresh accrual + pending-rate + spread state.
  const patch: Partial<FundingCarryObservation> = { ...accrual };
  if (currentLong !== null) patch.pendingLongRate = currentLong;
  if (currentShort !== null) patch.pendingShortRate = currentShort;
  if (spreadReturn !== null) patch.lastMarkSpreadReturn = spreadReturn;
  if (currentLong === null || currentShort === null || !haveMarks) patch.dataGapCycles = obs.dataGapCycles + 1;
  return patch;
}

// ── store ───────────────────────────────────────────────────────────────────

/** Liveness + funnel counters, persisted so the report can PROVE the cycle is alive and show WHY
 *  the book is empty (same lesson as short-fade-edge.ts's SFCycleMeta: an empty lane must be
 *  distinguishable from a dead one without SSHing to the box). */
export interface FCCycleMeta {
  lastCycleAt: string | null;
  cycles: number;
  pairsEvaluatedTotal: number;
  belowBreakevenTotal: number;
  recordedTotal: number;
  skippedMissingDataTotal: number;
  skippedOtherClusterTotal: number;
  lastCycleError: string | null;
}

const EMPTY_CYCLE_META: FCCycleMeta = {
  lastCycleAt: null,
  cycles: 0,
  pairsEvaluatedTotal: 0,
  belowBreakevenTotal: 0,
  recordedTotal: 0,
  skippedMissingDataTotal: 0,
  skippedOtherClusterTotal: 0,
  lastCycleError: null,
};

interface FCState {
  version: number;
  observations: FundingCarryObservation[];
  cycleMeta?: FCCycleMeta;
}

export class FundingCarryStore {
  private state: FCState = { version: 1, observations: [], cycleMeta: { ...EMPTY_CYCLE_META } };
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<FCState>;
        if (Array.isArray(parsed.observations)) this.state.observations = parsed.observations as FundingCarryObservation[];
        if (parsed.cycleMeta && typeof parsed.cycleMeta === "object") {
          this.state.cycleMeta = { ...EMPTY_CYCLE_META, ...parsed.cycleMeta };
        }
      } catch {
        /* corrupt → start empty */
      }
    }
  }
  get all(): FundingCarryObservation[] {
    return this.state.observations;
  }
  get cycleMeta(): FCCycleMeta {
    return this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
  }
  recordCycle(atIso: string, result: FCCycleResult | null, error?: string): void {
    const meta = this.state.cycleMeta ?? { ...EMPTY_CYCLE_META };
    meta.lastCycleAt = atIso;
    meta.cycles += 1;
    if (result) {
      meta.pairsEvaluatedTotal += result.pairsEvaluated;
      meta.belowBreakevenTotal += result.belowBreakeven;
      meta.recordedTotal += result.recorded;
      meta.skippedMissingDataTotal += result.skippedMissingData;
      meta.skippedOtherClusterTotal += result.skippedOtherCluster;
      meta.lastCycleError = null;
    } else {
      meta.lastCycleError = error ?? "unknown cycle error";
    }
    this.state.cycleMeta = meta;
  }
  has(observationId: string): boolean {
    return this.state.observations.some((o) => o.observationId === observationId);
  }
  add(obs: FundingCarryObservation): boolean {
    if (this.has(obs.observationId)) return false;
    this.state.observations.push(obs);
    return true;
  }
  update(observationId: string, patch: Partial<FundingCarryObservation>): void {
    const o = this.state.observations.find((x) => x.observationId === observationId);
    if (o) Object.assign(o, patch);
  }
  /** Bounded retention: every OPEN observation is kept, plus at most FC_MAX_STORED_OBSERVATIONS
   *  settled ones — oldest settled dropped first (same OOM discipline as every sibling store). */
  private prune(): void {
    const open = this.state.observations.filter((o) => o.status === "OPEN");
    const settled = this.state.observations
      .filter((o) => o.status !== "OPEN")
      .sort((a, b) => a.openedAtMs - b.openedAtMs);
    const keepSettled =
      settled.length > FC_MAX_STORED_OBSERVATIONS ? settled.slice(settled.length - FC_MAX_STORED_OBSERVATIONS) : settled;
    this.state.observations = [...open, ...keepSettled];
  }
  save(): void {
    this.prune();
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
    renameSync(tmp, this.file); // atomic on POSIX — no torn reads
  }
}

let singleton: FundingCarryStore | null = null;
export function getFundingCarryStore(dataDir = "data"): FundingCarryStore {
  if (!singleton) singleton = new FundingCarryStore(resolve(dataDir, "funding-carry-edge.json"));
  return singleton;
}

export function _resetFundingCarryStoreForTests(): void {
  singleton = null;
}

// ── cycle ───────────────────────────────────────────────────────────────────

export interface FCCycleResult {
  scanned: number;
  recorded: number;
  resolved: number;
  expired: number;
  pairsEvaluated: number;
  belowBreakeven: number;
  skippedMissingData: number;
  skippedOtherCluster: number;
}

/** One premiumIndex-shaped fetch per symbol per cycle — funding rate + mark price in a single
 *  existing-client call (BinanceClient.getFuturesPremiumIndex; already the mark-price source for
 *  the moonshot lane). DI'd so tests drive fixtures, same convention as sibling lanes. */
export type FundingCarryPremiumFetcher = (
  symbol: string,
) => Promise<{ fundingRate: number | null; markPrice: number | null }>;

export async function runFundingCarryCycle(opts: {
  store: FundingCarryStore;
  universe?: readonly string[];
  now: number;
  fetchPremiumIndex: FundingCarryPremiumFetcher;
  /** DI for tests; defaults to the shared correlation-clusters.ts map. */
  clusterOfFn?: (symbol: string) => string;
  maxOpenPairs?: number;
  maxNewPairsPerCycle?: number;
  pairDedupeWindowMs?: number;
  /** Optional sibling-experiment admission gate. The parent leaves this undefined. */
  candidateFilter?: (
    candidate: FundingCarryCandidate,
    snapshots: ReadonlyMap<string, FundingCarrySymbolSnapshot>,
  ) => boolean;
  /** Keeps sibling observation identity explicit while preserving the parent's default IDs. */
  observationIdPrefix?: string;
}): Promise<FCCycleResult> {
  const result: FCCycleResult = {
    scanned: 0,
    recorded: 0,
    resolved: 0,
    expired: 0,
    pairsEvaluated: 0,
    belowBreakeven: 0,
    skippedMissingData: 0,
    skippedOtherCluster: 0,
  };
  const universe = opts.universe ?? FC_UNIVERSE;
  const clusterOfFn = opts.clusterOfFn ?? clusterOf;
  const maxOpenPairs = opts.maxOpenPairs ?? FC_MAX_OPEN_PAIRS;
  const maxNewPairsPerCycle = opts.maxNewPairsPerCycle ?? FC_MAX_NEW_PAIRS_PER_CYCLE;
  const dedupeMs = opts.pairDedupeWindowMs ?? FC_PAIR_DEDUPE_WINDOW_MS;
  const nowIso = new Date(opts.now).toISOString();

  // 1. one fetch per symbol — OPEN legs outside the configured universe are fetched too, so a
  //    universe shrink can never strand an open observation unresolvable.
  const openSymbols = opts.store.all
    .filter((o) => o.status === "OPEN")
    .flatMap((o) => [o.longSymbol, o.shortSymbol]);
  const symbols = [...new Set([...universe, ...openSymbols])];
  const snapshotBySymbol = new Map<string, FundingCarrySymbolSnapshot>();
  for (const symbol of symbols) {
    result.scanned += 1;
    try {
      const p = await opts.fetchPremiumIndex(symbol);
      snapshotBySymbol.set(symbol, {
        symbol,
        fundingRate: finite(p.fundingRate) ? p.fundingRate : null,
        markPrice: finite(p.markPrice) ? p.markPrice : null,
      });
    } catch {
      snapshotBySymbol.set(symbol, { symbol, fundingRate: null, markPrice: null }); // degrade honestly
    }
  }

  // 2. advance/resolve OPEN observations (accrual happens even when no exit fires).
  for (const obs of opts.store.all) {
    if (obs.status !== "OPEN") continue;
    const longSnap = snapshotBySymbol.get(obs.longSymbol);
    const shortSnap = snapshotBySymbol.get(obs.shortSymbol);
    const patch = updateOpenFundingCarryObservation(
      obs,
      {
        longFundingRate: longSnap?.fundingRate ?? null,
        shortFundingRate: shortSnap?.fundingRate ?? null,
        longMarkPrice: longSnap?.markPrice ?? null,
        shortMarkPrice: shortSnap?.markPrice ?? null,
      },
      opts.now,
    );
    if (patch) {
      opts.store.update(obs.observationId, patch);
      if (patch.status === "EXPIRED") result.expired += 1;
      else if (patch.status === "CLOSED_WIN" || patch.status === "CLOSED_LOSS") result.resolved += 1;
    }
  }

  // 3. candidate scan over the configured universe only.
  const scan = selectFundingCarryCandidates(
    universe.map((s) => snapshotBySymbol.get(s) ?? { symbol: s, fundingRate: null, markPrice: null }),
    clusterOfFn,
  );
  result.pairsEvaluated = scan.pairsEvaluated;
  result.belowBreakeven = scan.belowBreakeven;
  result.skippedMissingData = scan.skippedMissingData;
  result.skippedOtherCluster = scan.skippedOtherCluster;

  // 4. record new shadow pairs: cap total open, one open pair per symbol (a symbol in two pairs
  //    double-counts its funding), and never re-open the same pair inside the dedupe window.
  const busySymbols = new Set(
    opts.store.all.filter((o) => o.status === "OPEN").flatMap((o) => [o.longSymbol, o.shortSymbol]),
  );
  let openCount = opts.store.all.filter((o) => o.status === "OPEN").length;
  let openedThisCycle = 0;
  for (const cand of scan.candidates) {
    if (opts.candidateFilter && !opts.candidateFilter(cand, snapshotBySymbol)) continue;
    if (openCount >= maxOpenPairs || openedThisCycle >= maxNewPairsPerCycle) break;
    if (busySymbols.has(cand.longSymbol) || busySymbols.has(cand.shortSymbol)) continue;
    const pairKey = [cand.longSymbol, cand.shortSymbol].sort().join("|");
    const recentSamePair = opts.store.all.some(
      (o) => o.pairKey === pairKey && opts.now - o.openedAtMs < dedupeMs,
    );
    if (recentSamePair) continue;

    const observationId = `${opts.observationIdPrefix ?? "fc"}:${pairKey}:${opts.now}`;
    const added = opts.store.add({
      observationId,
      pairKey,
      cluster: cand.cluster,
      longSymbol: cand.longSymbol,
      shortSymbol: cand.shortSymbol,
      openedAt: nowIso,
      openedAtMs: opts.now,
      longEntryPrice: cand.longMarkPrice,
      shortEntryPrice: cand.shortMarkPrice,
      longFundingAtEntry: cand.longFundingRate,
      shortFundingAtEntry: cand.shortFundingRate,
      diffAtEntry: cand.diffPerInterval,
      notionalUsdPerLeg: FC_NOTIONAL_USD_PER_LEG,
      divergenceStopReturn: FC_DIVERGENCE_STOP_BPS / 10_000,
      fundingAccruedReturn: 0,
      fundingIntervalsAccrued: 0,
      staleAccruals: 0,
      // No credit for the boundary already behind us — only settlements we actually hold through.
      lastAccrualBoundaryMs: fundingBoundaryAtOrBefore(opts.now),
      pendingLongRate: cand.longFundingRate,
      pendingShortRate: cand.shortFundingRate,
      // Genuinely "never observed" — seeding 0 here would make the MAX_HOLD_MTM fallback
      // (`spreadReturn ?? obs.lastMarkSpreadReturn`) always non-null, permanently dead-coding the
      // EXPIRED path below meant for a pair whose spread truly could never be observed.
      lastMarkSpreadReturn: null,
      dataGapCycles: 0,
      status: "OPEN",
      exitReason: null,
      fundingR: null,
      divergenceR: null,
      costR: null,
      netR: null,
      holdHours: null,
      resolvedAt: null,
    });
    if (added) {
      result.recorded += 1;
      openedThisCycle += 1;
      openCount += 1;
      busySymbols.add(cand.longSymbol);
      busySymbols.add(cand.shortSymbol);
    }
  }

  opts.store.recordCycle(nowIso, result);
  opts.store.save();
  return result;
}

/** 2026-07-21 review fix: single-flight — a degraded network can stretch the ~21 sequential fetches
 *  past the 7-min ticker period; two interleaved cycles on the singleton store would both read the
 *  same lastAccrualBoundaryMs and DOUBLE-CREDIT the same 8h funding settlement (the exact edge this
 *  lane measures). Same guard idiom as runExitBrainShadowCycleGuarded. */
let fcCycleInFlight = false;
export async function runFundingCarryCycleGuarded(
  opts: Parameters<typeof runFundingCarryCycle>[0],
): Promise<FCCycleResult | null> {
  if (fcCycleInFlight) return null;
  fcCycleInFlight = true;
  try {
    return await runFundingCarryCycle(opts);
  } catch (error) {
    // Record the failure so the report shows "cycle ran and ERRORED" instead of silently looking
    // identical to "no qualifying differential yet" — best-effort, never rethrows.
    try {
      opts.store.recordCycle(new Date(opts.now).toISOString(), null, (error as Error).message);
      opts.store.save();
    } catch {
      /* never let liveness bookkeeping break the caller */
    }
    return null;
  } finally {
    fcCycleInFlight = false;
  }
}

// ── report ──────────────────────────────────────────────────────────────────

export interface FundingCarryReport {
  laneId: string;
  universe: readonly string[];
  breakEven: {
    pairFeeBps: number;
    feeSafetyMultiple: number;
    targetHoldHours: number;
    requiredDiffBpsPer8h: number;
  };
  divergenceStopBps: number;
  maxHoldHours: number;
  openCount: number;
  resolvedCount: number;
  expiredCount: number;
  netAvgR: number | null;
  wr: number | null;
  pf: number | null;
  totalNetR: number;
  /** Decomposition (all in R): what funding actually paid vs what divergence cost vs fees. */
  avgFundingR: number | null;
  avgDivergenceR: number | null;
  avgCostR: number | null;
  avgHoldHours: number | null;
  avgIntervalsAccrued: number | null;
  staleAccrualsTotal: number;
  exitReasons: { diffCollapsed: number; divergenceStop: number; maxHold: number };
  edgeReady: boolean;
  topRecent: Array<{
    pairKey: string;
    cluster: string;
    longSymbol: string;
    shortSymbol: string;
    diffAtEntryBps: number;
    fundingR: number | null;
    divergenceR: number | null;
    netR: number | null;
    status: string;
    exitReason: FundingCarryExitReason | null;
    openedAt: string;
  }>;
  cycleMeta: FCCycleMeta | null;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function buildFundingCarryReport(
  observations: readonly FundingCarryObservation[],
  cycleMeta?: FCCycleMeta,
): FundingCarryReport {
  const open = observations.filter((o) => o.status === "OPEN");
  const resolved = observations.filter(
    (o) => (o.status === "CLOSED_WIN" || o.status === "CLOSED_LOSS") && finite(o.netR),
  );
  const expired = observations.filter((o) => o.status === "EXPIRED");
  const nets = resolved.map((o) => o.netR as number);
  const grossWin = nets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(nets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const netAvgR = mean(nets);
  // House edge-ready standard: n≥30, netAvgR≥0.05, PF>1.1 (winners really outpay the losses).
  const edgeReady =
    resolved.length >= 30 && netAvgR !== null && netAvgR >= 0.05 && grossLoss > 0 && grossWin / grossLoss > 1.1;
  const breakEven = evaluateFundingCarryBreakEven(0);

  const topRecent = [...observations]
    .sort((a, b) => b.openedAtMs - a.openedAtMs)
    .slice(0, 12)
    .map((o) => ({
      pairKey: o.pairKey,
      cluster: o.cluster,
      longSymbol: o.longSymbol,
      shortSymbol: o.shortSymbol,
      diffAtEntryBps: o.diffAtEntry * 10_000,
      fundingR: o.fundingR,
      divergenceR: o.divergenceR,
      netR: o.netR,
      status: o.status,
      exitReason: o.exitReason,
      openedAt: o.openedAt,
    }));

  return {
    laneId: FC_PAPER_LANE_ID,
    universe: FC_UNIVERSE,
    breakEven: {
      pairFeeBps: FC_PAIR_FEE_BPS,
      feeSafetyMultiple: FC_FEE_SAFETY_MULTIPLE,
      targetHoldHours: FC_TARGET_HOLD_HOURS,
      requiredDiffBpsPer8h: breakEven.requiredDiffPerInterval * 10_000,
    },
    divergenceStopBps: FC_DIVERGENCE_STOP_BPS,
    maxHoldHours: FC_MAX_HOLD_HOURS,
    openCount: open.length,
    resolvedCount: resolved.length,
    expiredCount: expired.length,
    netAvgR,
    wr: resolved.length ? nets.filter((r) => r > 0).length / resolved.length : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : null,
    totalNetR: nets.reduce((a, b) => a + b, 0),
    avgFundingR: mean(resolved.map((o) => (finite(o.fundingR) ? (o.fundingR as number) : 0))),
    avgDivergenceR: mean(resolved.map((o) => (finite(o.divergenceR) ? (o.divergenceR as number) : 0))),
    avgCostR: mean(resolved.map((o) => (finite(o.costR) ? (o.costR as number) : 0))),
    avgHoldHours: mean(resolved.map((o) => (finite(o.holdHours) ? (o.holdHours as number) : 0))),
    avgIntervalsAccrued: mean(resolved.map((o) => o.fundingIntervalsAccrued)),
    staleAccrualsTotal: observations.reduce((a, o) => a + o.staleAccruals, 0),
    exitReasons: {
      diffCollapsed: resolved.filter((o) => o.exitReason === "DIFF_COLLAPSED").length,
      divergenceStop: resolved.filter((o) => o.exitReason === "DIVERGENCE_STOP").length,
      maxHold: resolved.filter((o) => o.exitReason === "MAX_HOLD_MTM").length,
    },
    edgeReady,
    topRecent,
    cycleMeta: cycleMeta ?? null,
  };
}
