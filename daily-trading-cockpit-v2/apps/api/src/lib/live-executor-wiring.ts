/**
 * Pure, testable helpers extracted from app.ts's executor-wiring closures (2026-07-08 audit
 * fix) — app.ts itself has no test file, so this logic was previously entirely unverified by any
 * automated test despite gating real-money exposure and reconcile-safety for 5 executor instances.
 */
import type { CrossSectionalExecutor } from "./cross-sectional-executor.js";
import { clusterOf, isMajorSymbol } from "./correlation-clusters.js";
import type { SingleSymbolLaneExecutor } from "./single-symbol-lane-executor.js";

/** Minimal slice of LiveExecutionEngine this module needs — kept narrow so tests can fake it. */
export interface LiveExecutorGateEngine {
  isArmed(): boolean;
  canOpenNewEntries(): boolean;
  laneSelectionExplicitlyIncludesLane(laneId: string): boolean;
  laneSelectionAllowsLane(laneId: string): boolean;
}

export const TESTNET_CROSS_SECTIONAL_HORIZON_ONLY_ENV = "TESTNET_ONLY_CROSS_SECTIONAL_HORIZON";
export const CROSS_SECTIONAL_HORIZON_LANE_ID = "CROSS_SECTIONAL_MARKET_NEUTRAL";
export const TESTNET_CROSS_SECTIONAL_EXTRA_LANES_ENV = "TESTNET_CROSS_SECTIONAL_EXTRA_LANES";
export const TESTNET_CROSS_SECTIONAL_EXTRA_SYMBOLS_ENV = "TESTNET_CROSS_SECTIONAL_EXTRA_SYMBOLS";

function csvSet(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? "").split(",").map((part) => part.trim().toUpperCase()).filter(Boolean));
}

function laneMatchesAllowlist(laneId: string | null | undefined, allowlist: ReadonlySet<string>): boolean {
  if (!laneId) return false;
  const normalized = laneId.trim().toUpperCase();
  const variantId = normalized.split(":").pop() ?? normalized;
  return allowlist.has(normalized) || allowlist.has(variantId);
}

/** Testnet rollout switch: only the FILTERED cross-sectional horizon executor may open new risk. */
export function isTestnetCrossSectionalHorizonLaneAllowed(
  env: "testnet" | "mainnet" | null,
  laneId: string | null | undefined,
  envVars: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env !== "testnet" || envVars[TESTNET_CROSS_SECTIONAL_HORIZON_ONLY_ENV] !== "1") return true;
  if (laneId === CROSS_SECTIONAL_HORIZON_LANE_ID) return true;
  return laneMatchesAllowlist(laneId, csvSet(envVars[TESTNET_CROSS_SECTIONAL_EXTRA_LANES_ENV]));
}

/**
 * Symbol-level companion to the testnet horizon lock. Extra lanes remain fail-closed unless
 * BOTH the lane and the symbol are explicitly allowlisted. This keeps an experimental testnet
 * rollout such as CG_MFE_GIVEBACK/XRP+WLD from opening the rest of that lane's universe.
 */
export function isTestnetCrossSectionalHorizonSourceAllowed(
  env: "testnet" | "mainnet" | null,
  laneId: string | null | undefined,
  symbol: string | null | undefined,
  envVars: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env !== "testnet" || envVars[TESTNET_CROSS_SECTIONAL_HORIZON_ONLY_ENV] !== "1") return true;
  if (laneId === CROSS_SECTIONAL_HORIZON_LANE_ID) return true;
  if (!isTestnetCrossSectionalHorizonLaneAllowed(env, laneId, envVars)) return false;
  const normalizedSymbol = symbol?.trim().toUpperCase();
  return Boolean(normalizedSymbol && csvSet(envVars[TESTNET_CROSS_SECTIONAL_EXTRA_SYMBOLS_ENV]).has(normalizedSymbol));
}

