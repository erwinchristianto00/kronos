/**
 * Real, synchronous {price, atMs} mark-price cache for the four-brain shadow layer's Exit Brain (item
 * 3 of the 3 permanent-null four-brain data gaps — see btc-atr-percentile-cache.ts for item 1 and
 * four-brain-best-lane-report.ts for item 2). Consumer contract:
 * four-brain-live-gather-bindings.ts's `markPriceForSymbol: (symbol) => {price, atMs}`, whose
 * FRESHNESS_TTL_MS.position (60s, four-brain-live-gather.ts) gate turns a STALE or FUTURE mark into
 * `currentPrice: null` before it can reach unrealizedR / hardExitTriggered (see exit-brain.ts).
 *
 * Replaces the permanent `markPriceForSymbol: () => ({ price: null, atMs: null })` stub in app.ts's
 * buildFourBrainDeps, which kept every open position's currentPrice/unrealizedR/hardExit MISSING for
 * the four-brain Exit Brain's entire run.
 *
 * SOURCE: the SAME shared, 30s-cached getPositions() promise ALL 11 executor instances already use
 * (see app.ts's `sharedGetPositions` doc comment, 2026-07-12 fix), via app.ts's
 * `ensureCachedPositions()` helper, which returns that promise TOGETHER WITH the wall-clock time the
 * underlying fetch actually started (`{at, promise}`), read atomically in one synchronous call. This
 * module is a purely OBSERVATIONAL consumer of that promise's RESOLVED VALUE — see
 * refreshLiveMarkPriceCache's doc comment for the exact non-interference contract that makes this safe
 * to attach to it. It NEVER wraps, replaces, mutates, or alters sharedGetPositions's own cache/timing
 * for its other callers.
 *
 * 2026-07-23 fix: `atMs` MUST be the time the underlying Binance snapshot was actually fetched, not
 * the wall-clock time this module's own refresh happened to run. Because this refresh's 25s interval
 * is SHORTER than the shared cache's 30s de-dup window, a naive `Date.now()`-at-refresh-time stamp
 * would silently understate staleness by up to ~30s on roughly every other cycle (the refresh reusing
 * an already-resolved, up-to-30s-old promise but stamping it as fresh-right-now) — see
 * refreshLiveMarkPriceCache's doc comment for the full mechanics.
 *
 * `positions` from getPositions() covers every symbol Binance USD-M futures reports (a bounded,
 * exchange-sized list — not just symbols with an open position; markPrice is market-wide data, the
 * same "safe to reuse even if another concurrent basket shares the same symbol" property already
 * documented at cross-sectional-executor.ts's closeBasketsHittingProfitTarget), so this cache's
 * memory footprint is bounded by the exchange's symbol count, never by trade/position history.
 *
 * Two pieces, mirroring BtcAtrPercentileCacheStore's pattern (btc-atr-percentile-cache.ts):
 *  1. `extractMarkPrices` — a pure function (position-shaped array in, {symbol,price}[] out),
 *     mirroring the EXACT field-access pattern already proven at cross-sectional-executor.ts's
 *     closeBasketsHittingProfitTarget and single-symbol-lane-executor.ts's monitorOpenPositions
 *     (`Number.isFinite(p.markPrice) && p.markPrice > 0`) — never fabricates, simply skips anything
 *     that fails the check.
 *  2. `LiveMarkPriceCacheStore` — small in-memory Record<symbol, {price, atMs}>, refreshed on its own
 *     interval from app.ts (buildFourBrainDeps is SYNCHRONOUS — see four-brain-shadow-tick.ts's sync
 *     gather — and cannot await a positions fetch inline), read synchronously at gather time.
 *
 * Staleness is deliberately NOT this store's job: a symbol whose position closed between refreshes
 * keeps its last reading until the CONSUMER's own FRESHNESS_TTL_MS.position check ages it out — a
 * brief window, well inside what the freshness gate already treats as safe/expected (the module doc
 * comment on four-brain-live-gather-bindings.ts's markFresh check is the authority on this).
 */
import type { FuturesPosition } from "./binance-futures-private.js";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Pure: extracts {symbol -> markPrice} pairs from a live getPositions()-shaped array, mirroring the
 * exact finiteness/positivity check already used at cross-sectional-executor.ts's
 * closeBasketsHittingProfitTarget and single-symbol-lane-executor.ts's monitorOpenPositions
 * (`Number.isFinite(p.markPrice) && p.markPrice > 0`). A position with a missing/non-finite/zero
 * markPrice, or a missing/empty symbol, is SKIPPED — never fabricated as 0 and never carried forward
 * from a stale reading (this function has no memory of prior calls).
 */
export function extractMarkPrices(
  positions: readonly Pick<FuturesPosition, "symbol" | "markPrice">[],
): Array<{ symbol: string; price: number }> {
  const out: Array<{ symbol: string; price: number }> = [];
  for (const p of positions) {
    if (typeof p.symbol === "string" && p.symbol.length > 0 && finite(p.markPrice) && p.markPrice > 0) {
      out.push({ symbol: p.symbol, price: p.markPrice });
    }
  }
  return out;
}

export interface LiveMarkPriceReading {
  price: number | null;
  atMs: number | null;
}

const EMPTY_READING: LiveMarkPriceReading = { price: null, atMs: null };

/**
 * In-memory-only, per-symbol cache. Fail-open: get() on an unknown/never-populated symbol returns
 * {price:null, atMs:null} — never a fabricated 0 or a synthesized timestamp. Staleness itself is the
 * CONSUMER's job (four-brain-live-gather-bindings.ts's FRESHNESS_TTL_MS.position check) — this store
 * only ever records exactly what it is given, with the atMs it is given.
 */
