/**
 * KEYED SINGLE-FLIGHT (JOIN) GUARD FOR STORE-MUTATING ASYNC WORK
 *
 * Problem this solves: several production entry points (an HTTP request handler, a
 * fire-and-forget background call triggered from a different handler, a self-scheduling
 * ticker) can each independently invoke the same store-mutating async function against the
 * SAME singleton store while a previous invocation's real work is still in flight — none of
 * them wait for each other today, and nothing before this module gave them a way to.
 * `beginBatch`/`endBatch` on these stores is a plain instance counter that exists purely to
 * coalesce disk flushes; it provides no cross-caller mutual exclusion at all. Both of these
 * async functions also yield the event loop constantly while their work is in flight (e.g. on
 * essentially every observation, by default), which is exactly when an uncoordinated second
 * caller can interleave and mutate the same on-disk JSON out from under the first.
 *
 * JOIN semantics — this is the important part, and it is deliberately NOT the same as this
 * codebase's other single-flight helper (`single-flight-runner.ts`'s `createSingleFlightRunner`,
 * which is queue-next-tick: a call while busy only coalesces into one follow-up run and returns
 * no result to anyone). This module instead mirrors `routes/scan.ts`'s own
 * `runSingleFlightScanCycle`: while a call for a given store is in flight, any OTHER call for
 * that SAME store object does not start a second pass — it is handed back the IDENTICAL promise
 * the first call is already awaiting, so it resolves (or rejects) to the exact same value at the
 * exact same instant as the original caller. No caller-visible result is ever synthesized or
 * independently recomputed for a joiner.
 *
 * Keying is by STORE OBJECT IDENTITY, not by a string name: the WeakMap key is the store
 * instance itself. Two calls against the SAME store instance (e.g. the one production
 * singleton returned by a `getXStore()` getter) join; two calls against two DIFFERENT store
 * instances (e.g. two independent test fixtures, each its own fresh `new SomeStore(tmpDir())`)
 * never see each other at all and run fully concurrently — there is no shared string key to
 * collide or mistype, and nothing to reset between tests. Being a WeakMap, an entry never keeps
 * its store instance alive once every other reference to it is dropped, and there is no separate
 * "reset to null" bookkeeping required for cleanup: a store instance that becomes unreachable
 * while an entry still references it is collected along with that entry.
 *
 * Rejection: if `fn()` rejects, that SAME rejection is what every joined caller observes when it
 * awaits the returned promise — nothing in this module catches, swallows, or rewrites it. The
 * in-flight entry is always released afterward — success OR rejection — via `.finally()`, so a
 * failed pass never leaves the store permanently locked: the very next call made after the
 * rejection has settled starts a genuinely new pass rather than joining a dead promise forever.
 * The `.finally()` chain's own settlement is separately (and only internally) `.catch()`-ed so
 * THAT derived chain never surfaces as an unhandled rejection; the original `promise` value
 * returned to every caller below is untouched and still carries the real rejection to them.
 */

const inFlightByStore = new WeakMap<object, Promise<unknown>>();

/**
 * Runs `fn` for `store`, joining an already-in-flight call for that SAME store object instead
 * of starting a concurrent second one. Concurrent callers passing the same store object all
 * receive the identical promise (and therefore the identical eventual result) of whichever call
 * actually invoked `fn`; callers passing a DIFFERENT store object are never blocked by this one.
 * See the module doc comment above for the full contract, including rejection behavior.
 */
export function runExclusiveForStore<T>(store: object, fn: () => Promise<T>): Promise<T> {
  const existing = inFlightByStore.get(store);
  if (existing) {
    return existing as Promise<T>;
  }
  const promise = fn();
  inFlightByStore.set(store, promise);
  promise
    .finally(() => {
      // Only clear the slot if it still refers to THIS promise — mirrors
      // runSingleFlightScanCycle's own guard against a stale finally clobbering a newer
      // in-flight entry. Always runs, on both the resolve and the reject path, so a
      // rejected pass never leaves this store's slot permanently occupied.
      if (inFlightByStore.get(store) === promise) {
        inFlightByStore.delete(store);
      }
    })
    .catch(() => {
      // Attached only to this derived `.finally()` chain so ITS settlement never becomes an
      // unhandled-rejection warning. The `promise` value actually returned to every caller
      // (below, and to any joiner) is untouched, so they still observe the real rejection
      // themselves via their own await/.catch.
    });
  return promise;
}
