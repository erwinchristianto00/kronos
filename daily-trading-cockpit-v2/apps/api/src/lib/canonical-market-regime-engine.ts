/**
 * CANONICAL MARKET REGIME — engine (2026-08, requirement #3 of the canonical-market-regime rollout
 * that replaces the fixed-20 candidate LONG/SHORT vote — scan-service.ts's deriveMarketRegime — as
 * the production regime source). See canonical-market-regime-universe.ts (requirement #2, already
 * built) for the versioned, filtered, dynamic symbol list this engine reads from, and
 * canonical-market-regime-execution-policy.ts / canonical-market-regime-calibration.ts for the two
 * sibling modules that already declare a LOCAL STRUCTURAL MIRROR of this file's eventual
 * `CanonicalMarketRegimeSnapshot` (they were authored before this file existed and are designed to
 * swap their local mirror for a real import of this file with zero logic changes once it lands —
 * see their own file headers). This file's own field names (`validSymbolCount`, `requiredSymbolCount`,
 * `coveragePct`, etc.) are already chosen to match those mirrors so a later stage's assembly is a
 * straight fold, not a rename.
 *
 * BUILD PLAN (4 stages; this file grows across all of them — see the top-of-file stage markers below
 * as they accumulate):
 *   STAGE 1 (DONE) — raw data-ingestion + source-observation-identity dedup + honest coverage
 *     bookkeeping. No direction/breadth/cohesion/dispersion/riskStress computation, no state machine,
 *     no persistence, no CanonicalMarketRegimeSnapshot type yet — those are stages 2-4.
 *   STAGE 2 (DONE) — pure compute, no I/O beyond what the caller already supplies: per-symbol
 *     returnFastPct/returnSlowPct from stage 1's candle window, capped-liquidity-weighted
 *     directionFast/directionSlow, equal-weighted breadth, robust (median/MAD-based) cohesion +
 *     dispersion, and the riskStress composite. riskStress moved INTO this stage from the original
 *     stage-3 sketch below per an explicit instruction at implementation time (not scope drift) — it
 *     is a pure function taking already-fetched raw ingredients (a long BTC candle series, per-symbol
 *     funding rates, per-symbol OI-change-%) as parameters, since fetching those (BTC's own 182-candle
 *     ATR window is far longer than stage 1's 25-candle per-symbol window; funding/OI need their own
 *     getFuturesFlow calls) is an I/O concern for a later orchestration stage, not this pure-compute
 *     one. Still no state machine, no persistence, no CanonicalMarketRegimeSnapshot type.
 *   STAGE 3 (DONE) — the projection state machine: coverage classification (stage 1's counts into
 *     VALID/DEGRADED/INVALID), the raw per-cycle candidateDirection signal, the canonical
 *     BULLISH/BEARISH/MIXED projection with asymmetric hysteresis (enter=3 consecutive confirmations,
 *     revert=1, immediate), the six independent overlays (TRANSITION/HIGH_STRESS/PANIC/LOW_COVERAGE/
 *     ROTATIONAL/FRAGMENTED), the PANIC sub-state-machine (immediate entry, 4-cycle exit hysteresis),
 *     and the dedup consumption point (advanceCanonicalMarketRegimeEngineProjection calls
 *     diffCanonicalMarketRegimeEngineObservationIds below against the PERSISTED prior state's own
 *     sourceObservationIds before advancing any confirmation counter). Still no persistence, no
 *     schemaVersion/engineVersion/calibrationVersion, no CanonicalMarketRegimeSnapshot type, no kill
 *     switch — those remain stage 4.
 *   STAGE 4 (DONE) — the durability + public-API layer: the versioned CanonicalMarketRegimeSnapshot
 *     type (schemaVersion/engineVersion/calibrationVersion + per-symbol raw features + coverage +
 *     confidence + state history + status enum), the PURE assembler
 *     (computeCanonicalMarketRegimeSnapshot) that folds stages 1-3's outputs into one, persistence
 *     (data/canonical-market-regime-history.json, atomic tmp+rename) via a strict/tolerant reader pair
 *     mirroring cortex-brain-store.ts's readCortexBrainStoreStrict/CortexBrainStore discipline exactly,
 *     the kill switch (CANONICAL_MARKET_REGIME_ENGINE_DISABLED), and the two non-nullable public entry
 *     points (computeCanonicalMarketRegimeSnapshot, getCanonicalMarketRegimeSnapshot) later stages
 *     import by name. Deliberately NOT in this stage (left for a genuinely separate, later wiring
 *     stage, per that stage's own explicit scope instructions): resolving the dynamic universe, the
 *     impure fetch shell that actually calls BinanceClient for the long BTC candle series + per-symbol
 *     getFuturesFlow, cadence scheduling, and any app.ts wiring. See the file header's STAGE 4 SCOPE
 *     section below for the cross-cutting design notes.
 *
 * ── SCOPE OF THIS FILE, TODAY ────────────────────────────────────────────────────────────────────
 * `ingestCanonicalMarketRegimeRawObservations` is the one entry point a later stage's orchestration
 * cycle calls every tick. It deliberately takes a plain `symbols: string[]`, NOT a dependency on
 * canonical-market-regime-universe.ts — the caller resolves the universe first (typically via
 * `resolveCanonicalMarketRegimeUniverse(...).symbols`) and passes the list in, mirroring how
 * regime-engine-service.ts's own `runRegimeEngineCycle` is the single place that composes
 * independently-fetchable pieces, not something each piece reaches out and grabs for itself. This
 * keeps ingestion trivially unit-testable against a bare symbol array with no universe-store/cache
 * entanglement.
 *
 * ── WHY ONE FETCH SERVES BOTH directionFast AND directionSlow ───────────────────────────────────
 * Per the approved design, directionFast (6-bar/6h) and directionSlow (24-bar/24h) are BOTH derived
 * from the SAME 1h-candle series per symbol — this is a deliberate API-call-minimizing decision, not
 * an oversight of "the two configured timeframes" phrasing. `CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED`
 * (25) is sized to cover the wider (24-bar) window; a later stage slices the same `.candles` array by
 * `CANONICAL_MARKET_REGIME_ENGINE_FAST_LOOKBACK_BARS`/`..._SLOW_LOOKBACK_BARS` rather than re-fetching.
 * Changing the candle interval or either lookback-bar constant later changes what "N confirmations"
 * means downstream in the stage-3 hysteresis — re-derive that relationship explicitly, do not treat
 * this as a free parameter.
 *
 * ── FAIL-CLOSED DATA QUALITY (mirrors replay-tier-a-core.ts's "missing inputs are {value:null},
 * never fabricated" discipline, and canonical-market-regime-universe.ts's own MISSING/exclude rule) ─
 * `CanonicalMarketRegimeEngineRawSymbolResult` is a discriminated union: a MISSING row carries NO
 * candle/numeric fields at all, only a `reason` + `detail` string. This is a type-level guarantee, not
 * just a runtime convention — nothing downstream can accidentally read a `.candles` off a MISSING
 * result, and `sourceObservationIds` (the dedup identity map) only ever contains OK symbols, so a
 * MISSING symbol is structurally excluded from any later ratio/average's denominator rather than
 * silently contributing a flat/zero reading. This stage exposes the honest counts and reasons; it
 * does NOT decide LOW_COVERAGE/blocking — that is a later stage's (and
 * canonical-market-regime-execution-policy.ts's) job.
 *
 * ── SOURCE-OBSERVATION-IDENTITY DEDUP (requirement #4) ───────────────────────────────────────────
 * `buildCanonicalMarketRegimeEngineSourceObservationId(symbol, interval, lastClosedCandleOpenTimeMs)`
 * is the identity key: unchanged iff the same completed candle is still the latest one for that
 * symbol/interval. `diffCanonicalMarketRegimeEngineObservationIds` is the STRUCTURAL guarantee this
 * requirement asks for — a real, independently-testable pure function a later stage MUST call
 * (against its persisted prior snapshot's own `sourceObservationIds`) before advancing any hysteresis
 * confirmation counter or inflating confidence, rather than relying on a comment's promise of
 * idempotency. This file does not itself own "the prior" (that is stage 3/4's persisted-snapshot
 * concern) — it only supplies the comparison primitive and the per-cycle identity map to compare.
 *
 * ── STAGE 2 SCOPE (this pass) ────────────────────────────────────────────────────────────────────
 * `buildCanonicalMarketRegimeEngineSymbolStats` turns one ingestion cycle (stage 1's output) plus a
 * caller-supplied liquidity map into per-symbol `{returnFastPct, returnSlowPct, quoteVolume24hUsd}`
 * rows — a MISSING stage-1 symbol always maps to `{dataQuality:"MISSING", returnFastPct:null,
 * returnSlowPct:null, quoteVolume24hUsd:null}`, never a partial/zero-filled row, so it is structurally
 * excluded from every statistic below rather than conventionally skipped.
 *
 * Direction (capped-liquidity-weighted) and breadth (equal-weighted) are DELIBERATELY separate code
 * paths, not one function with swappable weights: `computeCanonicalMarketRegimeEngineBreadth` and
 * `computeCanonicalMarketRegimeEngineCohesionDispersion` both take a narrower
 * `CanonicalMarketRegimeEngineSymbolReturnOnly` parameter type that structurally OMITS
 * `quoteVolume24hUsd` — a type-level guarantee (not just a runtime convention) that liquidity can
 * never leak into an equal-weight statistic even by accident.
 *
 * `computeCanonicalMarketRegimeEngineLiquidityWeights` implements the design's capped-liquidity
 * formula (raw weight = sqrt(quoteVolume24hUsd), normalized toward summing to 1, then iterative
 * water-filling caps any symbol above `CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT` and
 * redistributes the excess among still-uncapped symbols) — see its own doc comment for the
 * infeasible-cap case (too few active symbols for the cap to be satisfiable at all, e.g. a 1-2 symbol
 * universe, OR a volume-pipeline-only partial outage leaving only a handful of symbols with usable
 * volume out of a much larger attempted universe — FINDING 1) and the now-UNCONDITIONAL invariant that
 * no returned weight ever exceeds the cap: infeasible cases cap every active symbol at exactly the
 * ceiling and leave the shortfall unallocated (sum < 1) rather than ever letting the cap itself be
 * defeated to force a sum of exactly 1.
 *
 * `computeCanonicalMarketRegimeEngineCohesionDispersion` uses median-based (never mean/variance)
 * robust statistics: cohesion is a same-sign-as-median AGREEMENT FRACTION, dispersion is the Median
 * Absolute Deviation of returnFastPct scaled by the standard 1.4826 consistency constant.
 *
 * `computeCanonicalMarketRegimeEngineRiskStress` is the one function in this stage that takes raw
 * ingredients this file cannot itself fetch (a long BTC candle series, per-symbol funding rates,
 * per-symbol OI-change-%) — see its own doc comment for the exact weighting and the deliberate
 * renormalization (never a zero-fill) when the BTC term is unavailable. It reuses
 * `computeBtcAtrPercentile` (btc-atr-percentile-cache.ts) and `classifyCrowdingAtThresholds` /
 * `FIXED_CROWDING_THRESHOLDS` / `OI_TREND_PCT` (derivatives-crowding.ts) UNCHANGED, per the approved
 * design's explicit "reuse, do not reimplement" instruction — both are pure functions, so importing
 * them here does not add any I/O to this otherwise-pure stage.
 *
 * Every aggregate in this stage (direction/breadth/cohesion/riskStress's funding+OI shares) follows
 * the same "honest empty-input" convention: an empty/degenerate considered-set renders the numeric
 * field as 0 (never NaN, never a fabricated non-zero guess) AND exposes a companion considered-count
 * field alongside it, so a later stage can distinguish "genuinely flat/calm" from "no usable data this
 * cycle" — that distinction is this stage's job to preserve, not to resolve; deciding LOW_COVERAGE/
 * blocking from it is still a later stage's job exactly as stage 1's own header already established
 * for coverage.
 *
 * ── STAGE 3 SCOPE (this pass) ────────────────────────────────────────────────────────────────────
 * `classifyCanonicalMarketRegimeEngineCoverage` turns stage 1's own honest validSymbolCount/
 * requiredSymbolCount/coveragePct into VALID/DEGRADED/INVALID — the ONLY place those thresholds live.
 * `computeCanonicalMarketRegimeEngineCandidateDirection` turns stage 2's directionFast/directionSlow/
 * breadth/cohesion into a raw per-cycle BULLISH/BEARISH/MIXED signal — a plain four-term AND per
 * direction, not a scored vote, and NEITHER hysteresis- nor coverage-aware by itself.
 *
 * `advanceCanonicalMarketRegimeEngineProjection` is the one state-machine entry point. It forces
 * candidateDirection to MIXED outright whenever coverage isn't VALID (requirement #5), diffs this
 * cycle's sourceObservationIds against the PERSISTED prior state's own copy before advancing anything
 * (requirement #4 — a genuine duplicate cycle returns the prior state completely unchanged), then runs
 * two SEPARATE steps every genuinely-new cycle: an unconditional revert-check (leaving a directional
 * projection is always immediate — one cycle, no confirmation) and an enter-check gated on the
 * revert-check's OWN output being MIXED (entering a directional projection needs
 * CANONICAL_MARKET_REGIME_ENGINE_ENTER_CONFIRM_CYCLES=3 consecutive confirmations). Because the
 * enter-check can only ever run once the local `projection` value already reads MIXED for that same
 * cycle, and the revert-check is the only code path that can write a directional value away, a direct
 * BULLISH<->BEARISH transition has no code path — see advanceCanonicalMarketRegimeEngineProjection's
 * own doc comment for the full trace. PANIC (`canonicalMarketRegimeEnginePanicConditionMet` /
 * `advanceCanonicalMarketRegimeEnginePanicState`) is a fully independent sub-state-machine: immediate
 * single-cycle entry on a predeclared 4-condition AND, clearing only after
 * CANONICAL_MARKET_REGIME_ENGINE_PANIC_EXIT_CONFIRM_CYCLES=4 consecutive non-recurrences. PANIC's own
 * dedup gate is INDEPENDENT of the candle-identity check the directional hysteresis above uses —
 * FINDING 2 fix, 2026-08: riskStress's raw ingredients (funding/OI/BTC vol) can escalate faster than
 * the hourly candles sourceObservationIds is keyed on, so a candle-duplicate cycle whose riskStress
 * genuinely moved still re-evaluates and, if warranted, advances PANIC — see
 * advanceCanonicalMarketRegimeEngineProjection's own doc comment, step 0, for the exact two-identity
 * design.
 * `computeCanonicalMarketRegimeEngineOverlays` derives all six overlays (TRANSITION/HIGH_STRESS/
 * PANIC/LOW_COVERAGE/ROTATIONAL/FRAGMENTED) independently — none gates another.
 *
 * `CanonicalMarketRegimeEnginePriorState`/`...StateHistory` are this stage's own cross-cycle memory
 * shape — NOT yet the full (stage 4) `CanonicalMarketRegimeSnapshot`, but field-for-field aligned with
 * that type's eventual `stateHistory`/`overlays`/`projection`/`coverage` shape (cross-checked directly
 * against canonical-market-regime-execution-policy.ts's own local structural mirror) so stage 4's
 * assembly is a straight fold, not a rename.
 *
 * ── STAGE 4 SCOPE (this pass) ────────────────────────────────────────────────────────────────────
 * `CanonicalMarketRegimeSnapshot` is field-for-field cross-checked against BOTH
 * canonical-market-regime-execution-policy.ts's and canonical-market-regime-calibration.ts's own
 * pre-existing local structural mirrors (both authored before this file existed, per their own file
 * headers) so a later stage's "swap the local mirror for a real import" is a straight fold for the
 * fields those mirrors already declared. TWO deliberate, necessary DEVIATIONS from those mirrors, both
 * called out loudly here because a future reconciliation pass needs to know they are required, not
 * accidental drift: (1) `enterCandidate`/`enterCandidateCycles` are ADDED fields neither mirror
 * declares — see this type's own inline comment for why the enter-confirmation hysteresis cannot
 * survive repeated `computeCanonicalMarketRegimeSnapshot` calls without them; (2)
 * canonical-market-regime-calibration.ts's own `CanonicalMarketRegimeSnapshotLike` additionally omits
 * `atIso` and `sourceObservationIds` (present here and in execution-policy.ts's mirror) — harmless
 * until that file actually imports the real type, at which point its own fixtures need those two
 * fields added; not fixed here since touching that file is out of this stage's scope.
 *
 * `computeCanonicalMarketRegimeSnapshot(rawFeatures, priorSnapshot, calibrationParams, nowMs,
 * calibrationVersion?)` is the pure assembler — position-and-name compatible with
 * canonical-market-regime-calibration.ts's own already-declared `ComputeCanonicalMarketRegimeSnapshotFn`
 * (the 5th parameter is a genuine addition real orchestration can use; a function with an extra
 * OPTIONAL trailing parameter remains assignable to a narrower 4-parameter function type, so this does
 * not break that compatibility). It internally re-derives the stage-3 `CanonicalMarketRegimeEnginePriorState`
 * from `priorSnapshot` and calls stages 2-3's own already-tested functions unchanged — no
 * recomputation of their logic, only orchestration. Requirement #4 (test E) is enforced HERE too, one
 * layer above stage 3's own internal dedup: a genuinely duplicate cycle (unchanged
 * `sourceObservationIds` AND unchanged universe-staleness AND unchanged riskStress — FINDING 2 fix,
 * 2026-08: riskStress's own raw ingredients funding/OI/BTC-vol can escalate faster than the hourly
 * candles `sourceObservationIds` is keyed on, so it gets its own independent identity check, never
 * folded into or gated by the candle check) returns `priorSnapshot` completely untouched — not even
 * `atMs`/`atIso` advance — rather than assembling a new object that merely happens to carry identical
 * projection/overlays/stateHistory. riskStress itself (cheap, pure) is now always computed regardless
 * of duplicate status, so only direction/breadth/cohesion remain skippable on a genuine duplicate.
 *
 * `CANONICAL_MARKET_REGIME_ENGINE_MIN_UNIVERSE_SIZE` is a second, independent failure mode from
 * ordinary LOW_COVERAGE — see its own doc comment — forcing `DEGRADED_INSUFFICIENT_SYMBOLS` +
 * INVALID coverage (which the existing, untouched coverage-forces-MIXED machinery then handles exactly
 * like any other invalid-coverage cycle). `rawFeatures.universeStale` is the analogous caller-supplied
 * signal for the universe module's own bounded-staleness ceiling (a later orchestration stage's
 * concern to compute; this file has no universe-store dependency, matching stage 1's own established
 * convention of taking `symbols: string[]` rather than reaching for the universe store itself) and
 * forces `DEGRADED_STALE_UNIVERSE` the same way.
 *
 * The persisted store (`CanonicalMarketRegimeSnapshotStore`, `data/canonical-market-regime-history.json`)
 * mirrors cortex-brain-store.ts's `CortexBrainStore` exactly: a STRICT reader
 * (`readCanonicalMarketRegimeSnapshotStoreStrict`) that validates every field and returns one of a
 * closed set of statuses with no partial trust, plus a TOLERANT runtime loader (the store class's own
 * constructor) that DISCARDS AND RE-SEEDS (never silently repairs) on any schema mismatch or corrupt
 * file. `record()` is itself dedup-aware (via `diffCanonicalMarketRegimeEngineObservationIds`, reused
 * rather than reimplemented) — a duplicate-cycle snapshot is never appended to history and never
 * triggers a disk write, so `CANONICAL_MARKET_REGIME_SNAPSHOT_MAX_HISTORY`(4000) history rows correspond to genuinely-new candle
 * closes only (roughly hourly under this engine's 1h candle interval, NOT this engine's own faster
 * 5-minute tick cadence — see that constant's own doc comment for the corrected sizing math).
 *
 * `degradedLowCoverageSnapshot(nowMs, reason, status?)` is the ONE safe-default builder — reused
 * verbatim by the kill switch, cold start (no snapshot ever recorded), AND is available for a future
 * orchestration stage's own COMPUTE_ERROR catch — never several ad hoc "safe" objects that could drift
 * apart. `getCanonicalMarketRegimeSnapshot(...)` is the NON-NULLABLE public getter every execution-
 * affecting consumer eventually calls: kill switch active -> `ENGINE_DISABLED` (checked BEFORE ever
 * touching the store, so a disabled engine performs no disk I/O either); otherwise the store's own
 * `latest` if one exists, else a cold-start degraded snapshot. There is no `null`/`undefined`/
 * `{allowed:true}`-shaped fallback anywhere in this call chain — a missing/never-ticked/disabled
 * engine can only ever narrow eligibility once wired into canonical-market-regime-execution-policy.ts,
 * never accidentally widen it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { completedCandles, candleIntervalMs, type Candle } from "@dtc/shared";
import { computeBtcAtrPercentile } from "./btc-atr-percentile-cache.js";
import {
  classifyCrowdingAtThresholds,
  FIXED_CROWDING_THRESHOLDS,
  OI_TREND_PCT,
  type CrowdingThresholds,
} from "./derivatives-crowding.js";
import type { AxisRegimeFamily } from "./current-guard-variant-matrix.js";

// ─── constants ─────────────────────────────────────────────────────────────────

/** Single interval driving BOTH directionFast and directionSlow — see file header. Not env-tunable:
 *  changing it silently redefines what the stage-3 hysteresis's confirmation counters mean. */