/**
 * Master permission gate for a newly-wired executor instance (cross-sectional TREND/MIXED, or a
 * SingleSymbolLaneExecutor). Requires, in order: armed (bypassed on testnet), EXPLICIT allocation
 * inclusion (never true just because "no allocation is currently restricting anything" — that's
 * the ALL_LANES default every established lane relies on, which would otherwise let a
 * never-before-executed lane fire at full size before the operator has ever actually picked it),
 * and the plain allow-lane check (redundant once explicit inclusion is true, kept as a defensive
 * second check in case the two functions' semantics ever diverge).
 */
/**
 * The same gate as isNewExecutorLaneAllowed, but it NAMES the condition that bound.
 *
 * WHY (2026-07-27): REGIME_COMPOSITE_CONFIRMATION_LONG — the only lane on this account with a
 * positive real-money record (9 closes, +$7.79) — stopped opening on 2026-07-14 while its signal
 * store kept producing candidates as recently as 2026-07-26. Twelve days of silent refusal, and
 * the executor's own status panel reported `entryBlockReason: null` throughout, because the only
 * reason function wired into it was `() => edgeVeto(dir).reason` — ONE of the gate's conditions.
 * A null reason therefore never meant "not blocked"; it meant "not blocked by the one thing I can
 * see", which is indistinguishable from healthy at a glance. That is the failure this exists to
 * end: a lane that declines every signal must say which rule declined it.
 *
 * isNewExecutorLaneAllowed is now a thin wrapper over this, so the predicate and its explanation
 * cannot drift apart — the usual way this class of bug regenerates is a hand-maintained mirror of
 * the conditions that falls one edit behind.
 *
 * Order matches the original exactly, so `.allowed` is unchanged for every caller.
 */
export function newExecutorLaneGate(
  laneId: string,
  env: "testnet" | "mainnet",
  engine: LiveExecutorGateEngine | null,
  opts: { mainnetEntryEligible?: boolean } = {},
): { allowed: boolean; reason: string | null } {
  if (!engine?.isArmed()) return { allowed: false, reason: "engine is not ARMED" };
  if (!engine.canOpenNewEntries()) return { allowed: false, reason: "new-entry drain is active (operator paused new entries)" };
  if (!isTestnetCrossSectionalHorizonLaneAllowed(env, laneId)) {
    return { allowed: false, reason: "testnet is locked to the cross-sectional horizon lane" };
  }
  if (
    env === "mainnet" &&
    opts.mainnetEntryEligible === false &&
    process.env.LIVE_UNPROVEN_EXECUTION_OVERRIDE !== "1"
  ) {
    return { allowed: false, reason: "lane is not mainnet-entry-eligible (unproven on real money; set LIVE_UNPROVEN_EXECUTION_OVERRIDE=1 to override)" };
  }
  const explicit = engine?.laneSelectionExplicitlyIncludesLane(laneId) ?? false;
  if (!explicit) {
    return { allowed: false, reason: `lane is not named in the operator allocation table (explicit inclusion required; "no allocation restricting anything" does NOT count)` };
  }
  if (!(engine?.laneSelectionAllowsLane(laneId) ?? true)) {
    return { allowed: false, reason: "lane is present in the allocation table but disallowed (0% weight)" };
  }
  return { allowed: true, reason: null };
}

export function isNewExecutorLaneAllowed(
  laneId: string,
  env: "testnet" | "mainnet",
  engine: LiveExecutorGateEngine | null,
  opts: { mainnetEntryEligible?: boolean } = {},
): boolean {
  return newExecutorLaneGate(laneId, env, engine, opts).allowed;
}

