/**
 * ACCOUNT EXPOSURE COORDINATOR — the shared reserve-then-commit-then-release capacity ledger for
 * every SingleSymbolLaneExecutor / CrossSectionalExecutor real exchange-entry path (mainnet AND
 * innovation-testnet lanes alike).
 *
 * THE RACE THIS CLOSES (confirmed by direct code audit, see task ground truth): today, sizing never
 * shrinks against other lanes' exposure (existingNotionalForSymbol/existingClusterOpenSymbols are
 * consulted only as allow-or-skip-the-whole-entry ADMISSION gates, never inside sizing itself),
 * nothing sums gross/directional/total-concurrent exposure across all ~19 SingleSymbolLaneExecutor +
 * 6 CrossSectionalExecutor instances simultaneously, and order placement is always a single direct
 * `await client.placeOrder(...)` with no reserve/commit/release protocol — so two lanes admitted in
 * the SAME event-loop turn (both having read the same stale getPositions()/getStatus() snapshot
 * before either one's `await` resolves) can both proceed, and a process crash between persisting an
 * "attempted" watermark and the order actually reaching Binance leaves that signal permanently
 * un-retried regardless of whether the order filled.
 *
 * WHY reserve()/commitReservation()/releaseReservation() ARE SAFE WITHOUT A LOCK LIBRARY: all three
 * are 100% synchronous — zero `await`, zero I/O-that-yields inside the capacity check + ledger
 * mutation. Node only preempts at `await` points, so a synchronous function is atomic against every
 * OTHER synchronous call already queued on the same event loop: "check capacity, then insert the
 * reservation" is one indivisible unit. Persistence (writeFileSync + renameSync) is the same
 * synchronous-disk-I/O idiom SingleSymbolLaneExecutorStore/CrossSectionalExecutorStore already use on
 * every position/basket mutation, so this does not introduce a new I/O category, only one more write
 * of the same kind already happening on these hot paths.
 *
 * WHAT THIS IS NOT: not a P2 Execution Authority redesign, not a new sizing formula, not a change to
 * any strategy/entry-signal logic. It is the smallest shared coordinator that lets every entry path
 * reserve capacity BEFORE placing an order, commit the reservation from the ACTUAL fill (never the
 * requested qty) once one lands, and release it on rejection/timeout/cancellation/failure — with a
 * restart-safe reconciliation sweep for the one case neither "commit" nor "release" can resolve on
 * their own: a reservation whose owning process died mid-order.
 *
 * STAGE 1 OF 2 (this file): the coordinator module alone — the reservation type, its persisted
 * ledger store, reserve/commitReservation/releaseReservation, every capacity axis (gross,
 * directional LONG/SHORT, per-symbol, correlation-cluster, concurrent-position-count), the
 * manual/external-position visibility mechanism, and restart/staleness reconciliation. Both this
 * module AND its app.ts / SingleSymbolLaneExecutor / CrossSectionalExecutor wiring (formerly
 * "stage 2") are complete and live — see app.ts's own "new AccountExposureCoordinator(...)"
 * construction and this file's reserve/commitReservation/releaseReservation call sites inside
 * single-symbol-lane-executor.ts and cross-sectional-executor.ts. Every accessor this class
 * depends on is an injected closure so it is fully unit-testable in isolation, matching the exact
 * optional-closure-with-safe-default convention every executor option in this codebase already
 * follows (see e.g. SingleSymbolLaneExecutorOptions.existingNotionalForSymbol).
 *
 * WHERE THE NUMBERS COME FROM (five underlying sources, S1-S5 — referenced by short name in the
 * per-axis comments below so the same explanation is not repeated five times):
 *   S1 — every SingleSymbolLaneExecutor's getStatus().openPositions where exitOrderId===null.
 *   S2 — every CrossSectionalExecutor's getStatus().openBaskets legs where exitOrderId===null, PLUS
 *        getStatus().orphanedLegs (a real, still-open exchange position a basket's own bookkeeping
 *        can no longer reach — see cross-sectional-executor.ts's OrphanedLeg doc comment; omitting
 *        it would let a cap silently undercount real exposure while an orphan is unresolved).
 *   S3 — the legacy CG_*-variant-matrix mirror's own open intents (LiveExecutionEngine.getStatus()
 *        .openIntents), read via an injected closure — this module never imports
 *        live-execution-engine.ts itself (that file is 6800+ lines and this coordinator needs only
 *        the tiny public status projection).
 *   S4 — manual/external exchange exposure: a symbol's real positionAmt minus whatever S1+S2 already
 *        claim on it (computeExternalManagedNetQty, reused verbatim from live-executor-wiring.ts —
 *        the SAME subtraction LiveExecutionEngine.reconcile() already performs).
 *   S5 — this coordinator's OWN in-flight reservations (status==="RESERVED") — a concept nothing in
 *        this codebase tracked before this file existed.
 *
 * Per-symbol and correlation-cluster exposure reuse the EXISTING, already-tested
 * computeNotionalPerSymbol/computeClusterOpenSymbols (live-executor-wiring.ts) as their S1(+S2[+S3
 * for cluster]) base and fold the rest on top — a strict superset, not a reimplementation, so the
 * proven parts of those functions are never duplicated or allowed to drift. Gross/directional/
 * concurrent-count exposure are NEW axes (nothing sums these today) and are computed directly over
 * S1-S5 in one pass (buildSnapshot()) inside this file.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { BinanceFuturesPrivateError, type FuturesOrder, type FuturesPosition } from "./binance-futures-private.js";
import { clusterOf, isMajorSymbol } from "./correlation-clusters.js";
import type { CrossSectionalExecutor } from "./cross-sectional-executor.js";
import {
  computeClusterOpenSymbols,
  computeExternalManagedNetQty,
  computeNotionalPerSymbol,
  maxClusterPositionsAcrossLanes,
  maxNotionalPerSymbolAcrossLanes,
} from "./live-executor-wiring.js";
import type { SingleSymbolLaneExecutor } from "./single-symbol-lane-executor.js";

// ─── env-configured caps / timings ──────────────────────────────────────────

/** NEW axis — nothing sums total gross exposure across every lane today. Default 0 = DISABLED: no
 *  live-account figure was available at design time to pick a safe nonzero ceiling, and shipping a
 *  guessed number on a real-money account is worse than shipping it off. Per-symbol/cluster below
 *  reuse EXISTING nonzero defaults unchanged, so baseline protection is active from day one
 *  regardless of whether an operator ever sets this one. */
