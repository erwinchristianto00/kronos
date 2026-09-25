/**
 * CANONICAL MARKET REGIME — shared execution policy (2026-08, requirements #7/#8 of the
 * canonical-market-regime rollout that replaces the fixed-20 candidate LONG/SHORT vote —
 * scan-service.ts's deriveMarketRegime — as the production regime source).
 *
 * This is the ONE function every execution-affecting path consults: the paper mirror /
 * LiveExecutionEngine (via buildIsPaperOrderLiveEligible, app.ts), SingleSymbolLaneExecutor (via
 * edgeVeto), CrossSectionalExecutor (MARKET_NEUTRAL's entryHealthGate; TREND/MIXED inherit it
 * transitively through unifiedRegimeEntryGate), and the innovation testnet executors (via
 * innovationTestnetAdmissionAllowed) — NOT four independently-maintained copies that happen to
 * compute the same thing today and could silently drift apart tomorrow. All four call sites are
 * wired as of the current HEAD: buildIsPaperOrderLiveEligible; buildUnifiedRegimeEntryGate (the
 * shared master gate SingleSymbolLaneExecutor and, transitively, CrossSectionalExecutor's
 * TREND/MIXED variants and the innovation testnet executors all inherit); CrossSectionalExecutor's
 * MARKET_NEUTRAL entryHealthGate; and the innovation testnet bridge's
 * innovationTestnetAdmissionAllowed call — all four in app.ts, all covered by test suites.
 *
 * ── WHAT THIS FUNCTION IS NOT ALLOWED TO DO (requirement #8) ────────────────────────────────────
 * This function NEVER checks armed/kill/drain, account caps, reconciliation, exchange filters, or
 * protective exits — those remain the exclusive responsibility of their existing, untouched gates
 * (LiveExecutionEngine.canOpenNewEntries() and its callers, the kill-switch ledger, the reconciler,
 * exchange-filter validation, and every protective-exit path). This function may only ADD
 * restriction on top of whatever those gates already decided; its output can never overrule or
 * bypass any of them, because it is never consulted BY them for anything other than a narrower,
 * additional new-entry precondition — it has no handle on any of those subsystems at all, by
 * construction (it takes no dependency on the live engine, the kill-switch store, or any exchange
 * client). It also never affects existing/open positions or the exit/protective side: it is wired
 * ONLY into new-entry eligibility checks (buildIsPaperOrderLiveEligible and its future siblings),
 * never into any close/stop/take-profit/reconciliation path.
 *
 * ── WHY THIS FILE DOES NOT IMPORT canonical-market-regime-engine.ts ─────────────────────────────
 * At the time this file was authored, canonical-market-regime-engine.ts (a separate, not-yet-built
 * stage of this rollout) does not exist in this worktree. Rather than hard-depend on a module that
 * does not exist yet, this file declares `CanonicalMarketRegimeSnapshot` as a local, field-for-field
 * STRUCTURAL mirror of the approved design's snapshot interface (the exact same convention already
 * used by canonical-market-regime-calibration.ts's own `CanonicalMarketRegimeSnapshotLike`, built in
 * an earlier stage of this same rollout under the identical constraint). TypeScript structural
 * typing means that once the real engine file lands and exports its own authoritative
 * `CanonicalMarketRegimeSnapshot`, every caller of this module (including app.ts's
 * `IsPaperOrderLiveEligibleDeps.getCanonicalMarketRegimeSnapshot`) can be pointed at that real type
 * with zero logic changes here — a real snapshot object satisfies this structural shape with zero
 * adapter code. The one-time follow-up cost is purely nominal: replacing this file's local
 * declaration with `import type { CanonicalMarketRegimeSnapshot } from "./canonical-market-regime-engine.js"`
 * and deleting the now-redundant local interface block below.
 *
 * ── LOW_COVERAGE / requirement #5 ────────────────────────────────────────────────────────────────
 * Invalid or expired coverage forces two independent things: (a) the ENGINE itself (once it exists)
 * is designed to stamp `snapshot.regimeFamily = "MIXED"` whenever `overlays.lowCoverage` is true —
 * that is the ENGINE's own responsibility, not this file's; but (b) THIS function additionally,
 * unconditionally re-derives `regimeFamily: "MIXED"` in its OWN returned decision whenever
 * `overlays.lowCoverage` or `coverage.status !== "VALID"` is true, regardless of whatever
 * `snapshot.regimeFamily` already says. This is deliberate defense-in-depth, not a redundant no-op:
 * this policy function must be independently correct and safe to trust even if the engine's own
 * forcing logic were ever buggy or (as is genuinely true right now) simply does not exist yet in
 * this worktree. The hard, unconditional part of requirement #5 — blocking ALL new entries — is the
 * `allowed: false` on this same branch; the MIXED relabeling is the second, belt-and-suspenders
 * layer on top of it.
 *
 * ── PANIC / requirement #6 ───────────────────────────────────────────────────────────────────────
 * `overlays.panic` is an immediate, unconditional hard block on new entries here — no confirmation
 * delay, no partial allowance. The engine's own asymmetric hysteresis (fast panic entry, slow panic
 * exit) governs when `overlays.panic` itself flips; this function does not re-implement or second-
 * guess that timing, it only ever reacts to the boolean it is handed.
 *
 * ── COLD START / FAIL-CLOSED (adversarial risk called out explicitly in the approved design) ─────
 * `snapshot: null` (no engine has ever produced a reading — including, right now, because the
 * engine module does not exist yet at all) resolves to `allowed: false`. There is no `?? { allowed:
 * true }`-shaped fallback anywhere in this file — a missing/never-ticked/disabled snapshot can only
 * ever narrow eligibility, never widen it. This is the single most important property of this file
 * and is exercised directly by this file's own test suite's cold-start case.
 */