export const CANONICAL_MARKET_REGIME_ENGINE_CANDLE_INTERVAL = "1h";
export const CANONICAL_MARKET_REGIME_ENGINE_FAST_LOOKBACK_BARS = 6;
export const CANONICAL_MARKET_REGIME_ENGINE_SLOW_LOOKBACK_BARS = 24;
/** A return over N bars needs N+1 closes (the reference close N bars back, plus the latest). Sized to
 *  the wider (slow) window since it covers the narrower (fast) one too. */
export const CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED = CANONICAL_MARKET_REGIME_ENGINE_SLOW_LOOKBACK_BARS + 1;
/** Small buffer above the strict minimum so an off-by-one in what the exchange actually returns this
 *  cycle doesn't tip a symbol from OK into MISSING. */
export const CANONICAL_MARKET_REGIME_ENGINE_CANDLES_FETCH_LIMIT = CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED + 5;

const BINANCE_FUTURES_BASE_URL = "https://fapi.binance.com";

// ─── types ─────────────────────────────────────────────────────────────────────

export type CanonicalMarketRegimeEngineDataQuality = "OK" | "MISSING";

export type CanonicalMarketRegimeEngineMissingReason =
  | "FETCH_ERROR"
  | "MALFORMED_RESPONSE"
  | "INSUFFICIENT_COMPLETED_CANDLES"
  | "NON_CONTIGUOUS_CANDLES"
  | "UNSUPPORTED_INTERVAL";

/** A successful cycle's per-symbol raw material: the most recent
 *  `CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED` COMPLETED (never in-progress), verified-contiguous
 *  1h candles, ascending by openTime. Later stages slice this for returnFastPct/returnSlowPct — this
 *  stage does not compute either. */
export interface CanonicalMarketRegimeEngineRawSymbolObservation {
  symbol: string;
  dataQuality: "OK";
  candles: Candle[];
  lastClosedCandleOpenTimeMs: number;
  /** `${symbol}|${interval}|${lastClosedCandleOpenTimeMs}` — see buildCanonicalMarketRegimeEngineSourceObservationId. */
  sourceObservationId: string;
}

/** No numeric/candle fields by construction — see file header's fail-closed-data-quality note. */
export interface CanonicalMarketRegimeEngineMissingSymbolObservation {
  symbol: string;
  dataQuality: "MISSING";
  reason: CanonicalMarketRegimeEngineMissingReason;
  detail: string;
}

export type CanonicalMarketRegimeEngineRawSymbolResult =
  | CanonicalMarketRegimeEngineRawSymbolObservation
  | CanonicalMarketRegimeEngineMissingSymbolObservation;

/** This cycle's full, honest ingestion result — every symbol attempted appears in `perSymbol` exactly
 *  once, OK or MISSING. `requiredSymbolCount` is the attempted universe size (never narrowed), so
 *  `coveragePct` cannot be inflated by quietly shrinking its own denominator. */
export interface CanonicalMarketRegimeEngineRawIngestionCycle {
  atMs: number;
  interval: string;
  requiredSymbolCount: number;
  validSymbolCount: number;
  /** Fraction in [0,1], NOT a 0-100 percentage. 0 when requiredSymbolCount is 0 (vacuous, not NaN). */
  coveragePct: number;
  perSymbol: Record<string, CanonicalMarketRegimeEngineRawSymbolResult>;
  /** Dedup identity map — OK symbols only. Feed to diffCanonicalMarketRegimeEngineObservationIds. */
  sourceObservationIds: Record<string, string>;
  missingSymbols: Array<{ symbol: string; reason: CanonicalMarketRegimeEngineMissingReason; detail: string }>;
  missingReasonCounts: Record<CanonicalMarketRegimeEngineMissingReason, number>;
}

export type CanonicalMarketRegimeEngineFetchJson = (url: string) => Promise<unknown>;

export interface CanonicalMarketRegimeEngineIngestionOptions {
  interval?: string;
  candlesRequired?: number;
  fetchLimit?: number;
  fetchJson?: CanonicalMarketRegimeEngineFetchJson;
}

export interface CanonicalMarketRegimeEngineObservationDelta {
  /** True iff no symbol's sourceObservationId changed and no previously-present symbol dropped out —
   *  i.e. this cycle produced no genuinely new completed-candle evidence anywhere. A cold start
   *  (`prior === null`) is NEVER a duplicate, even against an empty `current`. */
  isDuplicateCycle: boolean;
  /** Symbols whose id changed OR are newly present this cycle, sorted for deterministic assertions. */
  changedSymbols: string[];
  /** Symbols present in `prior` but absent from `current` this cycle, sorted. */
  droppedSymbols: string[];
}

// ─── URL + default network access (raw fetch — BinanceClient has no futures-klines method today;
//     follows the exact convention canonical-market-regime-universe.ts already established for
//     exchangeInfo/ticker/24hr rather than extending that shared, heavily-used client) ─────────────