export function maxGrossExposureUsd(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseFloat(env.LIVE_MAX_GROSS_EXPOSURE_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
}
/** NEW axis, same disabled-by-default rationale as maxGrossExposureUsd. */
export function maxLongExposureUsd(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseFloat(env.LIVE_MAX_LONG_EXPOSURE_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
}
/** NEW axis, same disabled-by-default rationale as maxGrossExposureUsd. */
export function maxShortExposureUsd(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseFloat(env.LIVE_MAX_SHORT_EXPOSURE_USD ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
}
/** NEW axis — LiveExecutionEngine.config.maxConcurrentPositions (default 3) only ever counts the
 *  legacy mirror's OWN st.intents; nothing sums a TRUE account-wide concurrent-position count across
 *  every SingleSymbolLaneExecutor + CrossSectionalExecutor + the mirror simultaneously. Default 0 =
 *  disabled, same rationale as the other new axes above. */
export function maxConcurrentPositionsAcrossAccount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LIVE_MAX_CONCURRENT_POSITIONS_ACROSS_ACCOUNT;
  const n = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** How long a RESERVED row may sit un-resolved before it is treated as evidence of a stuck/crashed
 *  attempt worth investigating via queryOrderByClientId. Derivation (see reconcileStaleReservations'
 *  doc comment): REQUEST_TIMEOUT_MS (6000ms, binance-futures-private.ts) + up to ~1600ms of
 *  resolveConfirmedFillPrice's own confirm-retry loop (4 retries x 400ms default) + generous margin
 *  for disk I/O / scheduling jitter. In healthy operation a RESERVED row ALWAYS flips to
 *  COMMITTED/RELEASED well inside this window, so anything still RESERVED past it is, by
 *  construction, a stuck reservation — whether discovered at cold start (the owning process is
 *  necessarily dead) or mid-session (belt-and-suspenders for a bug that leaks a reservation without a
 *  crash). */
export function reservationStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseFloat(env.LIVE_RESERVATION_STALE_MS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}
/** Stage-2 convenience constant: how often app.ts should re-run the sweep via setInterval (gated
 *  `if (!isTest)`, matching every other interval in that file). Not consulted anywhere in this file
 *  itself — this module never starts its own timer, matching this codebase's convention that all
 *  interval scheduling lives in app.ts. */
export function reservationReconcileIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseFloat(env.LIVE_RESERVATION_RECONCILE_INTERVAL_MS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}
/** Same shape as SingleSymbolLaneExecutorStore's MAX_STORED_POSITIONS: RESERVED rows are always kept
 *  (should be near-empty in healthy operation), COMMITTED/RELEASED rows are capped to the newest N
 *  by createdAt — an audit trail, not a growing-forever log. */
function MAX_STORED_RESERVATIONS(): number {
  return Math.max(1, Math.floor(Number(process.env.ACCOUNT_EXPOSURE_MAX_STORED_RESERVATIONS) || 2000));
}

// ─── reservation record ──────────────────────────────────────────────────────

export type ReservationStatus = "RESERVED" | "COMMITTED" | "RELEASED";

export interface ExposureReservation {
  /** crypto.randomUUID() — synchronous in Node, no new dependency. */
  reservationId: string;
  /** The requesting lane's laneId — both executor classes already expose this via opts.laneId. */
  executorId: string;
  kind: "SINGLE_SYMBOL" | "CROSS_SECTIONAL_LEG";
  /** CrossSectionalExecutor only — groups one basket attempt's sibling leg reservations. */
  basketId?: string;
  symbol: string;
  /** For a CROSS_SECTIONAL_LEG this is leg.side, NOT a whole-basket direction — a basket is
   *  two-sided, so each leg's reservation carries its own leg's direction. */
  direction: "LONG" | "SHORT";
  /** clusterOf(symbol), computed INSIDE reserve() — callers never import correlation-clusters.ts. */
  clusterKey: string;
  /** NOT knowable synchronously at reserve() time (ExposureReserveRequest carries USD notional
   *  only — the real qty depends on exchange stepSize filters, fetched later, asynchronously, by the
   *  caller's own sizing code). Always 0 at insert; kept only for the same "requested vs actual"
   *  audit-pair shape committedQty completes once a fill lands (mirroring LiveIntent's
   *  requiredNotionalUsd/appliedNotionalUsd convention) — never itself the input to any capacity
   *  formula (requestedNotionalUsd is). */
  requestedQty: number;
  requestedNotionalUsd: number;
  /** MUST equal the exact newClientOrderId the caller is about to send to placeOrder — the
   *  reconciliation join key (queryOrderByClientId looks orders up by this exact string). */
  clientOrderId: string;
  createdAt: string;
  /** Epoch ms mirror of createdAt, avoids re-parsing ISO on every staleness check. */
  createdAtMs: number;
  status: ReservationStatus;
  /** Set ONLY by commitReservation(), from the ACTUAL executedQty — never requestedQty. */
  committedQty?: number;
  /** committedQty * the actual avgPrice Binance confirmed. */
  committedNotionalUsd?: number;
  committedAt?: string;
  releasedAt?: string;
  /** e.g. "ENTRY_FAILED:<message>", "FRESH_POSITION_EXISTS", "RECONCILED_NOT_FILLED",
   *  "RECONCILED_NEVER_REACHED_EXCHANGE". */
  releaseReason?: string;
}

export interface ExposureReserveRequest {
  executorId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  requestedNotionalUsd: number;
  clientOrderId: string;
  /** Present only for a CrossSectionalExecutor leg reservation. */
  basketId?: string;
}

export interface ExposureReserveResult {
  ok: boolean;
  reservationId: string | null;
  reason?: string;
}

/** The mirror's own open-intent shape this coordinator needs — deliberately NOT importing
 *  live-execution-engine.ts (6800+ lines) for one tiny status projection. Matches exactly what
 *  LiveExecutionEngine.getStatus().openIntents already emits (symbol/direction/requiredNotionalUsd/
 *  appliedNotionalUsd — verified against that method's own mapping). Structurally compatible with
 *  live-executor-wiring.ts's computeClusterOpenSymbols, which only needs {symbol, direction}. */
export interface LegacyMirrorOpenIntent {
  symbol: string;
  direction: "LONG" | "SHORT";
  requiredNotionalUsd?: number | null;
  appliedNotionalUsd?: number | null;
}

export interface ReconcileSweepResult {
  /** Stale RESERVED rows examined this sweep (rows younger than reservationStaleMs are left alone —
   *  they are not ambiguous about whether they should occupy capacity, only whether it is yet worth
   *  an API call to investigate). */
  checked: number;
  committed: number;
  released: number;
  /** Left RESERVED, retried next sweep — either no queryOrderByClientId was wired, the query itself
   *  failed for a reason other than "order never existed", or the order's status was genuinely
   *  ambiguous (still resting / unrecognized). Capacity stays conservatively occupied — this is the
   *  literal implementation of "survive/reconcile restart without silently losing pending exposure". */
  inconclusive: number;
}

// ─── persisted ledger store ──────────────────────────────────────────────────

interface AccountExposureReservationState {
  version: number;
  reservations: ExposureReservation[];
}

/**
 * Persistence discipline mirrors SingleSymbolLaneExecutorStore/CrossSectionalExecutorStore exactly:
 * best-effort mkdirSync, corrupt-or-missing-on-load degrades to a fresh empty state (never throws —
 * reservations reconcile against the exchange on next sweep, same posture as those stores' own
 * "positions reconcile against the exchange on next tick"), and save() is tmp-file-write +
 * renameSync so a crash mid-write can never truncate/corrupt the live file.
 *
 * dataDir has NO default (unlike CrossSectionalExecutorStore's dataDir="data") — a bare
 * `new AccountExposureReservationStore()` must not be constructible in a way that could silently
 * write into the repo's real `data/` directory from a test that forgot to pass a tmpdir.
 */
export class AccountExposureReservationStore {
  private readonly file: string;
  private state: AccountExposureReservationState;

  constructor(dataDir: string, fileName = "account-exposure-reservations.json") {
    this.file = resolve(dataDir, fileName);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch {
      // best-effort
    }
    this.state = this._load();
  }

  private _load(): AccountExposureReservationState {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8"));
        if (parsed && Array.isArray(parsed.reservations)) {
          return parsed as AccountExposureReservationState;
        }
      }
    } catch {
      // corrupt → fresh (reservations reconcile against the exchange on next sweep)
    }
    return { version: 1, reservations: [] };
  }

  getState(): AccountExposureReservationState {
    return this.state;
  }

  private prune(): void {
    const max = MAX_STORED_RESERVATIONS();
    if (this.state.reservations.length <= max) return;
    const reserved = this.state.reservations.filter((r) => r.status === "RESERVED");
    const settled = this.state.reservations
      .filter((r) => r.status !== "RESERVED")
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, Math.max(0, max - reserved.length));
    this.state.reservations = [...reserved, ...settled];
  }

  save(): void {
    try {
      this.prune();
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), "utf-8");
      renameSync(tmp, this.file);
    } catch {
      // never let a persistence failure break the tick
    }
  }
}