export function rollingNetEntryHealth(
  recentNetReturns: readonly number[],
  opts: { shortWindow?: number; longWindow?: number } = {},
): { allowed: boolean; reason: string | null; shortAvg: number | null; longAvg: number | null } {
  const shortWindow = Math.max(1, opts.shortWindow ?? 8);
  const longWindow = Math.max(shortWindow, opts.longWindow ?? 30);
  const finite = recentNetReturns.filter((value) => Number.isFinite(value));
  const avg = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (finite.length < shortWindow) {
    return {
      allowed: false,
      reason: `rolling evidence incomplete: ${finite.length}/${shortWindow} recent closes`,
      shortAvg: null,
      longAvg: null,
    };
  }
  const shortRows = finite.slice(-shortWindow);
  const longRows = finite.slice(-Math.min(longWindow, finite.length));
  const shortAvg = avg(shortRows);
  const longAvg = avg(longRows);
  const allowed = shortAvg > 0 && longAvg > 0;
  return {
    allowed,
    reason: allowed
      ? null
      : `rolling edge negative: last${shortRows.length}=${(shortAvg * 100).toFixed(3)}%, last${longRows.length}=${(longAvg * 100).toFixed(3)}%`,
    shortAvg,
    longAvg,
  };
}

/**
 * Sums open legs/positions across every cross-sectional + single-symbol executor instance into
 * ONE net-qty-per-symbol map, for LiveExecutionEngine's externalManagedNetQty — reconcile must
 * know about every one of these or it flags a real exchange position as an orphan and force
 * -disarms the engine (this exact bug class has hit this codebase before). LONG legs/positions
 * contribute positive qty, SHORT contribute negative; a leg/position with exitOrderId already set
 * is excluded (the exit is already in flight, no longer a claim on the symbol).
 */
export function computeExternalManagedNetQty(
  crossSectionalExecutors: ReadonlyArray<CrossSectionalExecutor | null>,
  singleSymbolExecutors: ReadonlyArray<SingleSymbolLaneExecutor | null>,
): Map<string, number> {
  const net = new Map<string, number>();
  for (const exec of crossSectionalExecutors) {
    if (!exec) continue;
    for (const basket of exec.getStatus().openBaskets) {
      for (const leg of basket.legs) {
        if (leg.exitOrderId !== null) continue;
        net.set(leg.symbol, (net.get(leg.symbol) ?? 0) + (leg.side === "LONG" ? leg.qty : -leg.qty));
      }
    }
    // 2026-07-19 real-money audit follow-up: an orphaned leg (see cross-sectional-executor.ts's
    // OrphanedLeg doc comment — a real, still-open exchange position a basket's own bookkeeping
    // can no longer reach through openBaskets, from a basket-abort flatten failure or a partial
    // close fill) is REAL exchange exposure exactly like an open basket leg — omitting it here
    // means reconcile() sees this real position with claimed=0, logs it as an unexplained "orphan
    // exchange position", and force-disarms the account (this exact bug class has hit this
    // codebase before, per this function's own doc comment above) even though it is a KNOWN,
    // already-self-healing orphan being retried every tick.
    for (const orphan of exec.getStatus().orphanedLegs) {
      net.set(orphan.symbol, (net.get(orphan.symbol) ?? 0) + (orphan.side === "LONG" ? orphan.qty : -orphan.qty));
    }
  }
  for (const exec of singleSymbolExecutors) {
    if (!exec) continue;
    for (const pos of exec.getStatus().openPositions) {
      if (pos.exitOrderId !== null) continue;
      net.set(pos.symbol, (net.get(pos.symbol) ?? 0) + (pos.direction === "LONG" ? pos.qty : -pos.qty));
    }
  }
  return net;
}