export function buildCanonicalMarketRegimeEngineFuturesKlinesUrl(symbol: string, interval: string, limit: number): string {
  const url = new URL(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/klines`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

const defaultCanonicalMarketRegimeEngineFetchJson: CanonicalMarketRegimeEngineFetchJson = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
};

// ─── identity ──────────────────────────────────────────────────────────────────

export function buildCanonicalMarketRegimeEngineSourceObservationId(
  symbol: string,
  interval: string,
  lastClosedCandleOpenTimeMs: number,
): string {
  return `${symbol}|${interval}|${lastClosedCandleOpenTimeMs}`;
}

// ─── per-symbol raw fetch (never throws — any failure degrades to a MISSING result; mirrors
//     canonical-market-regime-universe.ts's fetchExpensiveMeta discipline exactly) ──────────────────

export async function fetchCanonicalMarketRegimeEngineRawSymbolObservation(
  symbol: string,
  nowMs: number,
  opts: CanonicalMarketRegimeEngineIngestionOptions = {},
): Promise<CanonicalMarketRegimeEngineRawSymbolResult> {
  const interval = opts.interval ?? CANONICAL_MARKET_REGIME_ENGINE_CANDLE_INTERVAL;
  const candlesRequired = opts.candlesRequired ?? CANONICAL_MARKET_REGIME_ENGINE_CANDLES_REQUIRED;
  const fetchLimit = opts.fetchLimit ?? CANONICAL_MARKET_REGIME_ENGINE_CANDLES_FETCH_LIMIT;
  const fetchJson = opts.fetchJson ?? defaultCanonicalMarketRegimeEngineFetchJson;

  const intervalMs = candleIntervalMs(interval);
  if (intervalMs === null) {
    return { symbol, dataQuality: "MISSING", reason: "UNSUPPORTED_INTERVAL", detail: `unsupported candle interval "${interval}"` };
  }

  let payload: unknown;
  try {
    payload = await fetchJson(buildCanonicalMarketRegimeEngineFuturesKlinesUrl(symbol, interval, fetchLimit));
  } catch (error) {
    return { symbol, dataQuality: "MISSING", reason: "FETCH_ERROR", detail: error instanceof Error ? error.message : String(error) };
  }

  if (!Array.isArray(payload) || payload.some((entry) => !Array.isArray(entry) || entry.length < 6)) {
    return { symbol, dataQuality: "MISSING", reason: "MALFORMED_RESPONSE", detail: "futures klines response was not a well-formed array of >=6-element rows" };
  }

  const parsed: Candle[] = [];
  for (const entry of payload) {
    const openTime = Number(entry[0]);
    const open = Number(entry[1]);
    const high = Number(entry[2]);
    const low = Number(entry[3]);
    const close = Number(entry[4]);
    const volume = Number(entry[5]);
    if (![openTime, open, high, low, close, volume].every((v) => Number.isFinite(v))) {
      return { symbol, dataQuality: "MISSING", reason: "MALFORMED_RESPONSE", detail: "one or more klines rows had a non-finite OHLCV field" };
    }
    parsed.push({ openTime, open, high, low, close, volume });
  }

  // Defensive sort + de-dupe by openTime (paranoia, not a correction of a known bug): mirrors
  // replay-tier-a-core.ts's own independent re-check discipline against a mis-sorted/duplicated feed.
  // Binance already returns klines ascending and unique; this only guards a misbehaving/injected
  // fetchJson (e.g. a test double, or a future alternate provider).
  const byOpenTime = new Map<number, Candle>();
  for (const candle of parsed) byOpenTime.set(candle.openTime, candle);
  const sorted = [...byOpenTime.values()].sort((a, b) => a.openTime - b.openTime);

  const completed = completedCandles(sorted, interval, nowMs);
  if (completed.length < candlesRequired) {
    return {
      symbol,
      dataQuality: "MISSING",
      reason: "INSUFFICIENT_COMPLETED_CANDLES",
      detail: `${completed.length}/${candlesRequired} completed ${interval} candles available`,
    };
  }

  const window = completed.slice(-candlesRequired);
  for (let i = 1; i < window.length; i += 1) {
    if (window[i]!.openTime - window[i - 1]!.openTime !== intervalMs) {
      return {
        symbol,
        dataQuality: "MISSING",
        reason: "NON_CONTIGUOUS_CANDLES",
        detail: `gap between completed candles at window index ${i - 1}/${i} of the required ${candlesRequired}-bar window`,
      };
    }
  }

  const lastClosedCandleOpenTimeMs = window[window.length - 1]!.openTime;
  return {
    symbol,
    dataQuality: "OK",
    candles: window,
    lastClosedCandleOpenTimeMs,
    sourceObservationId: buildCanonicalMarketRegimeEngineSourceObservationId(symbol, interval, lastClosedCandleOpenTimeMs),
  };
}

// ─── per-cycle ingestion across the whole universe ──────────────────────────────

export async function ingestCanonicalMarketRegimeRawObservations(
  symbols: string[],
  nowMs: number,
  opts: CanonicalMarketRegimeEngineIngestionOptions = {},
): Promise<CanonicalMarketRegimeEngineRawIngestionCycle> {
  const interval = opts.interval ?? CANONICAL_MARKET_REGIME_ENGINE_CANDLE_INTERVAL;
  const results = await Promise.all(symbols.map((symbol) => fetchCanonicalMarketRegimeEngineRawSymbolObservation(symbol, nowMs, opts)));

  const perSymbol: Record<string, CanonicalMarketRegimeEngineRawSymbolResult> = {};
  const sourceObservationIds: Record<string, string> = {};
  const missingSymbols: Array<{ symbol: string; reason: CanonicalMarketRegimeEngineMissingReason; detail: string }> = [];
  const missingReasonCounts: Record<CanonicalMarketRegimeEngineMissingReason, number> = {
    FETCH_ERROR: 0,
    MALFORMED_RESPONSE: 0,
    INSUFFICIENT_COMPLETED_CANDLES: 0,
    NON_CONTIGUOUS_CANDLES: 0,
    UNSUPPORTED_INTERVAL: 0,
  };

  let validSymbolCount = 0;
  for (const result of results) {
    perSymbol[result.symbol] = result;
    if (result.dataQuality === "OK") {
      validSymbolCount += 1;
      sourceObservationIds[result.symbol] = result.sourceObservationId;
    } else {
      missingSymbols.push({ symbol: result.symbol, reason: result.reason, detail: result.detail });
      missingReasonCounts[result.reason] += 1;
    }
  }

  const requiredSymbolCount = symbols.length;
  const coveragePct = requiredSymbolCount > 0 ? validSymbolCount / requiredSymbolCount : 0;

  return {
    atMs: nowMs,
    interval,
    requiredSymbolCount,
    validSymbolCount,
    coveragePct,
    perSymbol,
    sourceObservationIds,
    missingSymbols,
    missingReasonCounts,
  };
}

// ─── source-observation-identity dedup (requirement #4) ─────────────────────────

/**
 * Pure, structural duplicate-cycle check — see file header. A later stage calls this with `current`
 * from this cycle's `sourceObservationIds` and `prior` from its PERSISTED prior snapshot's own
 * `sourceObservationIds` (not a freestanding ledger this file keeps itself), before advancing any
 * hysteresis confirmation counter or inflating confidence.
 */
export function diffCanonicalMarketRegimeEngineObservationIds(
  current: Record<string, string>,
  prior: Record<string, string> | null,
): CanonicalMarketRegimeEngineObservationDelta {
  if (!prior) {
    return { isDuplicateCycle: false, changedSymbols: Object.keys(current).sort(), droppedSymbols: [] };
  }
  const changedSymbols: string[] = [];
  for (const [symbol, id] of Object.entries(current)) {
    if (prior[symbol] !== id) changedSymbols.push(symbol);
  }
  const droppedSymbols = Object.keys(prior).filter((symbol) => !(symbol in current));
  return {
    isDuplicateCycle: changedSymbols.length === 0 && droppedSymbols.length === 0,
    changedSymbols: changedSymbols.sort(),
    droppedSymbols: droppedSymbols.sort(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 2 — pure compute: returns, capped-liquidity direction, breadth, cohesion/dispersion,
// riskStress. See the file header's "STAGE 2 SCOPE" section for the cross-cutting design notes
// (honest-empty-input convention, direction/breadth type-level separation, reuse-not-reimplement).
// Nothing below performs any I/O; every raw ingredient is a parameter supplied by the caller.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── per-symbol return computation ──────────────────────────────────────────────

/**
 * Simple (never log) percent return over `lookbackBars` completed candles, expressed as a fraction
 * (0.015 = +1.5%) — matches calibration.ts's own `returnOverLookback` formula exactly
 * (`closeNow / closePrev - 1`) so a replayed calibration history and this live engine agree on what
 * "return" means. `candles` must be ascending by openTime (stage 1's own contract). Returns null
 * (never 0) when there is not enough window, or either endpoint close is non-finite/non-positive —
 * missing/insufficient data is never fabricated into a flat reading.
 */
export function computeCanonicalMarketRegimeEngineReturnPct(candles: Candle[], lookbackBars: number): number | null {
  if (!Number.isFinite(lookbackBars) || lookbackBars <= 0) return null;
  if (candles.length < lookbackBars + 1) return null;
  const closeNow = candles[candles.length - 1]!.close;
  const closePrev = candles[candles.length - 1 - lookbackBars]!.close;
  if (!Number.isFinite(closeNow) || !Number.isFinite(closePrev) || !(closePrev > 0)) return null;
  return closeNow / closePrev - 1;
}

// ─── per-symbol stat assembly (stage 1's ingestion cycle + a liquidity map → returns) ───────────

/** Not yet the full (stage 3/4) `CanonicalMarketRegimePerSymbol` — `spreadBps`/`openInterestUsd`
 *  join in from canonical-market-regime-universe.ts's own per-symbol meta at a later stage; this is
 *  deliberately the minimal shape stage 2's own statistics actually need. */
export interface CanonicalMarketRegimeEngineSymbolStat {
  symbol: string;
  dataQuality: CanonicalMarketRegimeEngineDataQuality;
  returnFastPct: number | null;
  returnSlowPct: number | null;
  quoteVolume24hUsd: number | null;
}

/** The narrow shape `computeCanonicalMarketRegimeEngineBreadth` and
 *  `computeCanonicalMarketRegimeEngineCohesionDispersion` accept — see file header's STAGE 2 SCOPE
 *  note for why omitting `quoteVolume24hUsd` here is a type-level (not just runtime) guarantee. */
export type CanonicalMarketRegimeEngineSymbolReturnOnly = Pick<
  CanonicalMarketRegimeEngineSymbolStat,
  "symbol" | "dataQuality" | "returnFastPct"
>;

export interface CanonicalMarketRegimeEngineSymbolStatOptions {
  fastLookbackBars?: number;
  slowLookbackBars?: number;
}

/**
 * Joins one ingestion cycle's `perSymbol` (stage 1) with a caller-supplied liquidity map into a
 * deterministically-ordered (alphabetical by symbol — never insertion order, so repeated calls over
 * the same cycle are byte-identical) array covering every symbol the cycle attempted, OK or MISSING.
 * A MISSING symbol always gets `{returnFastPct:null, returnSlowPct:null, quoteVolume24hUsd:null}` —
 * its liquidity value is discarded even if `quoteVolume24hUsdBySymbol` happens to have an entry for
 * it, so a symbol with no usable candle data can never partially influence a liquidity-weighted stat
 * through its volume alone. A symbol absent from (or holding a non-finite value in)
 * `quoteVolume24hUsdBySymbol` gets `quoteVolume24hUsd: null` — excluded, never zero-filled.
 */
export function buildCanonicalMarketRegimeEngineSymbolStats(
  cycle: CanonicalMarketRegimeEngineRawIngestionCycle,
  quoteVolume24hUsdBySymbol: Record<string, number | null | undefined> = {},
  opts: CanonicalMarketRegimeEngineSymbolStatOptions = {},
): CanonicalMarketRegimeEngineSymbolStat[] {
  const fastLookbackBars = opts.fastLookbackBars ?? CANONICAL_MARKET_REGIME_ENGINE_FAST_LOOKBACK_BARS;
  const slowLookbackBars = opts.slowLookbackBars ?? CANONICAL_MARKET_REGIME_ENGINE_SLOW_LOOKBACK_BARS;

  return Object.keys(cycle.perSymbol)
    .sort()
    .map((symbol) => {
      const result = cycle.perSymbol[symbol]!;
      if (result.dataQuality !== "OK") {
        return { symbol, dataQuality: "MISSING", returnFastPct: null, returnSlowPct: null, quoteVolume24hUsd: null };
      }
      const rawVolume = quoteVolume24hUsdBySymbol[symbol];
      const quoteVolume24hUsd = typeof rawVolume === "number" && Number.isFinite(rawVolume) ? rawVolume : null;
      return {
        symbol,
        dataQuality: "OK",
        returnFastPct: computeCanonicalMarketRegimeEngineReturnPct(result.candles, fastLookbackBars),
        returnSlowPct: computeCanonicalMarketRegimeEngineReturnPct(result.candles, slowLookbackBars),
        quoteVolume24hUsd,
      };
    });
}

// ─── capped-liquidity-weighted direction (fast + slow) ──────────────────────────

/** 15% — see `computeCanonicalMarketRegimeEngineLiquidityWeights`'s doc comment for the full
 *  justification (bounds any one symbol, in practice always BTC, to roughly the combined weight of
 *  the next ~7 symbols at the floor). */
export const CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT = 0.15;

export interface CanonicalMarketRegimeEngineLiquidityEntry {
  symbol: string;
  quoteVolume24hUsd: number | null;
}

/**
 * Capped-liquidity weighting for direction ONLY (breadth stays equal-weight — see
 * `computeCanonicalMarketRegimeEngineBreadth`, a genuinely separate code path). Raw weight per symbol
 * = sqrt(quoteVolume24hUsd) (compresses the BTC-vs-microcap tail before capping), normalized to sum 1
 * over symbols with a finite, positive volume — a symbol with `quoteVolume24hUsd: null` (or <= 0, or
 * non-finite) is EXCLUDED entirely, never assigned a 0 weight that would still occupy a denominator
 * slot. Then iterative water-filling caps any symbol's normalized share above
 * `maxSingleSymbolWeightPct` and redistributes the excess proportionally among still-uncapped
 * symbols, repeating until nobody active exceeds the cap.
 *
 * INFEASIBLE-CAP CASE (a real, tested edge case, not a hypothetical — and the FINDING 1 fix site: a
 * volume-pipeline-only partial outage can shrink the ACTIVE set to a handful of symbols out of a much
 * larger attempted universe while candle coverage stays 100%, see computeCanonicalMarketRegimeSnapshot's
 * own volume-coverage check below): if too few symbols remain active for the cap to be satisfiable at
 * all while still summing to 1 (e.g. one symbol alone, or two symbols with 60/40 volume, both <
 * ceil(1/cap) members) — concretely, when EVERY remaining active symbol would exceed the cap under the
 * current pass's scale — capping them would leave positive budget with no uncapped receiver to absorb
 * it. UNLIKE an earlier version of this function, the cap is NEVER sacrificed to force the total to sum
 * to 1: every remaining active symbol is capped at exactly `maxSingleSymbolWeightPct` and the shortfall
 * is left UNALLOCATED. A thin, mostly-excluded liquidity set must never let its few survivors inflate
 * past the single-symbol cap just to make the numbers add up — a capped-but-under-1 result is the
 * honest reading of "not enough trustworthy liquidity data to weight a direction with confidence",
 * matching this file's own honest-empty/thin-input convention used everywhere else in this stage.
 *
 * INVARIANT (tested explicitly, and now UNCONDITIONAL — holds even in the infeasible case above and
 * even on the theoretically-unreachable iteration-ceiling safety net at the bottom of this function):
 * no returned weight ever exceeds `maxSingleSymbolWeightPct`. Once a symbol is capped, it is written
 * into the result exactly once, at exactly `maxSingleSymbolWeightPct` (or less, only in the safety-net
 * branch, never more), and is removed from every subsequent redistribution pass — it can never be
 * re-touched or pushed back above the cap by a later pass.
 *
 * Returns `{}` for an empty/all-excluded input. Every returned weight is in (0, `maxSingleSymbolWeightPct`];
 * the sum of all returned weights is at most 1 (up to floating-point epsilon) whenever the input is
 * non-empty, and is exactly 1 whenever enough symbols are active for the cap to be feasible (informally,
 * roughly `ceil(1/maxSingleSymbolWeightPct)` or more active symbols spread widely enough) — strictly
 * less than 1 only in the infeasible case above.
 */
export function computeCanonicalMarketRegimeEngineLiquidityWeights(
  entries: CanonicalMarketRegimeEngineLiquidityEntry[],
  maxSingleSymbolWeightPct: number = CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT,
): Record<string, number> {
  const raw = new Map<string, number>();
  for (const entry of entries) {
    if (entry.quoteVolume24hUsd !== null && Number.isFinite(entry.quoteVolume24hUsd) && entry.quoteVolume24hUsd > 0) {
      raw.set(entry.symbol, Math.sqrt(entry.quoteVolume24hUsd));
    }
  }
  if (raw.size === 0) return {};

  const cap =
    Number.isFinite(maxSingleSymbolWeightPct) && maxSingleSymbolWeightPct > 0 && maxSingleSymbolWeightPct <= 1
      ? maxSingleSymbolWeightPct
      : CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT;
  const EPS = 1e-9;

  let active = new Map(raw);
  const cappedWeights = new Map<string, number>();

  // `cappedWeights` only ever grows (never shrinks) each pass and is bounded by `raw.size`, so this
  // terminates in at most `raw.size` passes; the `+ 2` is defensive slack, not load-bearing.
  for (let pass = 0; pass < raw.size + 2; pass += 1) {
    const activeSymbols = [...active.keys()];
    if (activeSymbols.length === 0) break;
    const activeRawSum = activeSymbols.reduce((sum, symbol) => sum + active.get(symbol)!, 0);
    const budget = 1 - cappedWeights.size * cap;
    if (activeRawSum <= 0 || budget <= 0) {
      const share = budget > 0 ? Math.min(cap, budget / activeSymbols.length) : 0;
      for (const symbol of activeSymbols) cappedWeights.set(symbol, Math.max(0, share));
      active = new Map();
      break;
    }
    const scale = budget / activeRawSum;
    const overflowing = activeSymbols.filter((symbol) => active.get(symbol)! * scale > cap + EPS);
    if (overflowing.length === 0) {
      // Normal termination — nobody exceeds the cap this pass; finalize this residual set at its own
      // pro-rata share of `budget`.
      for (const symbol of activeSymbols) cappedWeights.set(symbol, active.get(symbol)! * scale);
      active = new Map();
      break;
    }
    if (overflowing.length === activeSymbols.length) {
      // INFEASIBLE-CAP CASE (see doc comment above, and FINDING 1): the full remaining `budget`, split
      // proportionally, would still push EVERY remaining active symbol over the cap — there is no
      // uncapped receiver left to absorb the excess. The cap is never sacrificed to force a sum of 1:
      // every remaining symbol is capped at exactly `cap` and the shortfall is left UNALLOCATED.
      for (const symbol of activeSymbols) cappedWeights.set(symbol, cap);
      active = new Map();
      break;
    }
    for (const symbol of overflowing) {
      cappedWeights.set(symbol, cap);
      active.delete(symbol);
    }
  }
  if (active.size > 0) {
    // Iteration ceiling exhausted without draining `active` — should be unreachable given the
    // monotonic-growth argument above; defensive safety net so this function can never drop a symbol
    // from its own return value, and (via the same `Math.min(cap, ...)` the main loop uses) never
    // emits a weight above `cap` even on this unreachable path.
    const budget = Math.max(0, 1 - cappedWeights.size * cap);
    const share = Math.min(cap, budget / active.size);
    for (const symbol of active.keys()) cappedWeights.set(symbol, share);
  }

  const result: Record<string, number> = {};
  for (const [symbol, weight] of cappedWeights) result[symbol] = weight;
  return result;
}

export interface CanonicalMarketRegimeEngineDirectionResult {
  directionFast: number;
  directionSlow: number;
  /** Symbols actually summed into directionFast — dataQuality OK, a finite returnFastPct, AND a
   *  usable (finite, positive) quoteVolume24hUsd. 0 with directionFast left at its initial 0 is the
   *  honest "no usable data" reading, distinguishable from a genuine flat market only via this count. */
  consideredSymbolCountFast: number;
  consideredSymbolCountSlow: number;
  /** The actual post-cap weights used for directionFast/directionSlow respectively — exposed for
   *  observability/testing (e.g. asserting no symbol exceeds the cap), not required by any consumer. */
  weightsBySymbolFast: Record<string, number>;
  weightsBySymbolSlow: Record<string, number>;
}

function weightedDirectionForHorizon(
  stats: CanonicalMarketRegimeEngineSymbolStat[],
  returnField: "returnFastPct" | "returnSlowPct",
  maxSingleSymbolWeightPct: number,
): { direction: number; consideredSymbolCount: number; weightsBySymbol: Record<string, number> } {
  const eligible = stats.filter(
    (s) =>
      s.dataQuality === "OK" &&
      s[returnField] !== null &&
      Number.isFinite(s[returnField] as number) &&
      s.quoteVolume24hUsd !== null &&
      Number.isFinite(s.quoteVolume24hUsd) &&
      s.quoteVolume24hUsd > 0,
  );
  const weightsBySymbol = computeCanonicalMarketRegimeEngineLiquidityWeights(
    eligible.map((s) => ({ symbol: s.symbol, quoteVolume24hUsd: s.quoteVolume24hUsd })),
    maxSingleSymbolWeightPct,
  );
  let direction = 0;
  for (const s of eligible) {
    direction += (weightsBySymbol[s.symbol] ?? 0) * (s[returnField] as number);
  }
  return { direction, consideredSymbolCount: eligible.length, weightsBySymbol };
}

/**
 * directionFast/directionSlow — signed, capped-liquidity-weighted composites (NOT hard-clamped to
 * [-1,1]: unlike breadth's count-ratio, a weighted average of RETURNS has no natural bound, and
 * silently clamping would distort a genuinely extreme reading — exactly the kind of signal a later
 * panic overlay needs intact). Fast and slow are computed as two fully independent passes (their own
 * eligibility filter, their own liquidity-weight computation) rather than one shared computation, so a
 * symbol missing only one horizon's return (defensive case — stage 1's fixed candle window makes this
 * unreachable in practice, but this function does not assume that) never distorts the other horizon.
 */
export function computeCanonicalMarketRegimeEngineDirection(
  stats: CanonicalMarketRegimeEngineSymbolStat[],
  maxSingleSymbolWeightPct: number = CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT,
): CanonicalMarketRegimeEngineDirectionResult {
  const fast = weightedDirectionForHorizon(stats, "returnFastPct", maxSingleSymbolWeightPct);
  const slow = weightedDirectionForHorizon(stats, "returnSlowPct", maxSingleSymbolWeightPct);
  return {
    directionFast: fast.direction,
    directionSlow: slow.direction,
    consideredSymbolCountFast: fast.consideredSymbolCount,
    consideredSymbolCountSlow: slow.consideredSymbolCount,
    weightsBySymbolFast: fast.weightsBySymbol,
    weightsBySymbolSlow: slow.weightsBySymbol,
  };
}

// ─── equal-weighted breadth (genuinely separate code path — see file header) ────

export interface CanonicalMarketRegimeEngineBreadthResult {
  breadth: number;
  advancers: number;
  decliners: number;
  /** Exactly-zero returnFastPct — rare, but a defined third bucket rather than forced into either
   *  advancers or decliners. */
  unchanged: number;
  consideredSymbolCount: number;
}

/**
 * breadth = (advancers - decliners) / consideredSymbolCount, in [-1,1] by construction (a ratio of
 * counts, unlike direction). Takes ONLY `CanonicalMarketRegimeEngineSymbolReturnOnly` — the parameter
 * type itself has no `quoteVolume24hUsd` field, so this function's body cannot reference liquidity
 * even by accident; every symbol counts exactly once regardless of size. A MISSING or null-return
 * symbol is excluded from `consideredSymbolCount` entirely, never zero-filled into "unchanged".
 */
export function computeCanonicalMarketRegimeEngineBreadth(
  stats: CanonicalMarketRegimeEngineSymbolReturnOnly[],
): CanonicalMarketRegimeEngineBreadthResult {
  let advancers = 0;
  let decliners = 0;
  let unchanged = 0;
  for (const s of stats) {
    if (s.dataQuality !== "OK" || s.returnFastPct === null || !Number.isFinite(s.returnFastPct)) continue;
    const sign = Math.sign(s.returnFastPct);
    if (sign > 0) advancers += 1;
    else if (sign < 0) decliners += 1;
    else unchanged += 1;
  }
  const consideredSymbolCount = advancers + decliners + unchanged;
  const breadth = consideredSymbolCount > 0 ? (advancers - decliners) / consideredSymbolCount : 0;
  return { breadth, advancers, decliners, unchanged, consideredSymbolCount };
}

// ─── robust cohesion / dispersion (median + MAD — never mean/variance) ──────────

function sortedMedian(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Standard consistency constant scaling Median Absolute Deviation to approximate a robust "sigma"
 *  under a normal distribution. */
const MAD_CONSISTENCY_CONSTANT = 1.4826;

export interface CanonicalMarketRegimeEngineCohesionDispersionResult {
  /** [0,1] — fraction of considered symbols whose returnFastPct sign matches the cross-sectional
   *  MEDIAN return's sign. Robust because sign-agreement cannot be dominated by any one outlier's
   *  magnitude. */
  cohesion: number;
  /** Robust cross-sectional spread, RAW scale (same units as returnFastPct, e.g. 0.02 = 2%) — Median
   *  Absolute Deviation of returnFastPct scaled by MAD_CONSISTENCY_CONSTANT. Robust because both the
   *  center (median) and the deviation-averaging step (median of absolute deviations) are
   *  median-based, not mean/variance-based, so a single freak outlier contributes "one more point
   *  among many" rather than a squared-magnitude-dominating term. */
  dispersion: number;
  medianReturnFastPct: number | null;
  consideredSymbolCount: number;
}

/** See file header's STAGE 2 SCOPE note — same narrow, liquidity-blind parameter type as breadth. */
export function computeCanonicalMarketRegimeEngineCohesionDispersion(
  stats: CanonicalMarketRegimeEngineSymbolReturnOnly[],
): CanonicalMarketRegimeEngineCohesionDispersionResult {
  const values = stats
    .filter((s) => s.dataQuality === "OK" && s.returnFastPct !== null && Number.isFinite(s.returnFastPct))
    .map((s) => s.returnFastPct as number);

  if (values.length === 0) {
    return { cohesion: 0, dispersion: 0, medianReturnFastPct: null, consideredSymbolCount: 0 };
  }

  const med = sortedMedian(values);
  const medianSign = Math.sign(med);
  const agreeing = values.filter((v) => Math.sign(v) === medianSign).length;
  const cohesion = agreeing / values.length;

  const deviations = values.map((v) => Math.abs(v - med));
  const dispersion = sortedMedian(deviations) * MAD_CONSISTENCY_CONSTANT;

  return { cohesion, dispersion, medianReturnFastPct: med, consideredSymbolCount: values.length };
}

// ─── riskStress composite (BTC vol + market-aggregated funding/OI crowding) ─────

export interface CanonicalMarketRegimeEngineRiskStressInputs {
  /** BTC's OWN candle series — NOT stage 1's per-symbol CANDLES_REQUIRED window (that window is sized
   *  for a 24-bar return, far short of computeBtcAtrPercentile's own ATR_PERIOD(14) +
   *  BTC_ATR_PERCENTILE_WINDOW_BARS(168) = 182-candle requirement). Supplied by the caller from a
   *  separate, longer BTC-only fetch — this function only ever consumes it, never fetches it. */
  btcCandles: Candle[];
  /** Raw funding rate (fraction, e.g. 0.0001 = 1bp), one per symbol this cycle, straight off
   *  BinanceClient.getFuturesFlow(...).fundingRate. A symbol absent from this map, or holding
   *  null/undefined/non-finite, is EXCLUDED from fundingStressShare's denominator — never treated as
   *  NEUTRAL/0. */
  fundingRateBySymbol: Record<string, number | null | undefined>;
  /** Raw OI change percent (e.g. 2.5 = +2.5%, matching FuturesFlowSnapshot's own convention — NOT a
   *  fraction), one per symbol this cycle, straight off
   *  BinanceClient.getFuturesFlow(...).openInterestChangePercent. Same exclude-don't-zero-fill rule. */
  openInterestChangePercentBySymbol: Record<string, number | null | undefined>;
}

export interface CanonicalMarketRegimeEngineRiskStressOptions {
  /** Defaults to `OI_TREND_PCT` (derivatives-crowding.ts) — the SAME already-battle-tested threshold
   *  this codebase already uses to classify a symbol's OI move as RISING/FALLING vs FLAT off the same
   *  `openInterestChangePercent` field, reused rather than inventing a second, uncalibrated number for
   *  a near-identical purpose. */
  oiAccelerationAbsPctThreshold?: number;
  /** Defaults to `FIXED_CROWDING_THRESHOLDS` (derivatives-crowding.ts) — the SAME live thresholds
   *  every other ELEVATED/EXTREME classification in this codebase uses. */
  crowdingThresholds?: CrowdingThresholds;
}

export interface CanonicalMarketRegimeEngineRiskStressResult {
  /** [0,1]. */
  riskStress: number;
  /** Pass-through of computeBtcAtrPercentile's own result — null only when BTC's candle series has
   *  fewer than 182 completed bars (engine bootstrap, or a genuine data outage). */
  btcAtrPercentile: number | null;
  fundingStressShare: number;
  fundingConsideredSymbolCount: number;
  oiAccelerationShare: number;
  oiAccelerationConsideredSymbolCount: number;
}

function shareAboveOrAtThreshold(
  valuesBySymbol: Record<string, number | null | undefined>,
  matches: (value: number) => boolean,
): { share: number; consideredSymbolCount: number } {
  let considered = 0;
  let matching = 0;
  for (const value of Object.values(valuesBySymbol)) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue; // excluded, never 0-filled
    considered += 1;
    if (matches(value)) matching += 1;
  }
  return { share: considered > 0 ? matching / considered : 0, consideredSymbolCount: considered };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/**
 * riskStress = 0.4 x (btcAtrPercentile/100) + 0.3 x fundingStressShare + 0.3 x oiAccelerationShare,
 * per the approved design — reuses computeBtcAtrPercentile and classifyCrowdingAtThresholds UNCHANGED
 * (see file header). fundingStressShare = market-wide fraction currently ELEVATED/EXTREME;
 * oiAccelerationShare = market-wide fraction with |OI change %| at/above threshold — both aggregated
 * at the MARKET level from many symbols' own raw data, never any single symbol's own crowd side.
 *
 * DELIBERATE, DOCUMENTED DEVIATION: if btcAtrPercentile is unavailable (null — expected only during
 * the engine's first ~7.6 days of uptime, since computeBtcAtrPercentile needs 182 consecutive
 * completed 1h candles), this does NOT fall back to contributing 0 for that term. 0 would be exactly
 * the "missing data becomes a safe [low-stress] zero" anti-pattern this whole engine is designed to
 * avoid at the per-symbol level — and the BTC term carries the LARGEST weight (0.4) of the three, so
 * silently zero-filling it would be the single most consequential place that anti-pattern could hide.
 * Instead the two remaining terms are renormalized over their own combined weight (0.3+0.3=0.6), so
 * the composite is always a genuine weighted average of AVAILABLE evidence, never a mix of real
 * evidence and a fabricated calm reading. `btcAtrPercentile` is still surfaced honestly as null in the
 * result so a later coverage/overlays stage can independently decide this cycle warrants degrading
 * further. fundingStressShare/oiAccelerationShare are always well-defined numbers (0 when their own
 * considered-count is 0 — the same honest-zero-plus-count convention used throughout this stage), so
 * they are always included as terms; only the single-scalar BTC term can be structurally absent (it
 * has no cross-sectional denominator of its own to shrink).
 */
export function computeCanonicalMarketRegimeEngineRiskStress(
  inputs: CanonicalMarketRegimeEngineRiskStressInputs,
  opts: CanonicalMarketRegimeEngineRiskStressOptions = {},
): CanonicalMarketRegimeEngineRiskStressResult {
  const oiAccelerationAbsPctThreshold = opts.oiAccelerationAbsPctThreshold ?? OI_TREND_PCT;
  const crowdingThresholds = opts.crowdingThresholds ?? FIXED_CROWDING_THRESHOLDS;

  const btcAtrPercentile = computeBtcAtrPercentile(inputs.btcCandles);

  const funding = shareAboveOrAtThreshold(inputs.fundingRateBySymbol, (rate) => {
    const { crowdingLevel } = classifyCrowdingAtThresholds(rate, crowdingThresholds);
    return crowdingLevel === "ELEVATED" || crowdingLevel === "EXTREME";
  });
  const oi = shareAboveOrAtThreshold(
    inputs.openInterestChangePercentBySymbol,
    (value) => Math.abs(value) >= oiAccelerationAbsPctThreshold,
  );

  const terms: Array<{ value: number; weight: number }> = [];
  if (btcAtrPercentile !== null) terms.push({ value: clamp01(btcAtrPercentile / 100), weight: 0.4 });
  terms.push({ value: funding.share, weight: 0.3 });
  terms.push({ value: oi.share, weight: 0.3 });
  const weightSum = terms.reduce((sum, t) => sum + t.weight, 0);
  const riskStress =
    weightSum > 0 ? clamp01(terms.reduce((sum, t) => sum + t.value * t.weight, 0) / weightSum) : 0;

  return {
    riskStress,
    btcAtrPercentile,
    fundingStressShare: funding.share,
    fundingConsideredSymbolCount: funding.consideredSymbolCount,
    oiAccelerationShare: oi.share,
    oiAccelerationConsideredSymbolCount: oi.consideredSymbolCount,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 3 — projection state machine: canonical BULLISH/BEARISH/MIXED projection, asymmetric
// hysteresis, the six independent overlays, and the PANIC sub-state-machine. Built entirely on stage
// 2's directionFast/directionSlow/breadth/cohesion/riskStress outputs plus stage 1's coverage counts
// and diffCanonicalMarketRegimeEngineObservationIds (requirement #4's dedup consumption point, per
// this file's own STAGE 3 build-plan note above). Still pure, still no I/O: the one piece of
// cross-cycle memory (`CanonicalMarketRegimeEnginePriorState`) is threaded explicitly through the
// caller, never held in module state, so a whole cycle sequence is replayable byte-for-byte in a test.
// See the file header's "STAGE 3 SCOPE" section for the cross-cutting design notes.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── coverage classification (stage 1's counts -> VALID/DEGRADED/INVALID; drives LOW_COVERAGE) ─────

export type CanonicalMarketRegimeEngineCoverageStatus = "VALID" | "DEGRADED" | "INVALID";

/** >= 85% of the attempted universe has OK data this cycle. Below this, LOW_COVERAGE fires (see
 *  computeCanonicalMarketRegimeEngineOverlays) even though a number may still be computable — the
 *  number is no longer trustworthy enough to call a clean regime off. */
export const CANONICAL_MARKET_REGIME_ENGINE_COVERAGE_VALID_MIN_PCT = 0.85;
/** Between this and the VALID floor is DEGRADED; below this is INVALID. Both count as LOW_COVERAGE —
 *  the split exists for observability/calibration reporting only, not because DEGRADED and INVALID
 *  are treated differently anywhere else in this file. */
export const CANONICAL_MARKET_REGIME_ENGINE_COVERAGE_DEGRADED_MIN_PCT = 0.6;

export interface CanonicalMarketRegimeEngineCoverageResult {
  status: CanonicalMarketRegimeEngineCoverageStatus;
  coveragePct: number;
  validSymbolCount: number;
  requiredSymbolCount: number;
  reasons: string[];
}

/**
 * Classifies stage 1's own honest coverage counts — never re-derived from anything else — into
 * VALID/DEGRADED/INVALID. This is the ONLY place these thresholds live; every downstream consumer
 * (the overlays function, the main step function) reads `.status`, never `coveragePct` directly. A
 * zero-universe cycle (`requiredSymbolCount === 0`) and a non-finite `coveragePct` both classify
 * INVALID, never a vacuous VALID — an empty/broken universe is never treated as a safe reading.
 */
export function classifyCanonicalMarketRegimeEngineCoverage(
  cycle: Pick<CanonicalMarketRegimeEngineRawIngestionCycle, "coveragePct" | "validSymbolCount" | "requiredSymbolCount">,
): CanonicalMarketRegimeEngineCoverageResult {
  const { coveragePct, validSymbolCount, requiredSymbolCount } = cycle;
  const reasons: string[] = [];

  if (requiredSymbolCount <= 0) {
    reasons.push("requiredSymbolCount is 0 — no universe to evaluate this cycle");
    return { status: "INVALID", coveragePct, validSymbolCount, requiredSymbolCount, reasons };
  }
  if (!Number.isFinite(coveragePct)) {
    reasons.push("coveragePct is non-finite — treated as no usable coverage, never a safe default");
    return { status: "INVALID", coveragePct, validSymbolCount, requiredSymbolCount, reasons };
  }
  if (coveragePct >= CANONICAL_MARKET_REGIME_ENGINE_COVERAGE_VALID_MIN_PCT) {
    return { status: "VALID", coveragePct, validSymbolCount, requiredSymbolCount, reasons };
  }
  if (coveragePct >= CANONICAL_MARKET_REGIME_ENGINE_COVERAGE_DEGRADED_MIN_PCT) {
    reasons.push(
      `coveragePct ${(coveragePct * 100).toFixed(1)}% is below the VALID floor of ${(
        CANONICAL_MARKET_REGIME_ENGINE_COVERAGE_VALID_MIN_PCT * 100
      ).toFixed(0)}% (${validSymbolCount}/${requiredSymbolCount} symbols)`,
    );
    return { status: "DEGRADED", coveragePct, validSymbolCount, requiredSymbolCount, reasons };
  }
  reasons.push(
    `coveragePct ${(coveragePct * 100).toFixed(1)}% is below the DEGRADED floor of ${(
      CANONICAL_MARKET_REGIME_ENGINE_COVERAGE_DEGRADED_MIN_PCT * 100
    ).toFixed(0)}% (${validSymbolCount}/${requiredSymbolCount} symbols)`,
  );
  return { status: "INVALID", coveragePct, validSymbolCount, requiredSymbolCount, reasons };
}

const CANONICAL_MARKET_REGIME_ENGINE_COVERAGE_STATUS_SEVERITY: Record<CanonicalMarketRegimeEngineCoverageStatus, number> = {
  VALID: 0,
  DEGRADED: 1,
  INVALID: 2,
};

/**
 * Picks whichever of two coverage statuses is the more severe (VALID < DEGRADED < INVALID) — the
 * FINDING 1 fix combines the candle-fetch coverage check above with a second, independent check over
 * volume-pipeline validity (see computeCanonicalMarketRegimeSnapshot) via this helper, rather than
 * duplicating the VALID/DEGRADED/INVALID ordering at the call site.
 */
function worseCanonicalMarketRegimeEngineCoverageStatus(
  a: CanonicalMarketRegimeEngineCoverageStatus,
  b: CanonicalMarketRegimeEngineCoverageStatus,
): CanonicalMarketRegimeEngineCoverageStatus {
  return CANONICAL_MARKET_REGIME_ENGINE_COVERAGE_STATUS_SEVERITY[b] > CANONICAL_MARKET_REGIME_ENGINE_COVERAGE_STATUS_SEVERITY[a] ? b : a;
}

// ─── candidate direction (the raw, per-cycle signal — not yet hysteresis-confirmed or coverage-gated) ─

export type CanonicalMarketRegimeEngineProjection = "BULLISH" | "BEARISH" | "MIXED";
/** Literally the same union as CanonicalMarketRegimeEngineProjection — kept as its own name only for
 *  signature readability (a "candidate" is this cycle's raw signal; a "projection" is the
 *  hysteresis-confirmed state). */
export type CanonicalMarketRegimeEngineCandidateDirection = CanonicalMarketRegimeEngineProjection;
export type CanonicalMarketRegimeEngineDirectionalState = "BULLISH" | "BEARISH";

export const CANONICAL_MARKET_REGIME_ENGINE_DIRECTION_FAST_THRESHOLD = 0.015;
/** Deliberately a LOWER per-hour bar than the fast threshold (0.125%/h vs 0.25%/h) — the slow
 *  window's job is confirming persistence, not independently re-clearing a high bar. */
export const CANONICAL_MARKET_REGIME_ENGINE_DIRECTION_SLOW_THRESHOLD = 0.03;
export const CANONICAL_MARKET_REGIME_ENGINE_BREADTH_ENTRY_THRESHOLD = 0.2;
export const CANONICAL_MARKET_REGIME_ENGINE_COHESION_ENTRY_THRESHOLD = 0.55;

export interface CanonicalMarketRegimeEngineCandidateDirectionInputs {
  directionFast: number;
  directionSlow: number;
  breadth: number;
  cohesion: number;
}

/**
 * candidateDirection = BULLISH iff directionFast/directionSlow/breadth all clear their positive bar
 * AND cohesion clears its own entry bar; BEARISH is the exact mirror image; otherwise MIXED. Per the
 * approved design: DIRECTION_FAST guards against noise-level 6h moves; DIRECTION_SLOW confirms the
 * move has actually persisted; BREADTH guards against a liquidity-weighted reading that is really
 * just BTC/majors moving while the broader equal-weighted universe disagrees (the second, independent
 * safeguard against liquidity-cap gaming, on top of the 15% cap itself — adversarial test B);
 * COHESION guards against calling a genuinely split universe a clean directional regime. All four are
 * required simultaneously (a plain AND, not a scored vote) — no single strong input can compensate for
 * another falling short. Defensively returns MIXED (never throws/NaNs) if any input is non-finite.
 *
 * This function is NEITHER hysteresis-aware NOR coverage-aware — it is the raw per-cycle signal.
 * `advanceCanonicalMarketRegimeEngineProjection` below hysteresis-gates it AND separately
 * coverage-forces it to MIXED before ever letting it move `projection`.
 */
export function computeCanonicalMarketRegimeEngineCandidateDirection(
  inputs: CanonicalMarketRegimeEngineCandidateDirectionInputs,
): CanonicalMarketRegimeEngineCandidateDirection {
  const { directionFast, directionSlow, breadth, cohesion } = inputs;
  if (![directionFast, directionSlow, breadth, cohesion].every((v) => Number.isFinite(v))) return "MIXED";

  if (
    directionFast >= CANONICAL_MARKET_REGIME_ENGINE_DIRECTION_FAST_THRESHOLD &&
    directionSlow >= CANONICAL_MARKET_REGIME_ENGINE_DIRECTION_SLOW_THRESHOLD &&
    breadth >= CANONICAL_MARKET_REGIME_ENGINE_BREADTH_ENTRY_THRESHOLD &&
    cohesion >= CANONICAL_MARKET_REGIME_ENGINE_COHESION_ENTRY_THRESHOLD
  ) {
    return "BULLISH";
  }
  if (
    directionFast <= -CANONICAL_MARKET_REGIME_ENGINE_DIRECTION_FAST_THRESHOLD &&
    directionSlow <= -CANONICAL_MARKET_REGIME_ENGINE_DIRECTION_SLOW_THRESHOLD &&
    breadth <= -CANONICAL_MARKET_REGIME_ENGINE_BREADTH_ENTRY_THRESHOLD &&
    cohesion >= CANONICAL_MARKET_REGIME_ENGINE_COHESION_ENTRY_THRESHOLD
  ) {
    return "BEARISH";
  }
  return "MIXED";
}

// ─── hysteresis timing constants (asymmetric: entering is strictly harder than reverting) ──────────

/** candidateDirection must equal the SAME new directional state for this many CONSECUTIVE
 *  genuinely-new (non-duplicate) cycles before `projection` actually flips into it from MIXED. Under
 *  the 5-minute tick / 1h-candle cadence (see file header), most ticks are duplicate-evaluations of
 *  the same last-closed candle, so this corresponds to ~3 hours of persistent confirmation in
 *  practice, NOT 3 poll intervals — re-derive this relationship explicitly if the tick interval or the
 *  candle interval ever changes. */
export const CANONICAL_MARKET_REGIME_ENGINE_ENTER_CONFIRM_CYCLES = 3;
/** Definitional, not a loop bound the code branches on: the revert-to-MIXED path
 *  (`advanceCanonicalMarketRegimeEngineProjection`'s STEP 1) is unconditionally immediate — the very
 *  first genuinely-new cycle where candidateDirection no longer matches the current directional
 *  projection reverts it to MIXED that same cycle. Exported only so a calibration/report consumer can
 *  cite "1" next to ENTER_CONFIRM_CYCLES's "3" without a magic number. */
export const CANONICAL_MARKET_REGIME_ENGINE_REVERT_CONFIRM_CYCLES = 1;

// ─── overlays (six independent booleans layered on top of the 3-state projection) ──────────────────

export interface CanonicalMarketRegimeEngineOverlays {
  transition: boolean;
  highStress: boolean;
  panic: boolean;
  lowCoverage: boolean;
  rotational: boolean;
  fragmented: boolean;
}

export const CANONICAL_MARKET_REGIME_ENGINE_HIGH_STRESS_THRESHOLD = 0.7;
export const CANONICAL_MARKET_REGIME_ENGINE_ROTATIONAL_MAGNITUDE_THRESHOLD = 0.1;
export const CANONICAL_MARKET_REGIME_ENGINE_FRAGMENTED_COHESION_THRESHOLD = 0.35;

export interface CanonicalMarketRegimeEngineOverlayInputs {
  directionFast: number;
  breadth: number;
  cohesion: number;
  riskStress: number;
  coverageStatus: CanonicalMarketRegimeEngineCoverageStatus;
  panicActive: boolean;
  /** POST-transition value for this cycle — i.e. already reflecting any flip that just happened this
   *  same cycle. See advanceCanonicalMarketRegimeEngineProjection. */
  cyclesInProjection: number;
  /** POST-transition value for this cycle. 0 whenever no directional accumulation is in progress
   *  (projection is already directional, or candidateDirection is itself MIXED). */
  enterCandidateCycles: number;
}

/**
 * Each overlay is an independently-computed pure function of the current cycle's raw metrics (plus
 * the state machine's own counters where noted) — never gated on another overlay, matching the
 * design's "independent booleans... zero lane/PnL feedback" requirement:
 *  - transition: still accumulating toward a not-yet-confirmed direction (0 < enterCandidateCycles <
 *    ENTER_CONFIRM_CYCLES), OR the projection just flipped this very cycle (cyclesInProjection<=1) —
 *    both read as "a flip is in flight or just landed".
 *  - highStress: riskStress at/above the composite-stress threshold.
 *  - panic: a straight passthrough of the panic sub-state-machine's own current `panicActive` — panic
 *    entry/exit has its own separate hysteresis (see advanceCanonicalMarketRegimeEnginePanicState),
 *    never re-derived here.
 *  - lowCoverage: coverage status is anything other than VALID (DEGRADED or INVALID both count).
 *  - rotational: directionFast (liquidity-weighted) and breadth (equal-weighted) disagree in SIGN
 *    while BOTH independently clear their own magnitude floor — "money rotating" (e.g. majors up
 *    while the broad book sells off), a distinct character from plain MIXED (weak everywhere).
 *  - fragmented: cohesion below a floor materially under the entry bar's own 0.55 — the universe isn't
 *    merely short of qualifying, it actively disagrees with itself.
 */
export function computeCanonicalMarketRegimeEngineOverlays(
  inputs: CanonicalMarketRegimeEngineOverlayInputs,
): CanonicalMarketRegimeEngineOverlays {
  const directionFastSign = Math.sign(inputs.directionFast);
  const breadthSign = Math.sign(inputs.breadth);
  return {
    transition:
      (inputs.enterCandidateCycles > 0 &&
        inputs.enterCandidateCycles < CANONICAL_MARKET_REGIME_ENGINE_ENTER_CONFIRM_CYCLES) ||
      inputs.cyclesInProjection <= 1,
    highStress: inputs.riskStress >= CANONICAL_MARKET_REGIME_ENGINE_HIGH_STRESS_THRESHOLD,
    panic: inputs.panicActive,
    lowCoverage: inputs.coverageStatus !== "VALID",
    rotational:
      directionFastSign !== breadthSign &&
      Math.abs(inputs.directionFast) >= CANONICAL_MARKET_REGIME_ENGINE_ROTATIONAL_MAGNITUDE_THRESHOLD &&
      Math.abs(inputs.breadth) >= CANONICAL_MARKET_REGIME_ENGINE_ROTATIONAL_MAGNITUDE_THRESHOLD,
    fragmented: inputs.cohesion < CANONICAL_MARKET_REGIME_ENGINE_FRAGMENTED_COHESION_THRESHOLD,
  };
}

// ─── PANIC sub-state-machine (immediate entry, hysteresis exit — independent of projection) ────────

export const CANONICAL_MARKET_REGIME_ENGINE_PANIC_RISK_STRESS_THRESHOLD = 0.85;
/** Above the plain directional threshold (0.015) — panic requires a level clearly beyond an ordinary
 *  directional entry, not just "any" directional move. */
export const CANONICAL_MARKET_REGIME_ENGINE_PANIC_DIRECTION_FAST_THRESHOLD = 0.04;
export const CANONICAL_MARKET_REGIME_ENGINE_PANIC_BREADTH_THRESHOLD = 0.35;
/** Larger than ENTER_CONFIRM_CYCLES(3) — prematurely clearing panic is a costlier mistake than staying
 *  cautious slightly longer; ≈4 hours under the same candle-driven cadence as ENTER_CONFIRM_CYCLES's
 *  own ~3-hour equivalence (see that constant's doc comment). */
export const CANONICAL_MARKET_REGIME_ENGINE_PANIC_EXIT_CONFIRM_CYCLES = 4;

export interface CanonicalMarketRegimeEnginePanicConditionInputs {
  riskStress: number;
  directionFast: number;
  breadth: number;
  coverageStatus: CanonicalMarketRegimeEngineCoverageStatus;
}

/**
 * ALL FOUR required simultaneously, a real AND (each condition is exercised independently in this
 * file's own test suite so a mutation weakening any single term is caught, not just "panic still
 * triggers on the happy path"): riskStress >= 0.85 AND |directionFast| >= 4% AND breadth same-SIGN as
 * directionFast with |breadth| >= 0.35 AND coverage VALID (never declare panic off garbage/degraded
 * data — this is an explicit, direct AND-term here, independent of the separate
 * LOW_COVERAGE-forces-MIXED mechanism candidateDirection goes through, so panic stays protected even
 * though it never consumes candidateDirection at all).
 */
export function canonicalMarketRegimeEnginePanicConditionMet(
  inputs: CanonicalMarketRegimeEnginePanicConditionInputs,
): boolean {
  const { riskStress, directionFast, breadth, coverageStatus } = inputs;
  if (![riskStress, directionFast, breadth].every((v) => Number.isFinite(v))) return false;
  return (
    riskStress >= CANONICAL_MARKET_REGIME_ENGINE_PANIC_RISK_STRESS_THRESHOLD &&
    Math.abs(directionFast) >= CANONICAL_MARKET_REGIME_ENGINE_PANIC_DIRECTION_FAST_THRESHOLD &&
    Math.sign(directionFast) === Math.sign(breadth) &&
    Math.abs(breadth) >= CANONICAL_MARKET_REGIME_ENGINE_PANIC_BREADTH_THRESHOLD &&
    coverageStatus === "VALID"
  );
}

export interface CanonicalMarketRegimeEnginePanicState {
  panicActive: boolean;
  panicSinceMs: number | null;
  /** Consecutive genuinely-new cycles the panic condition has NOT been met, while panicActive is
   *  true. Reset to 0 the instant the condition is met again (a recurrence, not partial credit toward
   *  clearing) — see doc comment below. Always 0 while panicActive is false. */
  panicCyclesSinceExitCandidate: number;
}

/**
 * Entry is immediate (zero confirmation delay): the moment `conditionMet` is true on a genuinely-new
 * cycle while not already active, `panicActive` flips true THAT SAME cycle. Exit requires
 * PANIC_EXIT_CONFIRM_CYCLES(4) CONSECUTIVE genuinely-new cycles where `conditionMet` is false; any
 * recurrence of the condition while exit-counting resets the counter to 0 rather than merely pausing
 * it, so a flickering condition can never accumulate partial progress toward clearing across separate
 * episodes.
 */
export function advanceCanonicalMarketRegimeEnginePanicState(
  prior: CanonicalMarketRegimeEnginePanicState,
  conditionMet: boolean,
  nowMs: number,
): CanonicalMarketRegimeEnginePanicState {
  if (prior.panicActive) {
    if (conditionMet) {
      return { panicActive: true, panicSinceMs: prior.panicSinceMs, panicCyclesSinceExitCandidate: 0 };
    }
    const cycles = prior.panicCyclesSinceExitCandidate + 1;
    if (cycles >= CANONICAL_MARKET_REGIME_ENGINE_PANIC_EXIT_CONFIRM_CYCLES) {
      return { panicActive: false, panicSinceMs: null, panicCyclesSinceExitCandidate: 0 };
    }
    return { panicActive: true, panicSinceMs: prior.panicSinceMs, panicCyclesSinceExitCandidate: cycles };
  }
  if (conditionMet) {
    return { panicActive: true, panicSinceMs: nowMs, panicCyclesSinceExitCandidate: 0 };
  }
  return { panicActive: false, panicSinceMs: null, panicCyclesSinceExitCandidate: 0 };
}

// ─── carried cross-cycle state (what a later stage persists and feeds back in as `prior`) ──────────

/** Field names deliberately match the approved design's eventual `CanonicalMarketRegimeSnapshot`'s
 *  own `stateHistory` shape 1:1 (cross-checked against canonical-market-regime-execution-policy.ts's
 *  local structural mirror), so a later stage's assembly can fold this straight in rather than
 *  renaming. */
export interface CanonicalMarketRegimeEngineStateHistory {
  projectionSinceMs: number;
  cyclesInProjection: number;
  lastFlipAtMs: number | null;
  panicSinceMs: number | null;
  panicCyclesSinceExitCandidate: number;
}

export interface CanonicalMarketRegimeEnginePriorState {
  projection: CanonicalMarketRegimeEngineProjection;
  /** The directional state currently being accumulated toward confirmation, or null when `projection`
   *  is directional (nothing to accumulate toward) or candidateDirection is itself MIXED. See
   *  advanceCanonicalMarketRegimeEngineProjection's STEP 2 for the structural guarantee that this can
   *  only ever be set while `projection` is MIXED. */
  enterCandidate: CanonicalMarketRegimeEngineDirectionalState | null;
  enterCandidateCycles: number;
  panicActive: boolean;
  stateHistory: CanonicalMarketRegimeEngineStateHistory;
  /** This cycle's stage-1 `sourceObservationIds` — carried forward purely so the NEXT call can diff
   *  against it via diffCanonicalMarketRegimeEngineObservationIds (requirement #4). */
  sourceObservationIds: Record<string, string>;
  /** FINDING 2 FIX: the `riskStress` value this state was last computed against. riskStress's own raw
   *  ingredients (funding/OI/BTC vol) can escalate faster than the hourly candles `sourceObservationIds`
   *  is keyed on, so a candle-duplicate cycle is NOT necessarily a riskStress-duplicate cycle too. PANIC
   *  needs its OWN, independent "did anything actually change" check — see
   *  advanceCanonicalMarketRegimeEngineProjection's own doc comment for how this and
   *  `sourceObservationIds` combine to gate the full-duplicate short-circuit vs. the (candle-only)
   *  directional-hysteresis freeze. */
  lastRiskStress: number;
}

/**
 * The cold-start seed: projection MIXED, zero accumulated cycles, no panic. Deliberately the SAME
 * conservative starting point `advanceCanonicalMarketRegimeEngineProjection` falls back to whenever
 * `prior` is null, so a never-yet-ticked engine (or one recovering from a discarded/corrupt persisted
 * state — a later stage's concern) never starts directionally confident. `cyclesInProjection` seeds at
 * 0 (not 1) so the very first real cycle's own "+1" arrives at the same 1 an ordinary
 * continuing-MIXED cycle would compute — one shared code path, no cold-start special case.
 */
export function initialCanonicalMarketRegimeEngineProjectionState(nowMs: number): CanonicalMarketRegimeEnginePriorState {
  return {
    projection: "MIXED",
    enterCandidate: null,
    enterCandidateCycles: 0,
    panicActive: false,
    stateHistory: {
      projectionSinceMs: nowMs,
      cyclesInProjection: 0,
      lastFlipAtMs: null,
      panicSinceMs: null,
      panicCyclesSinceExitCandidate: 0,
    },
    sourceObservationIds: {},
    lastRiskStress: 0,
  };
}

// ─── the main step function ──────────────────────────────────────────────────────────────────────

export interface CanonicalMarketRegimeEngineStepInputs {
  nowMs: number;
  directionFast: number;
  directionSlow: number;
  breadth: number;
  cohesion: number;
  riskStress: number;
  coverage: CanonicalMarketRegimeEngineCoverageResult;
  /** This cycle's stage-1 sourceObservationIds — diffed against `prior`'s own copy (never a
   *  freestanding ledger) before any counter advances. */
  sourceObservationIds: Record<string, string>;
}

export interface CanonicalMarketRegimeEngineStepResult {
  /** True only on a FULL duplicate: identical candle evidence (sourceObservationIds) AND identical
   *  riskStress evidence (FINDING 2 fix — see the function's own doc comment, step 0). A candle
   *  duplicate whose riskStress genuinely moved is `false` here, even though the directional
   *  hysteresis stayed frozen. */
  isDuplicateCycle: boolean;
  candidateDirection: CanonicalMarketRegimeEngineCandidateDirection;
  projection: CanonicalMarketRegimeEngineProjection;
  overlays: CanonicalMarketRegimeEngineOverlays;
  /** The new prior-state for the NEXT call. On a FULL duplicate cycle this is `prior` itself,
   *  byte-identical — no counter of any kind advances, matching requirement #4. On a candle-duplicate
   *  cycle whose riskStress moved, this is a NEW object: the directional-hysteresis fields are copied
   *  verbatim from `prior` (frozen), but `panicActive`/`stateHistory.panicSinceMs`/
   *  `stateHistory.panicCyclesSinceExitCandidate`/`lastRiskStress` reflect the fresh evaluation. */
  state: CanonicalMarketRegimeEnginePriorState;
}

/**
 * The projection state machine's single entry point — one call per cycle, `prior` threaded explicitly
 * (null only on a genuine cold start). Structure, in order:
 *
 * 0. DEDUP (requirement #4, extended by the FINDING 2 fix below): TWO independent identity checks, not
 *    one. (a) CANDLE identity: diffCanonicalMarketRegimeEngineObservationIds(current,
 *    prior?.sourceObservationIds ?? null) against the PERSISTED prior's own id map — `isCandleDuplicate`.
 *    (b) RISK-STRESS identity: `inputs.riskStress === prior.lastRiskStress` — `isRiskStressDuplicate`.
 *    A cold start (`prior === null`) is never a duplicate on either check (matches
 *    diffCanonicalMarketRegimeEngineObservationIds' own contract). Only a FULL duplicate (BOTH checks
 *    true) short-circuits: this function returns `prior` completely unchanged as `state` — no counter
 *    of any kind advances, no history row implied — with `overlays`/`candidateDirection` still freshly
 *    reported for observability only; neither feeds back into anything persisted. This split exists
 *    because riskStress's own raw ingredients (funding/OI/BTC vol) can escalate faster than the hourly
 *    candles `sourceObservationIds` is keyed on — a candle-duplicate cycle is not necessarily a
 *    riskStress-duplicate cycle, and PANIC (step 4 below) must never be memoized against a stale
 *    riskStress reading just because the candle happened not to move. The DIRECTIONAL hysteresis (steps
 *    1-3) stays gated on `isCandleDuplicate` ALONE, independent of `isRiskStressDuplicate`: direction/
 *    breadth/cohesion are pure functions of candle-derived data, so a candle duplicate genuinely has
 *    nothing new for THAT hysteresis to confirm, even on a cycle that is not a FULL duplicate overall
 *    because riskStress moved.
 *
 * 1. COVERAGE FORCING (requirement #5 / LOW_COVERAGE): `candidateDirection` is computed from the raw
 *    direction/breadth/cohesion numbers, THEN forced to MIXED outright whenever `coverage.status !==
 *    "VALID"` — reusing the exact same revert-immediately / no-entry-accumulation machinery below that
 *    any ordinary MIXED-reversion uses, rather than a second, parallel "force MIXED" branch. This is
 *    why LOW_COVERAGE reliably forces `projection` to MIXED without a special case: forced-MIXED
 *    candidateDirection flows through STEP 1 and STEP 2 exactly like a genuine MIXED reading would, and
 *    stays forced every cycle coverage remains invalid (it can never begin re-accumulating toward a
 *    direction while forced).
 *
 * 2. STEP 1 — revert-check. Runs whenever `isCandleDuplicate` is false (frozen verbatim from `prior`
 *    otherwise — see step 0). If the incoming `projection` is directional (BULLISH/BEARISH) and
 *    `candidateDirection` no longer equals it, `projection` becomes MIXED THIS SAME CYCLE, full stop —
 *    REVERT_CONFIRM_CYCLES=1, immediate, no accumulation. If it still matches, the directional
 *    projection is simply reconfirmed (cyclesInProjection+1). If the incoming projection was already
 *    MIXED, this step is a passthrough (nothing to revert).
 *
 * 3. STEP 2 — enter-check. Gated on `projection === "MIXED"` using STEP 1's OUTPUT for this same cycle
 *    (not the incoming prior value) — see the structural-guarantee note below. Only runs its body when
 *    candidateDirection is itself directional; accumulates a confirmation counter that resets to 1
 *    (not incremented) whenever the direction being accumulated toward changes, and only flips
 *    `projection` once the counter reaches ENTER_CONFIRM_CYCLES(3).
 *
 * 4. PANIC — fully independent of projection/candidateDirection (see
 *    canonicalMarketRegimeEnginePanicConditionMet / advanceCanonicalMarketRegimeEnginePanicState);
 *    computed from this cycle's own riskStress/directionFast/breadth/coverage. Reached only when this
 *    cycle is NOT a full duplicate (step 0), so it (re-)evaluates fresh on every ordinary new-candle
 *    cycle exactly as before, AND now also on a candle-duplicate cycle whose riskStress genuinely moved
 *    — the FINDING 2 fix.
 *
 * STRUCTURAL GUARANTEE THAT BULLISH CANNOT SKIP DIRECTLY TO BEARISH (or vice versa) — traced, not
 * assumed: the ONLY line in this function that can assign a DIRECTIONAL value to the local `projection`
 * variable is inside STEP 2's `if (enterCandidateCycles >= ENTER_CONFIRM_CYCLES)` block, and that
 * entire block is nested inside `if (projection === "MIXED" && ...)` — a condition tested AFTER STEP 1
 * has already run and already normalized `projection` to STEP 1's own output for this cycle. STEP 1
 * itself can only ever WRITE "MIXED" or reconfirm the SAME directional value already held — it never
 * writes the opposite directional value (its own if/else-if/else has exactly three branches: still-
 * confirmed-same-direction, revert-to-MIXED, already-MIXED-passthrough; none of the three assigns the
 * opposite direction). So for `projection` to become BEARISH in some cycle, STEP 2's gate requires
 * `projection === "MIXED"` at that point, which — by STEP 1's own exhaustive case analysis — is only
 * possible if the incoming prior projection was ALREADY MIXED, or STEP 1 itself just reverted a
 * directional state to MIXED this cycle. Either way, the value written is always "MIXED" first, in the
 * same statement ordering, before STEP 2 can ever consider writing a directional value — there is no
 * branch, in any of STEP 1's three cases crossed with STEP 2's two (accumulate / flip), that assigns
 * BEARISH while the variable's value earlier in this same execution was BULLISH. A dedicated test
 * ("an ordinary flip passes through MIXED for the full confirmation window, never direct") exercises
 * exactly this sequence end-to-end.
 */
export function advanceCanonicalMarketRegimeEngineProjection(
  prior: CanonicalMarketRegimeEnginePriorState | null,
  inputs: CanonicalMarketRegimeEngineStepInputs,
): CanonicalMarketRegimeEngineStepResult {
  const rawCandidateDirection = computeCanonicalMarketRegimeEngineCandidateDirection({
    directionFast: inputs.directionFast,
    directionSlow: inputs.directionSlow,
    breadth: inputs.breadth,
    cohesion: inputs.cohesion,
  });
  const candidateDirection: CanonicalMarketRegimeEngineCandidateDirection =
    inputs.coverage.status !== "VALID" ? "MIXED" : rawCandidateDirection;

  const candleDelta = diffCanonicalMarketRegimeEngineObservationIds(
    inputs.sourceObservationIds,
    prior ? prior.sourceObservationIds : null,
  );
  const isCandleDuplicate = prior !== null && candleDelta.isDuplicateCycle;
  // FINDING 2 FIX: riskStress's own raw ingredients (funding/OI/BTC vol) can escalate faster than the
  // hourly candles sourceObservationIds is keyed on — an independent identity check, never folded into
  // (or gated by) the candle check above. See this function's own doc comment, step 0.
  const isRiskStressDuplicate = prior !== null && inputs.riskStress === prior.lastRiskStress;

  if (prior !== null && isCandleDuplicate && isRiskStressDuplicate) {
    // Genuine FULL duplicate — identical candle evidence AND identical riskStress evidence. Freeze
    // everything, byte-identical, matching requirement #4's original guarantee.
    const overlays = computeCanonicalMarketRegimeEngineOverlays({
      directionFast: inputs.directionFast,
      breadth: inputs.breadth,
      cohesion: inputs.cohesion,
      riskStress: inputs.riskStress,
      coverageStatus: inputs.coverage.status,
      panicActive: prior.panicActive,
      cyclesInProjection: prior.stateHistory.cyclesInProjection,
      enterCandidateCycles: prior.enterCandidateCycles,
    });
    return { isDuplicateCycle: true, candidateDirection, projection: prior.projection, overlays, state: prior };
  }

  const basePrior = prior ?? initialCanonicalMarketRegimeEngineProjectionState(inputs.nowMs);

  // STEP 1 + STEP 2 — the DIRECTIONAL hysteresis, gated on CANDLE identity alone (see doc comment
  // above): direction/breadth/cohesion are pure functions of candle-derived data, so a candle-duplicate
  // cycle freezes these verbatim from `basePrior` even when it is here only because riskStress moved —
  // there is no new directional evidence to confirm.
  let projection: CanonicalMarketRegimeEngineProjection;
  let cyclesInProjection: number;
  let projectionSinceMs: number;
  let lastFlipAtMs: number | null;
  let enterCandidate: CanonicalMarketRegimeEngineDirectionalState | null;
  let enterCandidateCycles: number;

  if (isCandleDuplicate) {
    projection = basePrior.projection;
    cyclesInProjection = basePrior.stateHistory.cyclesInProjection;
    projectionSinceMs = basePrior.stateHistory.projectionSinceMs;
    lastFlipAtMs = basePrior.stateHistory.lastFlipAtMs;
    enterCandidate = basePrior.enterCandidate;
    enterCandidateCycles = basePrior.enterCandidateCycles;
  } else {
    // STEP 1 — revert-check (see doc comment above).
    projection = basePrior.projection;
    cyclesInProjection = basePrior.stateHistory.cyclesInProjection;
    projectionSinceMs = basePrior.stateHistory.projectionSinceMs;
    lastFlipAtMs = basePrior.stateHistory.lastFlipAtMs;
    if (basePrior.projection !== "MIXED") {
      if (candidateDirection === basePrior.projection) {
        cyclesInProjection += 1;
      } else {
        projection = "MIXED";
        cyclesInProjection = 1;
        projectionSinceMs = inputs.nowMs;
        lastFlipAtMs = inputs.nowMs;
      }
    } else {
      cyclesInProjection += 1;
    }

    // STEP 2 — enter-check (see doc comment above; gated on STEP 1's OUTPUT, not the incoming prior).
    enterCandidate = null;
    enterCandidateCycles = 0;
    if (projection === "MIXED" && (candidateDirection === "BULLISH" || candidateDirection === "BEARISH")) {
      const continuing = basePrior.projection === "MIXED" && basePrior.enterCandidate === candidateDirection;
      enterCandidate = candidateDirection;
      enterCandidateCycles = continuing ? basePrior.enterCandidateCycles + 1 : 1;
      if (enterCandidateCycles >= CANONICAL_MARKET_REGIME_ENGINE_ENTER_CONFIRM_CYCLES) {
        projection = candidateDirection;
        cyclesInProjection = 1;
        projectionSinceMs = inputs.nowMs;
        lastFlipAtMs = inputs.nowMs;
        enterCandidate = null;
        enterCandidateCycles = 0;
      }
    }
  }

  // PANIC — independent sub-state-machine (see doc comment above). Reached only when this cycle is NOT
  // a full duplicate (step 0), so it always (re-)evaluates fresh here — unconditional, exactly as
  // before a candle-new cycle, and now ALSO on a candle-duplicate cycle whose riskStress genuinely moved.
  const panicConditionMet = canonicalMarketRegimeEnginePanicConditionMet({
    riskStress: inputs.riskStress,
    directionFast: inputs.directionFast,
    breadth: inputs.breadth,
    coverageStatus: inputs.coverage.status,
  });
  const panicState = advanceCanonicalMarketRegimeEnginePanicState(
    {
      panicActive: basePrior.panicActive,
      panicSinceMs: basePrior.stateHistory.panicSinceMs,
      panicCyclesSinceExitCandidate: basePrior.stateHistory.panicCyclesSinceExitCandidate,
    },
    panicConditionMet,
    inputs.nowMs,
  );

  const state: CanonicalMarketRegimeEnginePriorState = {
    projection,
    enterCandidate,
    enterCandidateCycles,
    panicActive: panicState.panicActive,
    stateHistory: {
      projectionSinceMs,
      cyclesInProjection,
      lastFlipAtMs,
      panicSinceMs: panicState.panicSinceMs,
      panicCyclesSinceExitCandidate: panicState.panicCyclesSinceExitCandidate,
    },
    sourceObservationIds: inputs.sourceObservationIds,
    lastRiskStress: inputs.riskStress,
  };

  const overlays = computeCanonicalMarketRegimeEngineOverlays({
    directionFast: inputs.directionFast,
    breadth: inputs.breadth,
    cohesion: inputs.cohesion,
    riskStress: inputs.riskStress,
    coverageStatus: inputs.coverage.status,
    panicActive: state.panicActive,
    cyclesInProjection: state.stateHistory.cyclesInProjection,
    enterCandidateCycles: state.enterCandidateCycles,
  });

  return { isDuplicateCycle: false, candidateDirection, projection, overlays, state };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 4 — durability + public API. See the file header's STAGE 4 SCOPE section for the
// cross-cutting design notes (field-for-field cross-check against the two sibling files' pre-existing
// local mirrors, the two deliberate deviations from them, the duplicate-cycle short-circuit, the
// strict/tolerant store discipline). Nothing below performs a background fetch, calls BinanceClient,
// resolves the universe, or is scheduled/called from anywhere yet.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── version + status ────────────────────────────────────────────────────────────

export const CANONICAL_MARKET_REGIME_SNAPSHOT_SCHEMA_VERSION: 1 = 1;
/** Bumps on any change to the pure classifier logic itself (stages 2-3's compute/state-machine
 *  functions), independent of calibration. A calibration threshold change bumps calibrationVersion
 *  instead (see CANONICAL_MARKET_REGIME_DEFAULT_CALIBRATION_VERSION), never this constant. */
export const CANONICAL_MARKET_REGIME_ENGINE_VERSION = "1.0.0";
/** Which frozen calibration run's thresholds/hysteresis params produced a snapshot — NEVER null. A
 *  snapshot with no explicitly-promoted calibration run is always traceable to this literal string,
 *  matching the approved design's "v1-hand-set-defaults... until an operator has ever explicitly
 *  promoted a real frozen run to active" contract. canonical-market-regime-calibration.ts owns
 *  promoting a real frozen run to active; this file only owns the default. */
export const CANONICAL_MARKET_REGIME_DEFAULT_CALIBRATION_VERSION = "v1-hand-set-defaults";

/** Below this attempted-universe size, even 100%-covered breadth/cohesion/liquidity-cap statistics are
 *  not statistically meaningful — a genuinely different failure mode from ordinary LOW_COVERAGE (which
 *  is about the FRACTION of a large-enough universe that had usable data this cycle, not the absolute
 *  size of the attempted universe itself). Forces DEGRADED_INSUFFICIENT_SYMBOLS + INVALID coverage
 *  (→ MIXED, via the existing, untouched coverage-forces-MIXED machinery) regardless of how high
 *  coveragePct itself reads. 10 is a reasoned v1 floor (single digits cannot support a meaningful
 *  equal-weight breadth or median-based cohesion/dispersion reading), env-independent, calibration-
 *  revisitable like every other hand-set v1 threshold in this file. */
export const CANONICAL_MARKET_REGIME_ENGINE_MIN_UNIVERSE_SIZE = 10;

export type CanonicalMarketRegimeSnapshotStatus =
  | "VALID"
  | "DEGRADED_STALE_UNIVERSE"
  | "DEGRADED_INSUFFICIENT_SYMBOLS"
  | "ENGINE_DISABLED"
  | "COMPUTE_ERROR";

/** Superset of stage 1's CanonicalMarketRegimeEngineDataQuality ("OK"|"MISSING") — "STALE" is reserved
 *  for a later stage's universe-join (e.g. spreadBps/openInterestUsd sourced from a cache older than
 *  the return data itself). Nothing in this file emits "STALE" yet; the type already allows it so a
 *  later stage's addition is additive, never a breaking rename. */
export type CanonicalMarketRegimeSnapshotDataQuality = CanonicalMarketRegimeEngineDataQuality | "STALE";

export interface CanonicalMarketRegimeSnapshotPerSymbol {
  symbol: string;
  returnFastPct: number | null;
  returnSlowPct: number | null;
  quoteVolume24hUsd: number | null;
  spreadBps: number | null;
  openInterestUsd: number | null;
  dataQuality: CanonicalMarketRegimeSnapshotDataQuality;
}

/**
 * The one versioned, durable output type — see file header's STAGE 4 SCOPE section for the
 * field-by-field cross-check against the two sibling files' own pre-existing local structural mirrors.
 * `enterCandidate`/`enterCandidateCycles` are the one deliberate ADDITION beyond those mirrors' literal
 * field lists — see this interface's own inline comment on those two fields for why they are required
 * for correctness, not optional polish.
 */
export interface CanonicalMarketRegimeSnapshot {
  schemaVersion: 1;
  engineVersion: string;
  calibrationVersion: string;
  atMs: number;
  atIso: string;
  universeVersion: string;
  universeSize: number;
  sourceObservationIds: Record<string, string>;
  perSymbol: CanonicalMarketRegimeSnapshotPerSymbol[];
  directionFast: number;
  directionSlow: number;
  breadth: number;
  cohesion: number;
  dispersion: number;
  riskStress: number;
  coverage: CanonicalMarketRegimeEngineCoverageResult;
  projection: CanonicalMarketRegimeEngineProjection;
  regimeFamily: AxisRegimeFamily;
  overlays: CanonicalMarketRegimeEngineOverlays;
  confidence: number;
  stateHistory: CanonicalMarketRegimeEngineStateHistory;
  /** Stage 3's own enter-confirmation accumulator (CanonicalMarketRegimeEnginePriorState's own
   *  `enterCandidate`/`enterCandidateCycles`) — NOT part of `stateHistory` (that type is stage-3-owned
   *  and untouched here) but REQUIRED on this type for correctness: computeCanonicalMarketRegimeSnapshot's
   *  only source of cross-call memory is the PRIOR CanonicalMarketRegimeSnapshot it is handed (matching
   *  canonical-market-regime-calibration.ts's own already-declared ComputeCanonicalMarketRegimeSnapshotFn
   *  signature, which threads a snapshot — not a CanonicalMarketRegimeEnginePriorState — as its own
   *  cross-call memory). Without these two fields living on the snapshot itself, a multi-cycle
   *  enter-confirmation streak (ENTER_CONFIRM_CYCLES=3) could never actually accumulate across separate
   *  computeCanonicalMarketRegimeSnapshot calls — every call would reconstruct a prior state with
   *  enterCandidateCycles pinned at 0, and the asymmetric-hysteresis design (a core, adversarially-
   *  tested requirement) would silently never confirm a directional flip. Identical contract to
   *  CanonicalMarketRegimeEnginePriorState's own same-named fields: null/0 whenever no directional
   *  accumulation is in progress. */
  enterCandidate: CanonicalMarketRegimeEngineDirectionalState | null;
  enterCandidateCycles: number;
  status: CanonicalMarketRegimeSnapshotStatus;
}

/**
 * The ONE safe-default builder — reused verbatim by the kill switch, cold start (no snapshot ever
 * recorded), and available for a future orchestration stage's own COMPUTE_ERROR catch, so there is
 * exactly one "safe default" shape in the whole system, never several ad hoc ones that could drift
 * apart. Always: projection/regimeFamily MIXED, overlays.lowCoverage true (every other overlay false),
 * confidence 0, INVALID coverage carrying `reason`, zero symbols/history — the same conservative
 * cold-start shape initialCanonicalMarketRegimeEngineProjectionState seeds stage 3's own state machine
 * with, extended to the full versioned snapshot shape.
 */
export function degradedLowCoverageSnapshot(
  nowMs: number,
  reason: string,
  status: CanonicalMarketRegimeSnapshotStatus = "DEGRADED_INSUFFICIENT_SYMBOLS",
): CanonicalMarketRegimeSnapshot {
  return {
    schemaVersion: CANONICAL_MARKET_REGIME_SNAPSHOT_SCHEMA_VERSION,
    engineVersion: CANONICAL_MARKET_REGIME_ENGINE_VERSION,
    calibrationVersion: CANONICAL_MARKET_REGIME_DEFAULT_CALIBRATION_VERSION,
    atMs: nowMs,
    atIso: new Date(nowMs).toISOString(),
    universeVersion: "unknown",
    universeSize: 0,
    sourceObservationIds: {},
    perSymbol: [],
    directionFast: 0,
    directionSlow: 0,
    breadth: 0,
    cohesion: 0,
    dispersion: 0,
    riskStress: 0,
    coverage: { status: "INVALID", coveragePct: 0, validSymbolCount: 0, requiredSymbolCount: 0, reasons: [reason] },
    projection: "MIXED",
    regimeFamily: "MIXED",
    overlays: { transition: false, highStress: false, panic: false, lowCoverage: true, rotational: false, fragmented: false },
    confidence: 0,
    stateHistory: { projectionSinceMs: nowMs, cyclesInProjection: 0, lastFlipAtMs: null, panicSinceMs: null, panicCyclesSinceExitCandidate: 0 },
    enterCandidate: null,
    enterCandidateCycles: 0,
    status,
  };
}

// ─── confidence ("nEff analogue") ─────────────────────────────────────────────────

/**
 * confidence = coveragePct × stability, in [0,1]; 0 outright whenever coverage itself is not VALID
 * (matching LOW_COVERAGE's own severity — a DEGRADED/INVALID cycle is never partially trusted just
 * because cyclesInProjection happens to be high). `stability` = min(1, cyclesInProjection /
 * ENTER_CONFIRM_CYCLES) — a fresh flip (cyclesInProjection=1) starts at 1/3 confidence and reaches full
 * scale once the projection has held for at least ENTER_CONFIRM_CYCLES(3) cycles, the same window a
 * directional entry itself needed to confirm. A reasoned v1 formula (hand-set, like every other v1
 * constant in this file), calibration-revisitable, never PnL-derived.
 */
export function computeCanonicalMarketRegimeEngineConfidence(inputs: {
  coveragePct: number;
  coverageStatus: CanonicalMarketRegimeEngineCoverageStatus;
  cyclesInProjection: number;
}): number {
  if (inputs.coverageStatus !== "VALID") return 0;
  if (!Number.isFinite(inputs.coveragePct) || !Number.isFinite(inputs.cyclesInProjection)) return 0;
  const stability = Math.min(1, Math.max(0, inputs.cyclesInProjection) / CANONICAL_MARKET_REGIME_ENGINE_ENTER_CONFIRM_CYCLES);
  return clamp01(inputs.coveragePct) * stability;
}

// ─── the pure assembler (computeCanonicalMarketRegimeSnapshot) ───────────────────

/** The pure core's per-symbol input — deliberately narrower than CanonicalMarketRegimeSnapshotPerSymbol
 *  (mirrors canonical-market-regime-calibration.ts's own CanonicalMarketRegimeRawSymbolFeatureLike
 *  contract: "built from raw completed-candle data only; a symbol with insufficient lookback history
 *  or a missing candle gets null, NEVER a fabricated 0"). `dataQuality`/`sourceObservationId` are
 *  OPTIONAL real-orchestration extras a calibration replay bar never has — see
 *  computeCanonicalMarketRegimeSnapshot's own inline inference rule for what an omitted dataQuality
 *  defaults to. */
export interface CanonicalMarketRegimeRawSymbolFeature {
  symbol: string;
  returnFastPct: number | null;
  returnSlowPct: number | null;
  quoteVolume24hUsd: number | null;
  /** Real orchestration joins these in from the universe module's own per-symbol meta; omitted (as in
   *  a calibration replay bar, which has neither) resolves to null, never a fabricated 0. */
  spreadBps?: number | null;
  openInterestUsd?: number | null;
  dataQuality?: CanonicalMarketRegimeEngineDataQuality;
  /** True stage-1 identity when available; omitted (a calibration replay bar has no real ingestion
   *  cycle) falls back to a per-bar synthetic id — still uniquely-changing-per-bar so
   *  diffCanonicalMarketRegimeEngineObservationIds' dedup keeps working correctly across a replay
   *  sequence. */
  sourceObservationId?: string;
}

export interface CanonicalMarketRegimeRawFeatures {
  atMs: number;
  perSymbol: CanonicalMarketRegimeRawSymbolFeature[];
  /** Attempted-universe size for coverage's own denominator. Defaults to perSymbol.length when
   *  omitted — i.e. every supplied row IS the attempted universe, true for a calibration replay bar
   *  (which never fabricates a MISSING row it did not actually attempt). Real orchestration should
   *  pass stage 1's own true requiredSymbolCount explicitly whenever it differs. */
  requiredSymbolCount?: number;
  universeVersion?: string;
  universeSize?: number;
  /** Set by a later orchestration stage when the universe module's own bounded staleness ceiling
   *  (48h — see canonical-market-regime-universe.ts) has been exceeded. Forces DEGRADED_STALE_UNIVERSE
   *  the same way CANONICAL_MARKET_REGIME_ENGINE_MIN_UNIVERSE_SIZE forces DEGRADED_INSUFFICIENT_SYMBOLS
   *  — see file header's STAGE 4 SCOPE section. */
  universeStale?: boolean;
  /** Risk-stress raw ingredients — all optional. Entirely absent (as in a calibration replay bar,
   *  which has no historical funding/OI/long-BTC-window series available) reads as "no additional risk
   *  data this cycle" via computeCanonicalMarketRegimeEngineRiskStress's own already-established
   *  renormalize-over-available-terms handling of an empty funding/OI map and a null
   *  btcAtrPercentile — NEVER a fabricated calm 0 smuggled in by this assembler. */
  btcCandles?: Candle[];
  fundingRateBySymbol?: Record<string, number | null | undefined>;
  openInterestChangePercentBySymbol?: Record<string, number | null | undefined>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The pure assembler — position-and-name compatible with canonical-market-regime-calibration.ts's own
 * already-declared `ComputeCanonicalMarketRegimeSnapshotFn` (rawFeatures, priorSnapshot,
 * calibrationParams, nowMs); `calibrationVersion` is a genuine 5th, OPTIONAL trailing parameter real
 * orchestration can use — a function with an extra optional parameter remains assignable to that
 * narrower 4-parameter function type, so this does not break that compatibility. Internally re-derives
 * stage 3's own `CanonicalMarketRegimeEnginePriorState` from `priorSnapshot` and calls stages 2-3's
 * already-tested functions unchanged — this function only orchestrates, it recomputes none of their
 * logic.
 *
 * Requirement #4 (test E) is enforced HERE too, one layer above stage 3's own internal dedup: a
 * genuinely duplicate cycle (unchanged sourceObservationIds AND unchanged universe-staleness AND
 * unchanged riskStress — see FINDING 2 fix below) returns `priorSnapshot` completely untouched — not
 * even atMs/atIso advance — rather than assembling a new object that would merely happen to carry
 * identical projection/overlays/stateHistory. A cold start (`priorSnapshot === null`) is never a
 * duplicate, matching diffCanonicalMarketRegimeEngineObservationIds' own contract.
 *
 * FINDING 2 FIX (2026-08): riskStress's own raw ingredients (fundingRateBySymbol,
 * openInterestChangePercentBySymbol, btcCandles) are NOT part of sourceObservationIds — they can
 * escalate faster than the hourly candles that identity key is built from. riskStress is therefore
 * always computed fresh (unconditionally, before the duplicate check) and compared against
 * `priorSnapshot.riskStress`; a candle-identical cycle whose riskStress moved is NOT short-circuited —
 * it falls through to `advanceCanonicalMarketRegimeEngineProjection`, which freezes the DIRECTIONAL
 * hysteresis (candle-identity-keyed — nothing new to confirm there) while still freshly re-evaluating
 * PANIC off the new riskStress, per that function's own doc comment.
 */
export function computeCanonicalMarketRegimeSnapshot(
  rawFeatures: CanonicalMarketRegimeRawFeatures,
  priorSnapshot: CanonicalMarketRegimeSnapshot | null,
  calibrationParams: Record<string, number> = {},
  nowMs: number = rawFeatures.atMs,
  calibrationVersion: string = CANONICAL_MARKET_REGIME_DEFAULT_CALIBRATION_VERSION,
): CanonicalMarketRegimeSnapshot {
  const perSymbolResolved = rawFeatures.perSymbol.map((s) => {
    const dataQuality: CanonicalMarketRegimeEngineDataQuality =
      s.dataQuality ?? (s.returnFastPct === null && s.returnSlowPct === null && s.quoteVolume24hUsd === null ? "MISSING" : "OK");
    return { ...s, dataQuality };
  });

  const sourceObservationIds: Record<string, string> = {};
  for (const s of perSymbolResolved) {
    if (s.dataQuality !== "OK") continue; // structurally excluded — matches stage 1's own OK-only contract
    sourceObservationIds[s.symbol] = s.sourceObservationId ?? `${s.symbol}|synthetic|${rawFeatures.atMs}`;
  }

  // FINDING 2 FIX: riskStress must be computed BEFORE the duplicate check, unconditionally, so its raw
  // ingredients (funding/OI/BTC vol — which can escalate faster than the hourly candles
  // sourceObservationIds is keyed on) are never suppressed by a candle-only dedup decision. Cheap and
  // pure (no I/O), so computing it even on what turns out to be a genuine full duplicate costs nothing
  // meaningful — see this function's own doc comment above ("a duplicate cycle is cheap") for the
  // now-updated scope of that claim: only direction/breadth/cohesion (below) remain skippable.
  const riskStressResult = computeCanonicalMarketRegimeEngineRiskStress({
    btcCandles: rawFeatures.btcCandles ?? [],
    fundingRateBySymbol: rawFeatures.fundingRateBySymbol ?? {},
    openInterestChangePercentBySymbol: rawFeatures.openInterestChangePercentBySymbol ?? {},
  });

  if (priorSnapshot !== null) {
    const delta = diffCanonicalMarketRegimeEngineObservationIds(sourceObservationIds, priorSnapshot.sourceObservationIds);
    const universeStaleUnchanged = Boolean(rawFeatures.universeStale) === (priorSnapshot.status === "DEGRADED_STALE_UNIVERSE");
    // riskStress is compared against the PRIOR SNAPSHOT's own recorded value (never a raw funding/OI
    // diff — this file stores no such ledger) — deterministic pure function of identical inputs, so
    // exact equality is precise, matching every other identity comparison in this file (never fuzzy).
    const riskStressUnchanged = riskStressResult.riskStress === priorSnapshot.riskStress;
    if (delta.isDuplicateCycle && universeStaleUnchanged && riskStressUnchanged) return priorSnapshot;
  }

  const maxSingleSymbolWeightPct =
    isFiniteNumber(calibrationParams.maxSingleSymbolWeightPct) && calibrationParams.maxSingleSymbolWeightPct > 0
      ? calibrationParams.maxSingleSymbolWeightPct
      : CANONICAL_MARKET_REGIME_ENGINE_MAX_SINGLE_SYMBOL_WEIGHT_PCT;

  const stats: CanonicalMarketRegimeEngineSymbolStat[] = perSymbolResolved.map((s) => ({
    symbol: s.symbol,
    dataQuality: s.dataQuality,
    returnFastPct: s.returnFastPct,
    returnSlowPct: s.returnSlowPct,
    quoteVolume24hUsd: s.quoteVolume24hUsd,
  }));

  const direction = computeCanonicalMarketRegimeEngineDirection(stats, maxSingleSymbolWeightPct);
  const breadthResult = computeCanonicalMarketRegimeEngineBreadth(stats);
  const cohesionDispersion = computeCanonicalMarketRegimeEngineCohesionDispersion(stats);

  const validSymbolCount = stats.filter((s) => s.dataQuality === "OK").length;
  const requiredSymbolCount = rawFeatures.requiredSymbolCount ?? rawFeatures.perSymbol.length;
  const coveragePct = requiredSymbolCount > 0 ? validSymbolCount / requiredSymbolCount : 0;
  const rawCoverage = classifyCanonicalMarketRegimeEngineCoverage({ coveragePct, validSymbolCount, requiredSymbolCount });

  // FINDING 1 FIX: candle-fetch success alone does not make this cycle's data trustworthy — a symbol
  // can have perfectly healthy candles (dataQuality "OK", counted in validSymbolCount/coveragePct
  // above) yet a separately-failed volume pipeline (quoteVolume24hUsd null), which the candle-only
  // coverage above is structurally blind to (quoteVolume24hUsd is joined in from a genuinely separate
  // parameter/pipeline than candle dataQuality — see this file's own STAGE 2 SCOPE note). Classified
  // here with the SAME classifyCanonicalMarketRegimeEngineCoverage thresholds (85%/60% of the SAME
  // requiredSymbolCount denominator), reused rather than inventing a new, uncalibrated magic number —
  // a symbol whose volume pipeline failed is exactly as much a data-quality failure for THIS cycle's
  // liquidity-weighted direction as a candle-fetch failure already is for its return. This is layered
  // ON TOP OF (not instead of) the liquidity-weighting function's own now-unconditional cap enforcement
  // (see computeCanonicalMarketRegimeEngineLiquidityWeights) — that fix alone stops any single symbol
  // from exceeding the 15% cap; this one additionally makes the cycle's own coverage/overlays/
  // candidateDirection honestly reflect that the direction reading is thin, exactly like an ordinary
  // candle-fetch LOW_COVERAGE cycle already does. Only `.status` feeds downstream (see
  // classifyCanonicalMarketRegimeEngineCoverage's own doc comment); `coveragePct`/`validSymbolCount`
  // below stay candle-based — same convention the MIN_UNIVERSE_SIZE/universeStale overrides just below
  // already use — with `reasons` carrying the volume-specific explanation.
  const validVolumeSymbolCount = stats.filter(
    (s) => s.dataQuality === "OK" && s.quoteVolume24hUsd !== null && Number.isFinite(s.quoteVolume24hUsd) && s.quoteVolume24hUsd > 0,
  ).length;
  const volumeCoveragePct = requiredSymbolCount > 0 ? validVolumeSymbolCount / requiredSymbolCount : 0;
  const volumeCoverage = classifyCanonicalMarketRegimeEngineCoverage({
    coveragePct: volumeCoveragePct,
    validSymbolCount: validVolumeSymbolCount,
    requiredSymbolCount,
  });
  const candleAndVolumeReasons =
    volumeCoverage.status === "VALID"
      ? rawCoverage.reasons
      : [
          ...rawCoverage.reasons,
          `liquidity-weight volume data is insufficient for a trustworthy direction: ${validVolumeSymbolCount}/${requiredSymbolCount} symbols have a usable quoteVolume24hUsd (${(volumeCoveragePct * 100).toFixed(1)}%) — treated as ${volumeCoverage.status} coverage`,
        ];
  const candleAndVolumeCoverage: CanonicalMarketRegimeEngineCoverageResult = {
    ...rawCoverage,
    status: worseCanonicalMarketRegimeEngineCoverageStatus(rawCoverage.status, volumeCoverage.status),
    reasons: candleAndVolumeReasons,
  };

  let coverage: CanonicalMarketRegimeEngineCoverageResult = candleAndVolumeCoverage;
  let snapshotStatus: CanonicalMarketRegimeSnapshotStatus = "VALID";
  if (requiredSymbolCount < CANONICAL_MARKET_REGIME_ENGINE_MIN_UNIVERSE_SIZE) {
    coverage = {
      ...candleAndVolumeCoverage,
      status: "INVALID",
      reasons: [
        ...candleAndVolumeCoverage.reasons,
        `requiredSymbolCount ${requiredSymbolCount} is below the minimum trustworthy universe size of ${CANONICAL_MARKET_REGIME_ENGINE_MIN_UNIVERSE_SIZE}`,
      ],
    };
    snapshotStatus = "DEGRADED_INSUFFICIENT_SYMBOLS";
  } else if (rawFeatures.universeStale) {
    coverage = {
      ...candleAndVolumeCoverage,
      status: "INVALID",
      reasons: [...candleAndVolumeCoverage.reasons, "universe snapshot exceeds its bounded staleness ceiling"],
    };
    snapshotStatus = "DEGRADED_STALE_UNIVERSE";
  }

  const priorState: CanonicalMarketRegimeEnginePriorState | null = priorSnapshot
    ? {
        projection: priorSnapshot.projection,
        enterCandidate: priorSnapshot.enterCandidate,
        enterCandidateCycles: priorSnapshot.enterCandidateCycles,
        panicActive: priorSnapshot.overlays.panic,
        stateHistory: priorSnapshot.stateHistory,
        sourceObservationIds: priorSnapshot.sourceObservationIds,
        lastRiskStress: priorSnapshot.riskStress,
      }
    : null;

  const step = advanceCanonicalMarketRegimeEngineProjection(priorState, {
    nowMs,
    directionFast: direction.directionFast,
    directionSlow: direction.directionSlow,
    breadth: breadthResult.breadth,
    cohesion: cohesionDispersion.cohesion,
    riskStress: riskStressResult.riskStress,
    coverage,
    sourceObservationIds,
  });

  const confidence = computeCanonicalMarketRegimeEngineConfidence({
    coveragePct: coverage.coveragePct,
    coverageStatus: coverage.status,
    cyclesInProjection: step.state.stateHistory.cyclesInProjection,
  });

  const perSymbol: CanonicalMarketRegimeSnapshotPerSymbol[] = perSymbolResolved.map((s) => ({
    symbol: s.symbol,
    returnFastPct: s.returnFastPct,
    returnSlowPct: s.returnSlowPct,
    quoteVolume24hUsd: s.quoteVolume24hUsd,
    spreadBps: s.spreadBps ?? null,
    openInterestUsd: s.openInterestUsd ?? null,
    dataQuality: s.dataQuality,
  }));

  return {
    schemaVersion: CANONICAL_MARKET_REGIME_SNAPSHOT_SCHEMA_VERSION,
    engineVersion: CANONICAL_MARKET_REGIME_ENGINE_VERSION,
    calibrationVersion,
    atMs: nowMs,
    atIso: new Date(nowMs).toISOString(),
    universeVersion: rawFeatures.universeVersion ?? "unknown",
    universeSize: rawFeatures.universeSize ?? rawFeatures.perSymbol.length,
    sourceObservationIds: step.state.sourceObservationIds,
    perSymbol,
    directionFast: direction.directionFast,
    directionSlow: direction.directionSlow,
    breadth: breadthResult.breadth,
    cohesion: cohesionDispersion.cohesion,
    dispersion: cohesionDispersion.dispersion,
    riskStress: riskStressResult.riskStress,
    coverage,
    projection: step.projection,
    regimeFamily: step.projection,
    overlays: step.overlays,
    confidence,
    stateHistory: step.state.stateHistory,
    enterCandidate: step.state.enterCandidate,
    enterCandidateCycles: step.state.enterCandidateCycles,
    status: snapshotStatus,
  };
}

// ─── strict, read-only decoder (mirrors cortex-brain-store.ts's readCortexBrainStoreStrict) ─────────

export type CanonicalMarketRegimeSnapshotStoreReadStatus =
  | "VALID"
  | "FILE_MISSING"
  | "JSON_CORRUPTED"
  | "SCHEMA_MISMATCH"
  | "PARTIAL_INVALID"
  | "HISTORY_INCONSISTENT";

export interface CanonicalMarketRegimeSnapshotStoreState {
  schemaVersion: 1;
  latest: CanonicalMarketRegimeSnapshot | null;
  history: CanonicalMarketRegimeSnapshot[];
  updatedAtIso: string | null;
}

export type CanonicalMarketRegimeSnapshotStoreStrictRead =
  | { readonly status: "VALID"; readonly state: CanonicalMarketRegimeSnapshotStoreState }
  | { readonly status: Exclude<CanonicalMarketRegimeSnapshotStoreReadStatus, "VALID">; readonly state: null };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}
function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((v) => typeof v === "string");
}
function isIsoString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

const CANONICAL_MARKET_REGIME_SNAPSHOT_PROJECTIONS = new Set<string>(["BULLISH", "BEARISH", "MIXED"]);
const CANONICAL_MARKET_REGIME_SNAPSHOT_REGIME_FAMILIES = new Set<string>(["BULLISH", "BEARISH", "MIXED", "UNKNOWN"]);
const CANONICAL_MARKET_REGIME_SNAPSHOT_COVERAGE_STATUSES = new Set<string>(["VALID", "DEGRADED", "INVALID"]);
const CANONICAL_MARKET_REGIME_SNAPSHOT_STATUSES = new Set<string>([
  "VALID",
  "DEGRADED_STALE_UNIVERSE",
  "DEGRADED_INSUFFICIENT_SYMBOLS",
  "ENGINE_DISABLED",
  "COMPUTE_ERROR",
]);
const CANONICAL_MARKET_REGIME_SNAPSHOT_DATA_QUALITIES = new Set<string>(["OK", "STALE", "MISSING"]);
const CANONICAL_MARKET_REGIME_SNAPSHOT_DIRECTIONAL_STATES = new Set<string>(["BULLISH", "BEARISH"]);

function validCanonicalMarketRegimePerSymbolShape(value: unknown): value is CanonicalMarketRegimeSnapshotPerSymbol {
  if (!isPlainObject(value)) return false;
  if (typeof value.symbol !== "string" || value.symbol.length === 0) return false;
  if (!isFiniteOrNull(value.returnFastPct) || !isFiniteOrNull(value.returnSlowPct) || !isFiniteOrNull(value.quoteVolume24hUsd)) return false;
  if (!isFiniteOrNull(value.spreadBps) || !isFiniteOrNull(value.openInterestUsd)) return false;
  if (typeof value.dataQuality !== "string" || !CANONICAL_MARKET_REGIME_SNAPSHOT_DATA_QUALITIES.has(value.dataQuality)) return false;
  return true;
}

function validCanonicalMarketRegimeCoverageShape(value: unknown): value is CanonicalMarketRegimeEngineCoverageResult {
  if (!isPlainObject(value)) return false;
  if (typeof value.status !== "string" || !CANONICAL_MARKET_REGIME_SNAPSHOT_COVERAGE_STATUSES.has(value.status)) return false;
  if (!isFiniteNumber(value.coveragePct) || !isFiniteNumber(value.validSymbolCount) || !isFiniteNumber(value.requiredSymbolCount)) return false;
  if (!Array.isArray(value.reasons) || !value.reasons.every((r) => typeof r === "string")) return false;
  return true;
}

function validCanonicalMarketRegimeOverlaysShape(value: unknown): value is CanonicalMarketRegimeEngineOverlays {
  if (!isPlainObject(value)) return false;
  return (["transition", "highStress", "panic", "lowCoverage", "rotational", "fragmented"] as const).every(
    (key) => typeof value[key] === "boolean",
  );
}

function validCanonicalMarketRegimeStateHistoryShape(value: unknown): value is CanonicalMarketRegimeEngineStateHistory {
  if (!isPlainObject(value)) return false;
  if (!isFiniteNumber(value.projectionSinceMs) || !isFiniteNumber(value.cyclesInProjection)) return false;
  if (!isFiniteOrNull(value.lastFlipAtMs) || !isFiniteOrNull(value.panicSinceMs)) return false;
  if (!isFiniteNumber(value.panicCyclesSinceExitCandidate)) return false;
  return true;
}

/** Does not normalize, repair, or write — callers receive a canonical copy only after raw proof, same
 *  contract as cortex-brain-store.ts's readCortexBrainStoreStrict. */
export function validCanonicalMarketRegimeSnapshotShape(value: unknown): value is CanonicalMarketRegimeSnapshot {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== CANONICAL_MARKET_REGIME_SNAPSHOT_SCHEMA_VERSION) return false;
  if (typeof value.engineVersion !== "string" || typeof value.calibrationVersion !== "string") return false;
  if (!isFiniteNumber(value.atMs) || !isIsoString(value.atIso)) return false;
  if (typeof value.universeVersion !== "string" || !isFiniteNumber(value.universeSize)) return false;
  if (!isStringRecord(value.sourceObservationIds)) return false;
  if (!Array.isArray(value.perSymbol) || !value.perSymbol.every(validCanonicalMarketRegimePerSymbolShape)) return false;
  if (![value.directionFast, value.directionSlow, value.breadth, value.cohesion, value.dispersion, value.riskStress, value.confidence].every(isFiniteNumber)) {
    return false;
  }
  if (!validCanonicalMarketRegimeCoverageShape(value.coverage)) return false;
  if (typeof value.projection !== "string" || !CANONICAL_MARKET_REGIME_SNAPSHOT_PROJECTIONS.has(value.projection)) return false;
  if (typeof value.regimeFamily !== "string" || !CANONICAL_MARKET_REGIME_SNAPSHOT_REGIME_FAMILIES.has(value.regimeFamily)) return false;
  if (!validCanonicalMarketRegimeOverlaysShape(value.overlays)) return false;
  if (!validCanonicalMarketRegimeStateHistoryShape(value.stateHistory)) return false;
  const enterCandidateOk =
    value.enterCandidate === null ||
    (typeof value.enterCandidate === "string" && CANONICAL_MARKET_REGIME_SNAPSHOT_DIRECTIONAL_STATES.has(value.enterCandidate));
  if (!enterCandidateOk) return false;
  if (!isFiniteNumber(value.enterCandidateCycles) || value.enterCandidateCycles < 0) return false;
  if (typeof value.status !== "string" || !CANONICAL_MARKET_REGIME_SNAPSHOT_STATUSES.has(value.status)) return false;
  return true;
}

/** Strict, read-only decoder for operators/auditors — never normalizes/repairs/writes. Mirrors
 *  cortex-brain-store.ts's readCortexBrainStoreStrict exactly: FILE_MISSING/JSON_CORRUPTED/
 *  SCHEMA_MISMATCH/PARTIAL_INVALID short-circuit before any partial trust is extended;
 *  HISTORY_INCONSISTENT catches the one cross-field invariant this store's own writer maintains
 *  (`latest`, when present, is always the last element of `history` — see CanonicalMarketRegimeSnapshotStore.save). */
export function readCanonicalMarketRegimeSnapshotStoreStrict(file: string): CanonicalMarketRegimeSnapshotStoreStrictRead {
  if (!existsSync(file)) return { status: "FILE_MISSING", state: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { status: "JSON_CORRUPTED", state: null };
  }
  if (!isPlainObject(raw)) return { status: "PARTIAL_INVALID", state: null };
  if (raw.schemaVersion !== CANONICAL_MARKET_REGIME_SNAPSHOT_SCHEMA_VERSION) return { status: "SCHEMA_MISMATCH", state: null };
  const latestRaw = raw.latest;
  if (!(latestRaw === null || validCanonicalMarketRegimeSnapshotShape(latestRaw))) return { status: "PARTIAL_INVALID", state: null };
  if (!Array.isArray(raw.history) || !raw.history.every(validCanonicalMarketRegimeSnapshotShape)) return { status: "PARTIAL_INVALID", state: null };
  if (!(raw.updatedAtIso === null || isIsoString(raw.updatedAtIso))) return { status: "PARTIAL_INVALID", state: null };

  const history = raw.history as CanonicalMarketRegimeSnapshot[];
  const latest = latestRaw as CanonicalMarketRegimeSnapshot | null;
  if (latest !== null) {
    const last = history[history.length - 1];
    if (!last || last.atMs !== latest.atMs) return { status: "HISTORY_INCONSISTENT", state: null };
  }

  return {
    status: "VALID",
    state: { schemaVersion: 1, latest, history, updatedAtIso: (raw.updatedAtIso as string | null) ?? null },
  };
}

// ─── tolerant runtime store (mirrors cortex-brain-store.ts's CortexBrainStore) ───────────────────────

/** ~4000 rows. Since a duplicate cycle (unchanged sourceObservationIds — requirement #4) is never
 *  appended (see `record` below), history grows roughly once per GENUINELY NEW candle close — under
 *  this engine's 1h candle interval that is ~hourly, NOT this engine's own faster 5-minute tick
 *  cadence. 4000 hourly rows is therefore ~166 days of history (generously more than a naive
 *  "2 weeks at the tick cadence" estimate would suggest if duplicates were wrongly counted) — kept at
 *  this round number for ample calibration-harness headroom (canonical-market-regime-calibration.ts's
 *  own MIN_CALIBRATION_STATE_EPISODES=30 discipline wants more history, not less) at negligible JSON
 *  disk cost. */
export const CANONICAL_MARKET_REGIME_SNAPSHOT_MAX_HISTORY = 4000;

export class CanonicalMarketRegimeSnapshotStore {
  private latest: CanonicalMarketRegimeSnapshot | null = null;
  private history: CanonicalMarketRegimeSnapshot[] = [];
  private updatedAtIso: string | null = null;

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<CanonicalMarketRegimeSnapshotStoreState>;
        const latestOk = parsed.latest === null || (parsed.latest !== undefined && validCanonicalMarketRegimeSnapshotShape(parsed.latest));
        const historyOk = Array.isArray(parsed.history) && parsed.history.every(validCanonicalMarketRegimeSnapshotShape);
        if (parsed.schemaVersion === CANONICAL_MARKET_REGIME_SNAPSHOT_SCHEMA_VERSION && latestOk && historyOk) {
          this.latest = (parsed.latest as CanonicalMarketRegimeSnapshot | null) ?? null;
          this.history = parsed.history as CanonicalMarketRegimeSnapshot[];
          this.updatedAtIso = typeof parsed.updatedAtIso === "string" ? parsed.updatedAtIso : null;
        }
        // Any mismatch: this.latest/.history/.updatedAtIso stay at their fresh-seed defaults declared
        // above (null/[]/null) — DISCARDED, never partially repaired, exactly mirroring CortexBrainStore.
      } catch {
        /* corrupt → seed fresh, never partially repaired */
      }
    }
  }

  get(): CanonicalMarketRegimeSnapshot | null {
    return this.latest;
  }

  getHistory(): readonly CanonicalMarketRegimeSnapshot[] {
    return this.history;
  }

  /**
   * Records a newly-computed snapshot as the new `latest` + appends it to the bounded `history`,
   * UNLESS this snapshot is a genuine duplicate of the current `latest` — sourceObservationIds
   * unchanged, status unchanged, AND riskStress unchanged (FINDING 2 fix, 2026-08: riskStress's raw
   * ingredients funding/OI/BTC-vol can escalate faster than the hourly candles sourceObservationIds is
   * keyed on, exactly why computeCanonicalMarketRegimeSnapshot's own duplicate check already carries
   * this same riskStress term — this store re-derives the duplicate check independently, via
   * diffCanonicalMarketRegimeEngineObservationIds, rather than trusting reference equality alone, so it
   * must carry the identical term or it silently drops a risk-escalated snapshot as a no-op purely
   * because candle identity and status happen to be unchanged) — then this is a no-op (returns false,
   * does not even touch `updatedAtIso`), extending requirement #4 to the persisted layer: "do not
   * append a new history row" on a duplicate. Returns true iff `latest`/`history`/`updatedAtIso`
   * actually changed.
   */
  record(snapshot: CanonicalMarketRegimeSnapshot, nowIso: string = new Date(snapshot.atMs).toISOString()): boolean {
    if (this.latest) {
      const delta = diffCanonicalMarketRegimeEngineObservationIds(snapshot.sourceObservationIds, this.latest.sourceObservationIds);
      const riskStressUnchanged = snapshot.riskStress === this.latest.riskStress;
      if (delta.isDuplicateCycle && snapshot.status === this.latest.status && riskStressUnchanged) return false;
    }
    this.latest = snapshot;
    this.history.push(snapshot);
    if (this.history.length > CANONICAL_MARKET_REGIME_SNAPSHOT_MAX_HISTORY) {
      this.history.splice(0, this.history.length - CANONICAL_MARKET_REGIME_SNAPSHOT_MAX_HISTORY);
    }
    this.updatedAtIso = nowIso;
    return true;
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const state: CanonicalMarketRegimeSnapshotStoreState = {
      schemaVersion: CANONICAL_MARKET_REGIME_SNAPSHOT_SCHEMA_VERSION,
      latest: this.latest,
      history: this.history,
      updatedAtIso: this.updatedAtIso,
    };
    writeFileSync(tmp, JSON.stringify(state), "utf-8");
    renameSync(tmp, this.file);
  }
}

let canonicalMarketRegimeSnapshotStoreSingleton: CanonicalMarketRegimeSnapshotStore | null = null;
export function getCanonicalMarketRegimeSnapshotStore(dataDir = "data"): CanonicalMarketRegimeSnapshotStore {
  if (!canonicalMarketRegimeSnapshotStoreSingleton) {
    canonicalMarketRegimeSnapshotStoreSingleton = new CanonicalMarketRegimeSnapshotStore(
      resolve(dataDir, "canonical-market-regime-history.json"),
    );
  }
  return canonicalMarketRegimeSnapshotStoreSingleton;
}
export function _resetCanonicalMarketRegimeSnapshotStoreForTests(): void {
  canonicalMarketRegimeSnapshotStoreSingleton = null;
}

/** Persists a freshly-computed snapshot (the write half of the getter/computer pair a later
 *  orchestration stage drives: ingest → computeCanonicalMarketRegimeSnapshot →
 *  recordCanonicalMarketRegimeSnapshot, on a timer). Only writes to disk when `store.record` actually
 *  changed something — never on a duplicate cycle — so a duplicate produces zero disk I/O, not just a
 *  no-op in memory. Returns whatever `store.record` returned. */
export function recordCanonicalMarketRegimeSnapshot(snapshot: CanonicalMarketRegimeSnapshot, dataDir = "data"): boolean {
  const store = getCanonicalMarketRegimeSnapshotStore(dataDir);
  const changed = store.record(snapshot);
  if (changed) store.save();
  return changed;
}

// ─── kill switch + the non-nullable public getter ─────────────────────────────────

/** Staged-introduction convention (mirrors crisis-mode-instance-guard.ts's own env-flag style,
 *  simplified per this rollout's explicit "hard cutover, no beta ramp needed" decision). Default
 *  UNSET = engine ACTIVE — this is a hard cutover, not an opt-in. Set to the literal string "1" to
 *  force every accessor to the ENGINE_DISABLED degraded snapshot without performing any network I/O
 *  (checked before the store is even touched). */
export const CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY = "CANONICAL_MARKET_REGIME_ENGINE_DISABLED";

function canonicalMarketRegimeEngineKillSwitchActive(env: NodeJS.ProcessEnv): boolean {
  return env[CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY] === "1";
}

/**
 * THE non-nullable public getter — see file header's STAGE 4 SCOPE section. Kill-switch active →
 * ENGINE_DISABLED degraded snapshot, decided BEFORE touching the store (a disabled engine performs no
 * disk I/O either). Otherwise: the store's own `latest` if one has ever been recorded, else a
 * cold-start degraded snapshot. The SAME `degradedLowCoverageSnapshot` builder in both degraded
 * branches (only `reason`/`status` differ) — never a `null`/`undefined`/`{allowed:true}`-shaped
 * fallback anywhere in this call chain, so a missing/never-ticked/disabled engine can only ever narrow
 * eligibility once wired into canonical-market-regime-execution-policy.ts, never accidentally widen it.
 */
export function getCanonicalMarketRegimeSnapshot(
  dataDir = "data",
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): CanonicalMarketRegimeSnapshot {
  if (canonicalMarketRegimeEngineKillSwitchActive(env)) {
    return degradedLowCoverageSnapshot(nowMs, `engine disabled via ${CANONICAL_MARKET_REGIME_ENGINE_DISABLED_ENV_KEY}`, "ENGINE_DISABLED");
  }
  const latest = getCanonicalMarketRegimeSnapshotStore(dataDir).get();
  if (latest) return latest;
  return degradedLowCoverageSnapshot(nowMs, "canonical regime engine has not produced a snapshot yet (cold start)", "DEGRADED_INSUFFICIENT_SYMBOLS");
}