// ─── coordinator ─────────────────────────────────────────────────────────────

/** One pass over S1-S5 — see this file's header comment for what each source is. Computed fresh on
 *  every reserve() call (cheap: plain in-memory array walks, no I/O) so "check capacity, then insert"
 *  never reads a stale snapshot from a previous call. */
interface ExposureSnapshot {
  grossUsd: number;
  longUsd: number;
  shortUsd: number;
  /** Superset of computeNotionalPerSymbol's own S1+S2 map, with S3/S4/S5 folded in on top. */
  perSymbolUsd: Map<string, number>;
  /** Superset of computeClusterOpenSymbols's own S1+S2+S3 map (keyed `${clusterOf}:${direction}`),
   *  with S4/S5 folded in on top. */
  clusterOpenSymbols: Map<string, Set<string>>;
  concurrentCount: number;
}

export interface AccountExposureCoordinatorOptions {
  store: AccountExposureReservationStore;
  /** Same closures app.ts's allSingleSymbolLaneExecutors()/allCrossSectionalLaneExecutors() already
   *  are — required (not optional-with-empty-default) because they are this class's entire reason
   *  to exist; an accidentally-omitted accessor here would silently blind every capacity axis to
   *  S1/S2, a far larger gap than any individual executor's own optional injected closure. */
  getSingleSymbolExecutors: () => ReadonlyArray<SingleSymbolLaneExecutor | null>;
  getCrossSectionalExecutors: () => ReadonlyArray<CrossSectionalExecutor | null>;
  /** Optional, defaults to () => [] — the legacy mirror may not exist in every deployment
   *  (research/testnet configurations). Omitting it does not regress today's behavior: today's
   *  computeNotionalPerSymbol is ALREADY blind to the mirror's own open intents (a confirmed,
   *  pre-existing asymmetry vs. computeClusterOpenSymbols) — wiring this only improves visibility,
   *  never removes it. */
  getLegacyMirrorOpenIntents?: () => ReadonlyArray<LegacyMirrorOpenIntent>;
  nowIso?: () => string;
  maxGrossExposureUsd?: () => number;
  maxLongExposureUsd?: () => number;
  maxShortExposureUsd?: () => number;
  /** Defaults to maxNotionalPerSymbolAcrossLanes() (live-executor-wiring.ts) — the EXISTING nonzero
   *  default ($250), unchanged. */
  maxNotionalPerSymbolUsd?: () => number;
  /** Defaults to maxClusterPositionsAcrossLanes() (live-executor-wiring.ts) — the EXISTING nonzero
   *  default (3), unchanged. */
  maxClusterPositions?: () => number;
  maxConcurrentPositionsAcrossAccount?: () => number;
  reservationStaleMs?: () => number;
  /** Wired to liveClient.queryOrderByClientId.bind(liveClient) in stage 2. Optional: omit and every
   *  stale reservation is reported inconclusive (left RESERVED) rather than reconciled — never
   *  silently dropped. */
  queryOrderByClientId?: (symbol: string, origClientOrderId: string) => Promise<FuturesOrder>;
}