/**
 * Sums CURRENT notional (USD, qty*entryPrice, UNSIGNED — same-direction stacking is exactly what
 * this exists to catch, so long+long must ADD not cancel) per symbol across the given
 * single-symbol executors' OPEN positions (a leg with exitOrderId already set is excluded — its
 * exit is already in flight, no longer a live claim on the symbol).
 *
 * 2026-07-09 audit finding: independently-admitted SingleSymbolLaneExecutor instances (now 7 live:
 * SHORT_FADE_EXHAUSTION, INTRADAY_MOMENTUM_BREAKOUT, REGIME_COMPOSITE_CONFIRMATION_LONG, and
 * COMPOSITE_ESTIMATOR_BIDI's 4 buckets) each size a fresh entry purely from their OWN legUsd, with
 * zero awareness of what OTHER lanes already committed to the same symbol — confirmed live,
 * REGIME_COMPOSITE_CONFIRMATION_LONG and COMPOSITE_ESTIMATOR_BIDI_WIDE_LONG/FAST_LONG all went
 * LONG on the same BTC/ETH/SOL universe simultaneously. live-execution-engine.ts's own
 * correlated-alt/cluster caps don't help here — those only see the "intents" mirror pipeline, never
 * imported by this executor class. Caller passes the RESULT of this (excluding the querying
 * instance's own positions — see SingleSymbolLaneExecutorOptions.existingNotionalForSymbol's doc
 * comment) into each executor's admission gate.
 *
 * 2026-07-19 real-money audit fix: `crossSectionalExecutors` (optional, defaults to `[]` — every
 * pre-existing caller that only ever passed the single-symbol array is byte-for-byte unaffected)
 * folds in the 3 CrossSectionalExecutor instances' (MARKET_NEUTRAL/TREND/MIXED) own open
 * (un-exited) basket legs on the same symbol. Before this, the 9 single-symbol lanes and the 3
 * cross-sectional baskets shared ONE netted Binance account with ZERO mutual visibility into each
 * other's same-symbol exposure — only same-class stacking (single-symbol vs single-symbol) was
 * capped. CROSS_SECTIONAL_MARKET_NEUTRAL's own long/short allowlists include ETHUSDT/SOLUSDT,
 * exactly 2 of the 3 symbols the real-money-active RC/CE-WIDE_LONG/CE-FAST_LONG lanes trade — a
 * basket leg opening alongside those lanes' existing exposure was invisible to this cap until now.
 */
export function computeNotionalPerSymbol(
  singleSymbolExecutors: ReadonlyArray<SingleSymbolLaneExecutor | null>,
  crossSectionalExecutors: ReadonlyArray<CrossSectionalExecutor | null> = [],
): Map<string, number> {
  const notional = new Map<string, number>();
  for (const exec of singleSymbolExecutors) {
    if (!exec) continue;
    for (const pos of exec.getStatus().openPositions) {
      if (pos.exitOrderId !== null) continue;
      notional.set(pos.symbol, (notional.get(pos.symbol) ?? 0) + Math.abs(pos.qty * pos.entryPrice));
    }
  }
  for (const exec of crossSectionalExecutors) {
    if (!exec) continue;
    for (const basket of exec.getStatus().openBaskets) {
      for (const leg of basket.legs) {
        if (leg.exitOrderId !== null) continue;
        notional.set(leg.symbol, (notional.get(leg.symbol) ?? 0) + Math.abs(leg.qty * leg.entryPrice));
      }
    }
    // 2026-07-19 real-money audit follow-up: an orphaned leg is real, still-open notional on the
    // exchange (see computeExternalManagedNetQty's identical addition above for the full
    // rationale) — without this, a fresh basket or single-symbol lane could stack additional real
    // exposure on a symbol that already carries unresolved orphaned exposure, exactly what this
    // cap exists to prevent.
    for (const orphan of exec.getStatus().orphanedLegs) {
      notional.set(orphan.symbol, (notional.get(orphan.symbol) ?? 0) + Math.abs(orphan.qty * orphan.entryPrice));
    }
  }
  return notional;
}