export class LiveMarkPriceCacheStore {
  private state: Record<string, LiveMarkPriceReading> = {};

  get(symbol: string): LiveMarkPriceReading {
    return this.state[symbol] ?? EMPTY_READING;
  }

  /** Records one symbol's mark reading. Rejects a non-finite/non-positive price, non-finite atMs, or
   *  empty symbol (fail-open — never lets one bad entry corrupt the cache); the update is silently
   *  ignored rather than thrown, since this is a report-only observational path where a malformed
   *  reading must never become an exception that could propagate into an executor's own tick. */
  set(symbol: string, price: number, atMs: number): void {
    if (typeof symbol !== "string" || symbol.length === 0 || !finite(price) || !(price > 0) || !finite(atMs)) return;
    this.state = { ...this.state, [symbol]: { price, atMs } };
  }

  /** Applies a batch of readings, all stamped with the same fetch time (one refresh cycle). Entries
   *  that fail set()'s validation are individually skipped without affecting the rest of the batch. */
  setAll(entries: readonly { symbol: string; price: number }[], atMs: number): void {
    for (const e of entries) this.set(e.symbol, e.price, atMs);
  }
}

let singleton: LiveMarkPriceCacheStore | null = null;
export function getLiveMarkPriceCacheStore(): LiveMarkPriceCacheStore {
  if (!singleton) singleton = new LiveMarkPriceCacheStore();
  return singleton;
}

export function _resetLiveMarkPriceCacheStoreForTests(): void {
  singleton = null;
}

/** What a getPositions() call resolves to, unchanged. */
export type LivePositionsList = readonly Pick<FuturesPosition, "symbol" | "markPrice">[];

/**
 * A synchronous accessor that returns the in-flight/cached positions promise TOGETHER WITH the
 * wall-clock time that specific fetch actually started (`fetchedAtMs`), captured atomically in one
 * call — mirroring app.ts's `ensureCachedPositions()` (the helper `sharedGetPositions` itself is
 * built on). Returning `{promise, fetchedAtMs}` as one synchronous read, rather than a bare
 * `Promise<positions>` plus a separately-called "what time was it" function, is what makes the
 * timestamp provably correspond to the promise being awaited — see the 2026-07-23 fix note below.
 */
export type LiveGetPositionsFn = () => { promise: Promise<LivePositionsList>; fetchedAtMs: number };

/**
 * Refreshes the mark-price cache from the SAME shared getPositions() promise every executor already
 * uses — pass app.ts's `ensureCachedPositions`-backed wrapper as `getPositions` (see app.ts's wiring
 * comment for exactly where this is registered and constructed).
 *
 * NON-INTERFERENCE CONTRACT with sharedGetPositions (the reason this is safe to attach to it):
 *  - This function only ever CALLS getPositions() and reads its RESOLVED value. It never constructs,
 *    caches, mutates, or replaces the promise/cache object sharedGetPositions owns (`cachedPositions`
 *    in app.ts stays 100% untouched by this module). Every other caller of sharedGetPositions keeps
 *    receiving the exact same promise on the exact same 30s cache window, regardless of whether this
 *    function has run, is currently running, or has ever been called at all.
 *  - Awaiting a promise (or calling `.then`) never consumes or mutates it — any number of independent
 *    callers can await/then the SAME promise and each gets its own settlement callback with the
 *    identical resolved value, so this adds a reader, never a side effect, to sharedGetPositions.
 *  - This function never throws and never produces an unhandled rejection: the entire body is one
 *    try/catch — a rejected getPositions() promise (network error, signed-call failure) is caught
 *    right here and becomes a no-op (the cache keeps its previous values — fail-open, the same
 *    convention as refreshBtcAtrPercentileCache). buildFourBrainDeps never awaits this function at
 *    all (it only reads the store synchronously via LiveMarkPriceCacheStore.get), so nothing here can
 *    ever propagate into — or crash — a four-brain gather tick.
 *
 * 2026-07-23 fix (CONFIRMED correctness finding): `atMs` is now stamped with `fetchedAtMs` — the time
 * the underlying Binance snapshot was actually obtained, taken from the SAME synchronous
 * `getPositions()` call whose `.promise` is then awaited — rather than `Date.now()` read after the
 * await resolves. The old behavior stamped the wall-clock time this refresh happened to run, which is
 * NOT when the data was fetched: because this refresh's 25s interval is shorter than
 * sharedGetPositions's 30s de-dup window, roughly every other cycle reuses an already-resolved promise
 * up to ~30s old, and stamping it as "just fetched" understated staleness by that same ~30s, letting
 * data as much as ~90s old pass the consumer's 60s FRESHNESS_TTL_MS.position gate as "fresh".
 */
export async function refreshLiveMarkPriceCache(
  store: LiveMarkPriceCacheStore,
  getPositions: LiveGetPositionsFn,
): Promise<{ ok: boolean; updated: number }> {
  try {
    const { promise, fetchedAtMs } = getPositions();
    const positions = await promise;
    if (!Array.isArray(positions)) return { ok: false, updated: 0 };
    const entries = extractMarkPrices(positions);
    store.setAll(entries, fetchedAtMs);
    return { ok: true, updated: entries.length };
  } catch {
    // Fail-open: leave the cache exactly as it was — never fabricate, never throw, never produce an
    // unhandled rejection. Always invoked as a fire-and-forget `void refreshLiveMarkPriceCache(...)`
    // from a setInterval in app.ts; this catch is what keeps that call site's own timer safe.
    return { ok: false, updated: 0 };
  }
}