export class AccountExposureCoordinator {
  private readonly store: AccountExposureReservationStore;
  private readonly getSingleSymbolExecutors: () => ReadonlyArray<SingleSymbolLaneExecutor | null>;
  private readonly getCrossSectionalExecutors: () => ReadonlyArray<CrossSectionalExecutor | null>;
  private readonly getLegacyMirrorOpenIntents: () => ReadonlyArray<LegacyMirrorOpenIntent>;
  private readonly nowIsoFn: () => string;
  private readonly maxGrossExposureUsdFn: () => number;
  private readonly maxLongExposureUsdFn: () => number;
  private readonly maxShortExposureUsdFn: () => number;
  private readonly maxNotionalPerSymbolUsdFn: () => number;
  private readonly maxClusterPositionsFn: () => number;
  private readonly maxConcurrentPositionsAcrossAccountFn: () => number;
  private readonly reservationStaleMsFn: () => number;
  private readonly queryOrderByClientIdFn: ((symbol: string, origClientOrderId: string) => Promise<FuturesOrder>) | null;

  /** Synchronously-held last-known account-wide position snapshot — see updatePositionSnapshot()'s
   *  doc comment. Empty until the caller wires it; an empty snapshot means manual-position exposure
   *  is simply invisible (same conservative degrade-to-today's-behavior posture as every other
   *  optional closure in this codebase), never fabricated. */
  private positionSnapshot: Map<string, FuturesPosition> = new Map();
  private positionSnapshotAtMs: number | null = null;

  /** Bounded ring buffer of reconciliation-sweep narration, same idiom as
   *  LiveExecutionEngine.reconcileIssues — report-only, never consulted by any capacity decision. */
  private reconcileLog: string[] = [];

  constructor(opts: AccountExposureCoordinatorOptions) {
    this.store = opts.store;
    this.getSingleSymbolExecutors = opts.getSingleSymbolExecutors;
    this.getCrossSectionalExecutors = opts.getCrossSectionalExecutors;
    this.getLegacyMirrorOpenIntents = opts.getLegacyMirrorOpenIntents ?? (() => []);
    this.nowIsoFn = opts.nowIso ?? (() => new Date().toISOString());
    this.maxGrossExposureUsdFn = opts.maxGrossExposureUsd ?? maxGrossExposureUsd;
    this.maxLongExposureUsdFn = opts.maxLongExposureUsd ?? maxLongExposureUsd;
    this.maxShortExposureUsdFn = opts.maxShortExposureUsd ?? maxShortExposureUsd;
    this.maxNotionalPerSymbolUsdFn = opts.maxNotionalPerSymbolUsd ?? maxNotionalPerSymbolAcrossLanes;
    this.maxClusterPositionsFn = opts.maxClusterPositions ?? maxClusterPositionsAcrossLanes;
    this.maxConcurrentPositionsAcrossAccountFn =
      opts.maxConcurrentPositionsAcrossAccount ?? maxConcurrentPositionsAcrossAccount;
    this.reservationStaleMsFn = opts.reservationStaleMs ?? reservationStaleMs;
    this.queryOrderByClientIdFn = opts.queryOrderByClientId ?? null;
  }

  /** Epoch ms off the SAME injected clock every timestamp in this class uses, matching
   *  SingleSymbolLaneExecutor's own nowMs() — falls back to Date.now() only if a caller supplied a
   *  clock producing an unparseable string, never NaN. */
  private nowMs(): number {
    const ms = new Date(this.nowIsoFn()).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }

  private logReconcileIssue(message: string): void {
    console.error(`[account-exposure-coordinator] ${message}`);
    this.reconcileLog.push(message);
    if (this.reconcileLog.length > 200) this.reconcileLog = this.reconcileLog.slice(-200);
  }

  /**
   * Best-effort, ZERO-new-Binance-call manual-position feed. Stage 2 attaches this to the SAME
   * promise app.ts's existing ensureCachedPositions()/sharedGetPositions() cache already creates
   * (`.then(positions => coordinator.updatePositionSnapshot(positions)).catch(()=>{})`) — since ~25
   * executor instances already call sharedGetPositions() every tick, this refreshes at least once
   * per that existing ~30s cache window automatically. Synchronous, no I/O: just replaces the
   * in-memory map.
   */
  updatePositionSnapshot(positions: ReadonlyArray<FuturesPosition>): void {
    const next = new Map<string, FuturesPosition>();
    for (const p of positions) next.set(p.symbol, p);
    this.positionSnapshot = next;
    this.positionSnapshotAtMs = this.nowMs();
  }