/**
 * Sums realized P&L (today + all-time) across every cross-sectional + single-symbol executor
 * instance — the ONE place this aggregation should live, consumed by everything that needs "real
 * P&L from lanes outside the engine's own mirror/directional ledger": the dashboard headline
 * (routes/live.ts's /api/live/account), the global kill-switch (killSwitchTrip), and the wallet-
 * reconciliation report. Before 2026-07-11 each of those had either no such figure at all or its
 * own separate, incomplete summing — the kill-switch and wallet-reconciliation genuinely could
 * never see these 11 executors' real losses/gains, only the dashboard headline had a (correct but
 * now-duplicated) version of this exact loop.
 *
 * IMPORTANT — this function's own 2 parameters are NOT the only place a new executor must be
 * registered. app.ts previously had THREE separate hand-duplicated literal arrays of the same 11
 * executors (one each for this function, computeExternalManagedNetQty, and the per-symbol
 * notional-cap closure `allSingleSymbolLaneExecutors`) — a 12th executor added to only 2 of the 3
 * would silently reopen the 2026-07-09 concentration-cap incident computeNotionalPerSymbol's doc
 * comment describes. Fixed 2026-07-11: app.ts now defines ONE shared pair of closures
 * (allCrossSectionalLaneExecutors/allSingleSymbolLaneExecutors, right above `allSingleSymbolLaneExecutors`
 * in that file) and passes them to every one of these consumers, so a new executor really only needs
 * adding in that one place in app.ts — not "the two arrays passed in here."
 */
export function sumExternalRealizedPnlUsd(
  crossSectionalExecutors: ReadonlyArray<CrossSectionalExecutor | null>,
  singleSymbolExecutors: ReadonlyArray<SingleSymbolLaneExecutor | null>,
): { today: number; allTime: number } {
  let today = 0;
  let allTime = 0;
  for (const exec of [...crossSectionalExecutors, ...singleSymbolExecutors]) {
    if (!exec) continue;
    const status = exec.getStatus();
    today += status.dailyRealizedUsd;
    allTime += status.totalNetPnlUsd;
  }
  return { today, allTime };
}

/** Fee estimates/actual fees attached only to external positions CLOSED on the requested UTC day.
 * Open-entry commissions must not be mixed into a closed-realized reconciliation comparison. */
export function sumExternalClosedFeesUsd(
  crossSectionalExecutors: ReadonlyArray<CrossSectionalExecutor | null>,
  singleSymbolExecutors: ReadonlyArray<SingleSymbolLaneExecutor | null>,
  dayUtc = new Date().toISOString().slice(0, 10),
): number {
  let fees = 0;
  for (const exec of crossSectionalExecutors) {
    if (!exec) continue;
    for (const basket of exec.getClosedBaskets()) {
      if (basket.closedAt?.startsWith(dayUtc)) fees += basket.feeEstimateUsd ?? 0;
    }
  }
  for (const exec of singleSymbolExecutors) {
    if (!exec) continue;
    for (const position of exec.getClosedPositions()) {
      if (position.closedAt?.startsWith(dayUtc)) fees += position.feeEstimateUsd ?? 0;
    }
  }
  return fees;
}

/** 2026-07-09 fix: shared default ceiling for computeNotionalPerSymbol-based admission gates.
 *  250 permits the two legitimate lanes already stacking on one symbol today (up to ~$150 WIDE +
 *  ~$91 REGIME_COMPOSITE per symbol, observed live) while stopping a 3rd/4th lane from piling on
 *  further once that's already committed. Env-overridable, matching every other risk constant in
 *  this codebase. */
export function maxNotionalPerSymbolAcrossLanes(): number {
  const n = Number.parseFloat(process.env.LIVE_MAX_NOTIONAL_PER_SYMBOL_ACROSS_LANES ?? "");
  return Number.isFinite(n) && n > 0 ? n : 250;
}