import type { AxisRegimeFamily } from "./current-guard-variant-matrix.js";

// ─── structural mirror of canonical-market-regime-engine.ts's snapshot shape (see header note) ────
// Field-for-field match of the approved design's `CanonicalMarketRegimeSnapshot` interface. This
// function only READS a handful of these fields (`atMs`, `overlays.*`, `coverage.status`,
// `regimeFamily`) but the full shape is declared (rather than a narrower ad hoc subset) so that a
// real engine snapshot satisfies it structurally with zero narrowing/casting anywhere it is passed
// in, exactly mirroring canonical-market-regime-calibration.ts's own already-established precedent.

export type CanonicalMarketRegimeProjection = "BULLISH" | "BEARISH" | "MIXED";
export type CanonicalMarketRegimeDataQuality = "OK" | "STALE" | "MISSING";
export type CanonicalMarketRegimeCoverageStatus = "VALID" | "DEGRADED" | "INVALID";
export type CanonicalMarketRegimeSnapshotStatus =
  | "VALID"
  | "DEGRADED_STALE_UNIVERSE"
  | "DEGRADED_INSUFFICIENT_SYMBOLS"
  | "ENGINE_DISABLED"
  | "COMPUTE_ERROR";

export interface CanonicalMarketRegimePerSymbol {
  symbol: string;
  returnFastPct: number | null;
  returnSlowPct: number | null;
  quoteVolume24hUsd: number | null;
  spreadBps: number | null;
  openInterestUsd: number | null;
  dataQuality: CanonicalMarketRegimeDataQuality;
}

export interface CanonicalMarketRegimeCoverage {
  validSymbolCount: number;
  requiredSymbolCount: number;
  coveragePct: number;
  status: CanonicalMarketRegimeCoverageStatus;
  reasons: string[];
}

export interface CanonicalMarketRegimeOverlays {
  transition: boolean;
  highStress: boolean;
  panic: boolean;
  lowCoverage: boolean;
  rotational: boolean;
  fragmented: boolean;
}

export interface CanonicalMarketRegimeStateHistory {
  projectionSinceMs: number;
  cyclesInProjection: number;
  lastFlipAtMs: number | null;
  panicSinceMs: number | null;
  panicCyclesSinceExitCandidate: number;
}