  /**
   * One synchronous pass over S1-S5. Reuses computeNotionalPerSymbol/computeClusterOpenSymbols
   * (live-executor-wiring.ts) verbatim as the S1(+S2[+S3]) base for the per-symbol/cluster maps —
   * per this file's header comment, a strict superset, not a reimplementation — and walks S1-S5
   * itself for the two NEW axes (gross/directional totals, concurrent-position count) nothing in
   * this codebase sums today.
   */
  private buildSnapshot(): ExposureSnapshot {
    const singleSymbolExecutors = this.getSingleSymbolExecutors();
    const crossSectionalExecutors = this.getCrossSectionalExecutors();
    const legacyIntents = this.getLegacyMirrorOpenIntents();

    // Base per-symbol map: S1+S2 (existing, proven helper — reused verbatim).
    const perSymbolUsd = computeNotionalPerSymbol(singleSymbolExecutors, crossSectionalExecutors);
    // Base cluster map: S1+S2+S3 (existing, proven helper — already takes legacyMirrorOpenIntents).
    const baseClusterOpen = computeClusterOpenSymbols(legacyIntents, crossSectionalExecutors, singleSymbolExecutors);
    // Defensive copy: never mutate whatever the helper handed back.
    const clusterOpenSymbols = new Map<string, Set<string>>();
    for (const [key, symbols] of baseClusterOpen) clusterOpenSymbols.set(key, new Set(symbols));

    const addPerSymbol = (symbol: string, usd: number): void => {
      perSymbolUsd.set(symbol, (perSymbolUsd.get(symbol) ?? 0) + usd);
    };
    const addCluster = (symbol: string, direction: "LONG" | "SHORT"): void => {
      if (isMajorSymbol(symbol)) return;
      const key = `${clusterOf(symbol)}:${direction}`;
      const upper = symbol.toUpperCase();
      const set = clusterOpenSymbols.get(key);
      if (set) set.add(upper);
      else clusterOpenSymbols.set(key, new Set([upper]));
    };

    let grossUsd = 0;
    let longUsd = 0;
    let shortUsd = 0;
    let concurrentCount = 0;
    // Symbols already claimed by S1/S2/S3 — used ONLY to decide whether a manual (S4) position
    // should add a fresh +1 to concurrentCount (see the design's own "count(S4 manual symbols not
    // already claimed by S1-S3)" formula: a manual remainder on a symbol an executor already claims
    // is additional NOTIONAL, but not an additional POSITION SLOT).
    const claimedSymbols = new Set<string>();

    // S1 — SingleSymbolLaneExecutor open positions.
    for (const exec of singleSymbolExecutors) {
      if (!exec) continue;
      for (const pos of exec.getStatus().openPositions) {
        if (pos.exitOrderId !== null) continue;
        claimedSymbols.add(pos.symbol);
        const usd = Math.abs(pos.qty * pos.entryPrice);
        grossUsd += usd;
        if (pos.direction === "LONG") longUsd += usd;
        else shortUsd += usd;
        concurrentCount += 1;
      }
    }
    // S2 — CrossSectionalExecutor open basket legs + orphaned legs.
    for (const exec of crossSectionalExecutors) {
      if (!exec) continue;
      for (const basket of exec.getStatus().openBaskets) {
        for (const leg of basket.legs) {
          if (leg.exitOrderId !== null) continue;
          claimedSymbols.add(leg.symbol);
          const usd = Math.abs(leg.qty * leg.entryPrice);
          grossUsd += usd;
          if (leg.side === "LONG") longUsd += usd;
          else shortUsd += usd;
          concurrentCount += 1;
        }
      }
      for (const orphan of exec.getStatus().orphanedLegs) {
        claimedSymbols.add(orphan.symbol);
        const usd = Math.abs(orphan.qty * orphan.entryPrice);
        grossUsd += usd;
        if (orphan.side === "LONG") longUsd += usd;
        else shortUsd += usd;
        concurrentCount += 1;
      }
    }
    // S3 — legacy mirror open intents. NOT already in perSymbolUsd's base (computeNotionalPerSymbol
    // has no legacyMirrorOpenIntents parameter — a confirmed, pre-existing asymmetry vs.
    // computeClusterOpenSymbols, which already folds these in). addCluster() below is therefore a
    // harmless Set-dedup no-op for cluster purposes (already included via baseClusterOpen) but a
    // REQUIRED addition for perSymbolUsd.
    for (const intent of legacyIntents) {
      claimedSymbols.add(intent.symbol);
      const usd = Math.abs(intent.appliedNotionalUsd ?? intent.requiredNotionalUsd ?? 0);
      grossUsd += usd;
      if (intent.direction === "LONG") longUsd += usd;
      else shortUsd += usd;
      addPerSymbol(intent.symbol, usd);
      addCluster(intent.symbol, intent.direction);
      concurrentCount += 1;
    }
    // S4 — manual/external exposure: real positionAmt minus whatever S1+S2 already claim on that
    // symbol (computeExternalManagedNetQty, reused verbatim — the SAME subtraction
    // LiveExecutionEngine.reconcile() already performs at live-execution-engine.ts:3487). Bounded by
    // however stale this.positionSnapshot is (see updatePositionSnapshot's doc comment) — the SAME
    // ≤30s bound every other sharedGetPositions() consumer already tolerates, not a new staleness
    // class this file introduces.
    const claimedNetQty = computeExternalManagedNetQty(crossSectionalExecutors, singleSymbolExecutors);
    for (const [symbol, pos] of this.positionSnapshot) {
      const claimed = claimedNetQty.get(symbol) ?? 0;
      const manualQty = pos.positionAmt - claimed;
      if (Math.abs(manualQty) <= 1e-9) continue;
      const direction: "LONG" | "SHORT" = manualQty > 0 ? "LONG" : "SHORT";
      const usd = Math.abs(manualQty) * pos.markPrice;
      grossUsd += usd;
      if (direction === "LONG") longUsd += usd;
      else shortUsd += usd;
      addPerSymbol(symbol, usd);
      addCluster(symbol, direction);
      if (!claimedSymbols.has(symbol)) concurrentCount += 1;
    }
    // S5 — this coordinator's OWN in-flight reservations. Capacity math sums ONLY status==="RESERVED"
    // rows — a COMMITTED reservation's exposure is ALREADY visible via the owning executor's own
    // position/basket store (S1/S2 above), so including it here would double-count it against
    // itself. This exclusion is the single highest-value invariant in this file (see the dedicated
    // double-counting test in account-exposure-coordinator.test.ts) and must never be loosened to
    // e.g. `status !== "RELEASED"`.
    for (const r of this.store.getState().reservations) {
      if (r.status !== "RESERVED") continue;
      claimedSymbols.add(r.symbol);
      grossUsd += r.requestedNotionalUsd;
      if (r.direction === "LONG") longUsd += r.requestedNotionalUsd;
      else shortUsd += r.requestedNotionalUsd;
      addPerSymbol(r.symbol, r.requestedNotionalUsd);
      addCluster(r.symbol, r.direction);
      concurrentCount += 1;
    }

    return { grossUsd, longUsd, shortUsd, perSymbolUsd, clusterOpenSymbols, concurrentCount };
  }