/**
 * Open-position SYMBOLS per correlation cluster × direction, combining the legacy
 * CG_*-variant-matrix mirror's own open intents with every cross-sectional + single-symbol
 * executor instance's open legs/positions. Reuses the SAME clusterOf()/isMajorSymbol() grouping
 * live-execution-engine.ts's own per-cluster cap already uses (see correlation-clusters.ts) — this
 * does NOT invent a new correlation model, it only extends the existing one's reach.
 *
 * 2026-07-19 real-money audit fix (confirmed finding, not re-investigated here): the mirror's
 * per-cluster cap (LiveExecutionEngine.clusterOpenCounts/maxClusterPositions — the SUI/ADA/AVAX
 * dump-together incident it exists to prevent, see correlation-clusters.ts's header comment) only
 * ever counted the mirror's OWN open intents. It had ZERO visibility into any of the 9
 * independently-admitted SingleSymbolLaneExecutor instances — exactly the same blind spot
 * computeNotionalPerSymbol's doc comment describes for the flat per-symbol cap. Two of those 9
 * lanes sit at 0% allocation weight today specifically BECAUSE they trade correlated-alt universes
 * (SHORT_FADE_EXHAUSTION_CROWDED: a LINK/SEI/BNB/SOL-style universe; INTRADAY_MOMENTUM_BREAKOUT_LONG:
 * the entire scanner universe, which can include a correlated cluster) with no such protection wired
 * in. This closes that gap so the cap applies uniformly the moment either lane is ever turned on —
 * with SF/IM at 0% weight and thus 0 open positions today, this is a no-op in practice right now.
 *
 * MAJORS (BTC/ETH) are excluded from every returned set, matching the mirror's own exemption.
 *
 * `legacyMirrorOpenIntents` is the mirror's OWN open-intent symbols/directions — pass
 * `engine.getStatus().openIntents` (LiveExecutionEngine's private per-cluster bookkeeping is not
 * reusable from outside the class, so this is reconstructed from its public status projection).
 */
export function computeClusterOpenSymbols(
  legacyMirrorOpenIntents: ReadonlyArray<{ symbol: string; direction: "LONG" | "SHORT" }>,
  crossSectionalExecutors: ReadonlyArray<CrossSectionalExecutor | null>,
  singleSymbolExecutors: ReadonlyArray<SingleSymbolLaneExecutor | null>,
): Map<string, Set<string>> {
  const byKey = new Map<string, Set<string>>();
  const add = (symbol: string, direction: "LONG" | "SHORT") => {
    if (isMajorSymbol(symbol)) return;
    const key = `${clusterOf(symbol)}:${direction}`;
    const set = byKey.get(key);
    const upper = symbol.toUpperCase();
    if (set) set.add(upper);
    else byKey.set(key, new Set([upper]));
  };
  for (const intent of legacyMirrorOpenIntents) add(intent.symbol, intent.direction);
  for (const exec of crossSectionalExecutors) {
    if (!exec) continue;
    for (const basket of exec.getStatus().openBaskets) {
      for (const leg of basket.legs) {
        if (leg.exitOrderId !== null) continue;
        add(leg.symbol, leg.side);
      }
    }
    // 2026-07-19 real-money audit follow-up: an orphaned leg is a real, still-open position in
    // its cluster exactly like an open basket leg (see computeExternalManagedNetQty's identical
    // addition above for the full rationale) — omitting it here would let the correlated-cluster
    // cap undercount real exposure while an orphan is unresolved.
    for (const orphan of exec.getStatus().orphanedLegs) {
      add(orphan.symbol, orphan.side);
    }
  }
  for (const exec of singleSymbolExecutors) {
    if (!exec) continue;
    for (const pos of exec.getStatus().openPositions) {
      if (pos.exitOrderId !== null) continue;
      add(pos.symbol, pos.direction);
    }
  }
  return byKey;
}

/** Shared default cap for computeClusterOpenSymbols-based admission gates, mirroring
 *  live-execution-engine.ts's own maxClusterPositions default (env LIVE_MAX_CLUSTER_POSITIONS,
 *  default 3 — see LiveExecutionConfig.maxClusterPositions). Callers that have a live engine
 *  reference should prefer reading `engine.getStatus().limits.maxClusterPositions` directly (the
 *  engine's own live-configured value, guaranteed identical to what its OWN cap enforces) — this
 *  export exists only as a safe, independently-testable fallback for callers with no engine
 *  reference (e.g. a disarmed/absent engine, or a unit test). */
export function maxClusterPositionsAcrossLanes(): number {
  const raw = process.env.LIVE_MAX_CLUSTER_POSITIONS;
  const n = raw === undefined ? NaN : Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}