/**
 * Structural mirror only — see file header. NOT imported from canonical-market-regime-engine.ts
 * because that module does not exist in this worktree yet.
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
  perSymbol: CanonicalMarketRegimePerSymbol[];
  directionFast: number;
  directionSlow: number;
  breadth: number;
  cohesion: number;
  dispersion: number;
  riskStress: number;
  coverage: CanonicalMarketRegimeCoverage;
  projection: CanonicalMarketRegimeProjection;
  regimeFamily: AxisRegimeFamily;
  overlays: CanonicalMarketRegimeOverlays;
  confidence: number;
  stateHistory: CanonicalMarketRegimeStateHistory;
  status: CanonicalMarketRegimeSnapshotStatus;
}

/** Matches LIVE_REGIME_GATE_MAX_AGE_MS's existing convention (app.ts's pre-redirect
 *  unifiedRegimeEntryGate default) — 20 minutes. */
export const DEFAULT_MAX_SNAPSHOT_AGE_MS = 20 * 60_000;

export interface CanonicalMarketRegimePolicyDecision {
  allowed: boolean;
  reason: string | null;
  /** Informational this round — not consumed by any position-sizing/entry-retry call site yet.
   *  True when the engine's own TRANSITION overlay is active (a flip is accumulating confirmations,
   *  or just happened). */
  requireRetest: boolean;
  /** Informational this round — not wired into any leg-size call site yet. 1.0 outside HIGH_STRESS,
   *  0.5 while `overlays.highStress` is active. */
  sizeMultiplier: number;
  /** Convenience passthrough of the resolved regimeFamily for callers that also need it (e.g. to
   *  build an ExactLaneContext downstream) — forced to "MIXED" on the LOW_COVERAGE/invalid-coverage
   *  branch specifically (see file header); otherwise a straight passthrough of whatever
   *  `snapshot.regimeFamily` says, and "UNKNOWN" when there is no snapshot at all. */
  regimeFamily: AxisRegimeFamily;
}

export interface CanonicalMarketRegimeExecutionPolicyInput {
  /** Defensively nullable even though the real store's own accessor contract (once
   *  canonical-market-regime-engine.ts exists) is documented to never actually return null — a null
   *  passed here MUST resolve to blocked, never to an accidental allowed-by-default, so a future
   *  caller passing null by mistake (or a genuine cold-start/kill-switch state) can never silently
   *  widen eligibility. */
  snapshot: CanonicalMarketRegimeSnapshot | null;
  nowMs: number;
  maxSnapshotAgeMs?: number;
}

/**
 * The ONE shared execution-policy function (requirement #7). Pure — no I/O, no BinanceClient
 * dependency, no dependency on any live-engine/kill-switch/exchange state — trivially unit-testable
 * with hand-built snapshot fixtures, and safe to call from as many executors as this rollout ends up
 * wiring without any risk of them ever computing different answers for the same snapshot (adversarial
 * test I: "all executors receive identical policy for the same snapshot").
 *
 * Logic, in order — HARD blocks first; this function only ever NARROWS (requirement #8's "may
 * block... but never bypass"), layered as an additional AND on top of whatever the caller's own
 * armed/kill/drain/caps/reconciliation/exchange-filter/protective-exit gates have already decided:
 *   1. no snapshot at all (cold start, kill switch, or — right now — the engine module simply does
 *      not exist yet) -> blocked.
 *   2. snapshot older than `maxSnapshotAgeMs` -> blocked.
 *   3. `overlays.lowCoverage` or `coverage.status !== "VALID"` -> blocked AND regimeFamily forced to
 *      "MIXED" in the decision (requirement #5's double protection — see file header).
 *   4. `overlays.panic` -> blocked (requirement #6's immediate hard block).
 *   5. otherwise allowed=true; sizeMultiplier halved under HIGH_STRESS; requireRetest mirrors
 *      TRANSITION. ROTATIONAL/FRAGMENTED never block outright this round — only the two most severe
 *      overlays (LOW_COVERAGE, PANIC) do, matching that only adversarial tests G and H demand hard-
 *      blocking behavior among the 11 required tests; the richer fields exist on the type for
 *      observability and a future round's sizing wiring, not consumed by any call site yet.
 */
