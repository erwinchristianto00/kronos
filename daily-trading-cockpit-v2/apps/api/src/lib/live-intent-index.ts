import type { LiveIntent } from "./live-execution-engine.js";

/**
 * Map returned by buildLiveIntentIndexByPaperOrderId. Behaves exactly like a plain
 * ReadonlyMap<string, LiveIntent> for every existing consumer (`.get()`, `.keys()`, `.size`, …) —
 * it IS a Map — plus one additional field, `conflictedPaperOrderIds`, documented on the builder
 * function below.
 */
export class LiveIntentIndex extends Map<string, LiveIntent> {
  /** paperOrderIds that could NOT be resolved to exactly one owning intent (see the COLLISION
   *  POLICY doc on buildLiveIntentIndexByPaperOrderId). Deliberately never a key of this map — a
   *  `.get()` on one of these ids is a MISS, byte-identical in shape to "no live intent exists for
   *  this id at all" — but recorded here so a caller deriving "is this paperOrderId executing" can
   *  still answer TRUE (it unambiguously belongs to at least one live intent) without the index
   *  ever guessing WHICH intent that is. */
  readonly conflictedPaperOrderIds: ReadonlySet<string>;

  constructor(entries: Iterable<readonly [string, LiveIntent]>, conflictedPaperOrderIds: ReadonlySet<string>) {
    super(entries);
    this.conflictedPaperOrderIds = conflictedPaperOrderIds;
  }
}

/**
 * Builds an index of live execution intents keyed by paperOrderId, once per gather/tick — O(intents).
 * Every subsequent lookup is O(1), replacing a fresh linear .find()/.map() per candidate (the pattern
 * previously used inline in app.ts's onExecutiveDecision closure, rebuilding
 * `liveExecutionStore.getState().intents.map(...)` on every candidate within a single tick).
 *
 * Indexes BOTH of the two ids a paperOrderId can legitimately resolve an intent through:
 *   1. `intent.paperOrderId` — the intent's PRIMARY order (paperOrderId is unique per intent by
 *      construction: executionIntentId === paper.paperOrderId, live-execution-engine.ts's
 *      openIntent()).
 *   2. `intent.sourcePaperOrders[i].paperOrderId` — every order netted/pyramided into that intent,
 *      including the primary's own order (openIntent() always echoes the opening `paper` itself
 *      into `sourcePaperOrders`, so a primary's id is routinely ALSO one of its own intent's source
 *      entries — that is expected, not a collision) and any later pyramid add
 *      (LiveExecutionEngine's add-entry path appends to `sourcePaperOrders`, never to a second
 *      intent). Before this, a source-only order (one that never became any intent's primary) had
 *      no entry here at all, so `executingPaperOrderIds` (app.ts) could never mark it executing and
 *      executive-review-admission.ts's dedicated sourceEntry branch was unreachable in production.
 *
 * COLLISION POLICY (fail-closed, documented 2026-08-02): a paperOrderId is expected to resolve to
 * exactly ONE owning intent. A genuine collision is a paperOrderId that resolves to TWO OR MORE
 * DISTINCT intents — as the PRIMARY of two different intents, as the PRIMARY of one intent and a
 * (non-self) SOURCE of a different intent, or as a SOURCE of two different intents at once. There is
 * NO exception for primary-vs-primary: it is tempting to assume that's "impossible by construction"
 * (paperOrderId is unique per intent — executionIntentId === paper.paperOrderId, live-execution-
 * engine.ts's openIntent()) and fall back to last-write-wins, but construction-time uniqueness of a
 * single intent's own id says nothing about two SEPARATE intents ending up primaried on the same
 * paperOrderId — see the concrete counterexample below. Every collision shape is handled identically
 * by this index: retract from the resolvable map, record in `conflictedPaperOrderIds`, never guess.
 *
 * This is not supposed to happen: mirrorNewSignals()'s `mirrored` de-dupe set is meant to prevent a
 * paperOrderId already sourced into a live intent from being mirrored again. But that guard only
 * covers intents that are NOT already ERROR/KILLED (`intent.state !== "ERROR" && intent.state !==
 * "KILLED"`), so a paperOrderId that was sourced into a now-terminal (ERROR/KILLED) intent is
 * legally eligible to be mirrored again into a brand-new intent later — this index must not assume
 * that never happens; it must check, and it does, every time it is built. Concretely, this is also
 * how a PRIMARY-vs-PRIMARY collision arises, not just source collisions: `mirrorAttempts` retry logic
 * allows re-mirroring the same paperOrderId up to `MAX_MIRROR_ATTEMPTS` (=2) times
 * (live-execution-engine.ts:1431, checked at 5885/5913), and `openIntent()` never checks primary-id
 * uniqueness before `st.intents.push(intent)` (live-execution-engine.ts:6466) — so two ticks apart, a
 * paper order whose first mirror attempt ended in ERROR can be re-mirrored into a second, live
 * intent, producing two distinct LiveIntents that share one primary paperOrderId.
 *
 * On a genuine collision, this index NEVER silently picks one of the candidate intents (oldest,
 * newest, primary-over-source, or any other tiebreak). The colliding paperOrderId is retracted from
 * the resolvable map entirely — `.get()` on it is a MISS — and recorded in `conflictedPaperOrderIds`
 * instead. Callers deriving "is this order executing" (app.ts's `executingPaperOrderIds`) should
 * still treat a conflicted id as executing, since it unambiguously belongs to at least one live
 * intent — the downstream attach path (executive-review-admission.ts) already fails closed on
 * exactly this shape of disagreement via its pre-existing INTENT_INDEX_MISS result: "executingPaper
 * OrderIds said this order is executing, but the index … has no entry for it — the two inputs
 * disagree. Fail closed: never assume which one is stale." A collision is reported through the same
 * mechanism as a stale/missing index, deliberately — both are "we cannot safely resolve this id",
 * and the caller must never guess in either case.
 */
export function buildLiveIntentIndexByPaperOrderId(
  intents: readonly LiveIntent[],
): LiveIntentIndex {
  // Single unified "owners per id" pass: a primary id is indexed exactly like a source id, through
  // the SAME accumulator, so there is no separate primary-only structure that could silently
  // last-write-win a primary-vs-primary collision. Grouped by the SET of intents that claim each id,
  // so a genuine collision (size > 1) is detectable rather than silently overwritten — regardless of
  // whether the colliding paperOrderId is a PRIMARY, a SOURCE, or both, on either side.
  const owners = new Map<string, Set<LiveIntent>>();
  const addOwner = (id: string, intent: LiveIntent) => {
    let set = owners.get(id);
    if (!set) {
      set = new Set<LiveIntent>();
      owners.set(id, set);
    }
    set.add(intent);
  };
  for (const intent of intents) {
    addOwner(intent.paperOrderId, intent);
    for (const source of intent.sourcePaperOrders ?? []) {
      if (source.paperOrderId === intent.paperOrderId) continue; // routine self-echo, not new info
      addOwner(source.paperOrderId, intent);
    }
  }

  const resolved = new Map<string, LiveIntent>();
  const conflicted = new Set<string>();
  for (const [paperOrderId, candidates] of owners) {
    if (candidates.size > 1) {
      // COLLISION — see policy doc above. Retract (never overwrite with a guess) and record.
      conflicted.add(paperOrderId);
    } else {
      resolved.set(paperOrderId, [...candidates][0]!);
    }
  }

  return new LiveIntentIndex(resolved, conflicted);
}