  /**
   * Reserve risk capacity for one about-to-be-placed order. 100% synchronous — see this file's
   * header comment for why that is the entire correctness argument. Never throws for a capacity
   * rejection (matches this codebase's `{allowed/ok, reason}`-never-throw idiom for expected
   * control-flow outcomes, e.g. newExecutorLaneGate/rollingNetEntryHealth in live-executor-wiring.ts).
   *
   * Gate order (fixed, fail-fast, one reason per rejection):
   *   1. single-flight-per-symbol (unconditional, not env-gated)
   *   2. gross cap
   *   3. directional cap (whichever side req.direction is)
   *   4. per-symbol cap
   *   5. correlation-cluster cap (non-MAJOR only)
   *   6. account-wide concurrent-position-count cap
   *   7. all pass → insert RESERVED
   */
  reserve(req: ExposureReserveRequest): ExposureReserveResult {
    if (!req.symbol || typeof req.symbol !== "string") {
      return { ok: false, reservationId: null, reason: "reserve() rejected: missing symbol" };
    }
    if (req.direction !== "LONG" && req.direction !== "SHORT") {
      return { ok: false, reservationId: null, reason: "reserve() rejected: invalid direction" };
    }
    if (!req.clientOrderId) {
      return { ok: false, reservationId: null, reason: "reserve() rejected: missing clientOrderId" };
    }
    if (!Number.isFinite(req.requestedNotionalUsd) || req.requestedNotionalUsd < 0) {
      return { ok: false, reservationId: null, reason: "reserve() rejected: invalid requestedNotionalUsd" };
    }

    const symbol = req.symbol.toUpperCase();
    const clusterKey = clusterOf(symbol);
    const reservations = this.store.getState().reservations;

    // Gate 1: single-flight-per-symbol. Unconditional — this is what gives CrossSectionalExecutor
    // (which has NO in-flight claim mechanism of its own today) its first-ever protection, and is a
    // second, redundant-but-harmless layer for SingleSymbolLaneExecutor (whose own
    // entrySymbolsInFlight Set is untouched by this file).
    const alreadyReserved = reservations.some((r) => r.status === "RESERVED" && r.symbol.toUpperCase() === symbol);
    if (alreadyReserved) {
      return { ok: false, reservationId: null, reason: `${symbol}: another reservation is already in flight for this symbol` };
    }

    const snapshot = this.buildSnapshot();

    // Gate 2: gross cap.
    const grossCap = this.maxGrossExposureUsdFn();
    if (grossCap > 0 && snapshot.grossUsd + req.requestedNotionalUsd > grossCap) {
      return { ok: false, reservationId: null, reason: `${symbol}: account gross exposure cap exceeded (cap ${grossCap})` };
    }

    // Gate 3: directional cap.
    if (req.direction === "LONG") {
      const longCap = this.maxLongExposureUsdFn();
      if (longCap > 0 && snapshot.longUsd + req.requestedNotionalUsd > longCap) {
        return { ok: false, reservationId: null, reason: `${symbol}: account LONG exposure cap exceeded (cap ${longCap})` };
      }
    } else {
      const shortCap = this.maxShortExposureUsdFn();
      if (shortCap > 0 && snapshot.shortUsd + req.requestedNotionalUsd > shortCap) {
        return { ok: false, reservationId: null, reason: `${symbol}: account SHORT exposure cap exceeded (cap ${shortCap})` };
      }
    }

    // Gate 4: per-symbol cap.
    const perSymbolCap = this.maxNotionalPerSymbolUsdFn();
    const perSymbolCurrent = snapshot.perSymbolUsd.get(symbol) ?? 0;
    if (perSymbolCap > 0 && perSymbolCurrent + req.requestedNotionalUsd > perSymbolCap) {
      return { ok: false, reservationId: null, reason: `${symbol}: per-symbol notional cap exceeded (cap ${perSymbolCap})` };
    }

    // Gate 5: correlation-cluster cap (MAJORS exempt, matching every other cluster cap in this repo).
    const clusterCap = this.maxClusterPositionsFn();
    if (clusterCap > 0 && !isMajorSymbol(symbol)) {
      const key = `${clusterKey}:${req.direction}`;
      const openSymbols = snapshot.clusterOpenSymbols.get(key) ?? new Set<string>();
      if (!openSymbols.has(symbol) && openSymbols.size >= clusterCap) {
        return {
          ok: false,
          reservationId: null,
          reason: `${symbol}: correlation-cluster cap (${clusterKey}, cap ${clusterCap}) reached — ${openSymbols.size} symbol(s) already open`,
        };
      }
    }

    // Gate 6: account-wide concurrent-position-count cap.
    const concurrentCap = this.maxConcurrentPositionsAcrossAccountFn();
    if (concurrentCap > 0 && snapshot.concurrentCount >= concurrentCap) {
      return { ok: false, reservationId: null, reason: `account-wide concurrent-position cap reached (cap ${concurrentCap})` };
    }

    // All gates passed — insert. Same synchronous call as every check above: no `await` gap between
    // "capacity is available" and "capacity is now claimed", so no concurrent reserve() call can ever
    // observe the state in between.
    const nowIso = this.nowIsoFn();
    const nowMs = this.nowMs();
    const record: ExposureReservation = {
      reservationId: randomUUID(),
      executorId: req.executorId,
      kind: req.basketId ? "CROSS_SECTIONAL_LEG" : "SINGLE_SYMBOL",
      ...(req.basketId ? { basketId: req.basketId } : {}),
      symbol,
      direction: req.direction,
      clusterKey,
      requestedQty: 0,
      requestedNotionalUsd: req.requestedNotionalUsd,
      clientOrderId: req.clientOrderId,
      createdAt: nowIso,
      createdAtMs: nowMs,
      status: "RESERVED",
    };
    this.store.getState().reservations.push(record);
    this.store.save();
    return { ok: true, reservationId: record.reservationId };
  }