export function canonicalMarketRegimeExecutionPolicy(
  input: CanonicalMarketRegimeExecutionPolicyInput,
): CanonicalMarketRegimePolicyDecision {
  const { snapshot, nowMs } = input;
  const maxSnapshotAgeMs = input.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;

  if (!snapshot) {
    return {
      allowed: false,
      reason: "canonical regime engine has no snapshot yet",
      requireRetest: false,
      sizeMultiplier: 1,
      regimeFamily: "UNKNOWN",
    };
  }

  const ageMs = nowMs - snapshot.atMs;
  if (!Number.isFinite(ageMs) || ageMs > maxSnapshotAgeMs) {
    return {
      allowed: false,
      reason: `canonical regime snapshot stale (${Math.round(ageMs / 1000)}s, max ${Math.round(maxSnapshotAgeMs / 1000)}s)`,
      requireRetest: false,
      sizeMultiplier: 1,
      regimeFamily: snapshot.regimeFamily,
    };
  }

  if (snapshot.overlays.lowCoverage || snapshot.coverage.status !== "VALID") {
    const reasons = snapshot.coverage.reasons ?? [];
    return {
      allowed: false,
      reason: `canonical regime coverage invalid (status=${snapshot.coverage.status}${
        reasons.length > 0 ? `: ${reasons.join(", ")}` : ""
      })`,
      requireRetest: false,
      sizeMultiplier: 1,
      // requirement #5's second, independent layer — see file header. Forced regardless of what
      // snapshot.regimeFamily already contains.
      regimeFamily: "MIXED",
    };
  }

  if (snapshot.overlays.panic) {
    return {
      allowed: false,
      reason: "canonical regime PANIC active",
      requireRetest: false,
      sizeMultiplier: 1,
      regimeFamily: snapshot.regimeFamily,
    };
  }

  return {
    allowed: true,
    reason: null,
    requireRetest: snapshot.overlays.transition,
    sizeMultiplier: snapshot.overlays.highStress ? 0.5 : 1,
    regimeFamily: snapshot.regimeFamily,
  };
}

/**
 * Maps the canonical engine's own `AxisRegimeFamily` onto the free-text labels
 * regime-edge-memory.ts's `normalizeRegimeFamily` (regime-edge-memory.ts:129-138) already buckets
 * into its three learned-history buckets ("BULLISH_EXPANSION" / "BEARISH_EXPANSION" /
 * "MIXED_ROTATION") — the exact same three buckets producer A's old free-text strings ("Bullish
 * expansion" / "Bearish pressure" / "Mixed rotation") already landed in. This is NOT cosmetic:
 * `normalizeRegimeFamily` buckets purely by substring match, and a bare "BULLISH"/"BEARISH"/"MIXED"
 * would NOT contain any of the "expansion"/"pressure"/"breakout"/"breakdown"/"rotation" substrings
 * it looks for, so feeding it a bare family name would silently fall through to its "OTHER" bucket —
 * a fresh bucket with no accrued history, which (per this store's own ALLOW_INSUFFICIENT cold-start
 * behavior) most likely fails OPEN rather than blocking, i.e. a silent WIDENING of eligibility
 * exactly of the class this whole design exists to prevent. Using labels engineered to hit the SAME
 * three buckets means the edge-memory system's already-learned history continues to apply unchanged
 * across the regime-producer swap. This mapping is verified directly against the REAL
 * `normalizeRegimeFamily` function by this file's own test suite, never merely assumed.
 *
 * Included in this file per the approved design ("also in this file"), alongside
 * `canonicalMarketRegimeExecutionPolicy`. Wired as of the current HEAD into both of
 * SingleSymbolLaneExecutor's edgeVeto call sites in app.ts: the REGIME_EDGE_MEMORY vote's
 * `regimeForEdge` lookup and edgeVeto's own `currentRegimeStringForVeto` helper.
 */
export function edgeMemoryLabelForCanonicalFamily(family: AxisRegimeFamily): string | null {
  switch (family) {
    case "BULLISH":
      return "CANONICAL_BULLISH_EXPANSION";
    case "BEARISH":
      return "CANONICAL_BEARISH_PRESSURE";
    case "MIXED":
      return "CANONICAL_MIXED_ROTATION";
    case "UNKNOWN":
      return null;
    default: {
      // Exhaustiveness guard: AxisRegimeFamily is a closed union of exactly these 4 values today
      // (current-guard-variant-matrix.ts:1189). If it is ever widened, this line fails to compile
      // rather than silently returning an unmapped label.
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
}