  /**
   * Commit a reservation from the ACTUAL fill — never the requested qty/notional, which stay
   * permanently on the record as a "requested vs actual" audit pair (matching LiveIntent's
   * requiredNotionalUsd/appliedNotionalUsd convention). Idempotent: a reservation not found, or
   * already COMMITTED/RELEASED, is a silent no-op — this can legitimately be called more than once
   * on the same id by a caller's own retry/partial-fill handling, and must never throw on the hot
   * order path. Synchronous, matching the API surface's contract.
   */
  commitReservation(reservationId: string, filled: { qty: number; avgPrice: number }): void {
    const record = this.store.getState().reservations.find((r) => r.reservationId === reservationId);
    if (!record || record.status !== "RESERVED") return;
    record.committedQty = filled.qty;
    record.committedNotionalUsd = filled.qty * filled.avgPrice;
    record.committedAt = this.nowIsoFn();
    record.status = "COMMITTED";
    this.store.save();
  }

  /**
   * Release unused capacity on rejection, timeout, cancellation, or failure. Same idempotent,
   * never-throws, synchronous contract as commitReservation().
   */
  releaseReservation(reservationId: string, reason: string): void {
    const record = this.store.getState().reservations.find((r) => r.reservationId === reservationId);
    if (!record || record.status !== "RESERVED") return;
    record.status = "RELEASED";
    record.releasedAt = this.nowIsoFn();
    record.releaseReason = reason;
    this.store.save();
  }

  /**
   * Unifies restart-reconciliation and the in-process periodic stale-sweep into ONE routine — not
   * two separate mechanisms. In healthy operation a RESERVED row ALWAYS flips to COMMITTED/RELEASED
   * within one placeOrder+resolveFillPrice await chain (bounded by REQUEST_TIMEOUT_MS), so ANY row
   * still RESERVED past reservationStaleMs() is, by construction, evidence of a stuck reservation —
   * whether discovered at cold start (the process that created it is necessarily dead) or discovered
   * mid-session by a periodic timer (belt-and-suspenders for a bug that leaks a reservation without a
   * crash). Rows younger than the threshold are left RESERVED as-is without attempting reconciliation
   * — not ambiguous about whether they should occupy capacity, only whether it is yet worth spending
   * an API call to investigate; the next sweep picks them up once they cross the threshold.
   *
   * Four outcomes per stale row (queried via queryOrderByClientId(symbol, clientOrderId)):
   *   1. FILLED/PARTIALLY_FILLED with executedQty>0 → COMMITTED from the real executedQty/avgPrice.
   *      A report-only log line flags that the OWNING executor's own position/basket store should be
   *      checked for a matching record — this alone does not recreate a missing position record (see
   *      this file's header comment; that repair is out of scope for this coordinator).
   *   2. Terminal with no fill (CANCELED/CANCELLED/EXPIRED/REJECTED, or a defensive
   *      FILLED-with-executedQty<=0) → RELEASED "RECONCILED_NOT_FILLED".
   *   3. The query itself fails with BinanceFuturesPrivateError.binanceCode===-2013 ("order does not
   *      exist") → Binance has no record at all, the order never reached the exchange → RELEASED
   *      "RECONCILED_NEVER_REACHED_EXCHANGE".
   *   4. Anything else (network error, timeout, any other Binance code, malformed response, an
   *      unrecognized/ambiguous order status such as NEW or a contradictory PARTIALLY_FILLED with
   *      executedQty<=0, or no queryOrderByClientId wired at all) → genuinely INCONCLUSIVE: left
   *      RESERVED unchanged, logged, retried next sweep indefinitely.
   */
  async reconcileStaleReservations(): Promise<ReconcileSweepResult> {
    const staleMs = this.reservationStaleMsFn();
    const nowMs = this.nowMs();
    const reservations = this.store.getState().reservations;
    const stale = reservations.filter((r) => r.status === "RESERVED" && nowMs - r.createdAtMs >= staleMs);

    let committed = 0;
    let released = 0;
    let inconclusive = 0;

    for (const r of stale) {
      if (!this.queryOrderByClientIdFn) {
        inconclusive += 1;
        this.logReconcileIssue(
          `${r.symbol}: stale reservation ${r.reservationId} left RESERVED — no queryOrderByClientId wired, cannot reconcile`,
        );
        continue;
      }
      try {
        const order = await this.queryOrderByClientIdFn(r.symbol, r.clientOrderId);
        const status = (order.status ?? "").trim().toUpperCase();
        const executedQty = Number.isFinite(order.executedQty) ? order.executedQty : 0;
        if ((status === "FILLED" || status === "PARTIALLY_FILLED") && executedQty > 0) {
          r.committedQty = executedQty;
          r.committedNotionalUsd = executedQty * order.avgPrice;
          r.committedAt = this.nowIsoFn();
          r.status = "COMMITTED";
          committed += 1;
          this.logReconcileIssue(
            `${r.symbol}: stale reservation ${r.reservationId} reconciled COMMITTED (executedQty=${executedQty}) — ` +
              `verify the owning executor's own position/basket store recorded this fill`,
          );
        } else if (
          status === "CANCELED" ||
          status === "CANCELLED" ||
          status === "EXPIRED" ||
          status === "REJECTED" ||
          (status === "FILLED" && executedQty <= 0)
        ) {
          r.status = "RELEASED";
          r.releasedAt = this.nowIsoFn();
          r.releaseReason = "RECONCILED_NOT_FILLED";
          released += 1;
        } else {
          inconclusive += 1;
          this.logReconcileIssue(
            `${r.symbol}: stale reservation ${r.reservationId} inconclusive order status "${status}" (executedQty=${executedQty}) — left RESERVED, will retry`,
          );
        }
      } catch (error) {
        if (error instanceof BinanceFuturesPrivateError && error.binanceCode === -2013) {
          r.status = "RELEASED";
          r.releasedAt = this.nowIsoFn();
          r.releaseReason = "RECONCILED_NEVER_REACHED_EXCHANGE";
          released += 1;
        } else {
          inconclusive += 1;
          this.logReconcileIssue(
            `${r.symbol}: stale reservation ${r.reservationId} query failed (${(error as Error).message ?? "unknown error"}) — left RESERVED, will retry`,
          );
        }
      }
    }

    if (stale.length > 0) this.store.save();
    return { checked: stale.length, committed, released, inconclusive };
  }

  /** Thin, semantically-named entry point for the one-time startup call — delegates to the exact
   *  same routine the periodic sweep uses (see reconcileStaleReservations's doc comment for why
   *  these are deliberately unified rather than two separate mechanisms). */
  async reconcileOnStartup(): Promise<ReconcileSweepResult> {
    return this.reconcileStaleReservations();
  }

  /**
   * Read-only introspection: current total notional (USD) the coordinator's own capacity math
   * attributes to `symbol` right now — computeNotionalPerSymbol's S1+S2 base plus S3/S4/S5 folded in.
   * Exists primarily because gate 1's unconditional single-flight rule means a same-symbol reserve()
   * collision can never distinguish "blocked by single-flight" from "would also have been blocked by
   * the per-symbol cap" from the outside — this makes each source's fold-in independently
   * observable/testable. Also useful for a stage-2 dashboard.
   */
  getSymbolExposureUsd(symbol: string): number {
    return this.buildSnapshot().perSymbolUsd.get(symbol.toUpperCase()) ?? 0;
  }

  /** Same rationale as getSymbolExposureUsd, for the correlation-cluster axis: symbols currently
   *  counted as "open" in `symbol`'s cluster+direction bucket (MAJORS are always exempt upstream, so
   *  this returns whatever the raw bucket holds regardless of symbol — callers checking the cap
   *  themselves must apply isMajorSymbol() the same way reserve()'s own gate 5 does). */
  getClusterOpenSymbols(symbol: string, direction: "LONG" | "SHORT"): string[] {
    const key = `${clusterOf(symbol)}:${direction}`;
    return Array.from(this.buildSnapshot().clusterOpenSymbols.get(key) ?? new Set<string>()).sort();
  }

  /** Report-only status projection, same idiom as every executor's own getStatus(). Never consulted
   *  by any capacity decision — reserve() always recomputes buildSnapshot() fresh. */
  getStatus(): {
    reservedCount: number;
    committedCount: number;
    releasedCount: number;
    grossUsd: number;
    longUsd: number;
    shortUsd: number;
    concurrentCount: number;
    positionSnapshotAgeMs: number | null;
    caps: {
      maxGrossExposureUsd: number;
      maxLongExposureUsd: number;
      maxShortExposureUsd: number;
      maxNotionalPerSymbolUsd: number;
      maxClusterPositions: number;
      maxConcurrentPositionsAcrossAccount: number;
      reservationStaleMs: number;
    };
    recentReservations: ExposureReservation[];
    recentReconcileIssues: string[];
  } {
    const reservations = this.store.getState().reservations;
    const snapshot = this.buildSnapshot();
    return {
      reservedCount: reservations.filter((r) => r.status === "RESERVED").length,
      committedCount: reservations.filter((r) => r.status === "COMMITTED").length,
      releasedCount: reservations.filter((r) => r.status === "RELEASED").length,
      grossUsd: snapshot.grossUsd,
      longUsd: snapshot.longUsd,
      shortUsd: snapshot.shortUsd,
      concurrentCount: snapshot.concurrentCount,
      positionSnapshotAgeMs: this.positionSnapshotAtMs === null ? null : this.nowMs() - this.positionSnapshotAtMs,
      caps: {
        maxGrossExposureUsd: this.maxGrossExposureUsdFn(),
        maxLongExposureUsd: this.maxLongExposureUsdFn(),
        maxShortExposureUsd: this.maxShortExposureUsdFn(),
        maxNotionalPerSymbolUsd: this.maxNotionalPerSymbolUsdFn(),
        maxClusterPositions: this.maxClusterPositionsFn(),
        maxConcurrentPositionsAcrossAccount: this.maxConcurrentPositionsAcrossAccountFn(),
        reservationStaleMs: this.reservationStaleMsFn(),
      },
      recentReservations: reservations.slice(-10),
      recentReconcileIssues: this.reconcileLog.slice(-10),
    };
  }
}
