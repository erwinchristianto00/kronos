import { describe, it, expect } from "vitest";
import { decideEntry } from "../src/lib/entry-brain.js";
import { checkEntryInvariants } from "../src/lib/four-brain-invariants.js";
import { entryInput, src, NOW, MIN } from "./four-brain-fixtures.js";

describe("Entry Brain", () => {
  it("a correct direction with excessive chase risk produces WAIT (not ENTER_NOW)", () => {
    const d = decideEntry(entryInput({ candleExtensionAtr: src(3.5), distanceFromVwapAtr: src(3.0), pullbackDepthAtr: src(0) }));
    expect(d.chaseRisk).toBeGreaterThanOrEqual(0.7);
    expect(["WAIT_PULLBACK", "SKIP"]).toContain(d.action);
    expect(d.action).not.toBe("ENTER_NOW");
  });

  it("a STALE signal can NEVER ENTER_NOW", () => {
    const d = decideEntry(entryInput({ signalAgeMs: 90 * MIN, maxSignalAgeMs: 50 * MIN }));
    expect(d.sourceStatuses.signal).toBe("STALE");
    expect(d.action).toBe("SKIP");
    expect(checkEntryInvariants(d, { signalFresh: false }).ok).toBe(true);
  });

  it("invalid stop geometry (stop on the wrong side) produces SKIP", () => {
    const d = decideEntry(entryInput({ side: "LONG", targetEntry: 100, initialStopPrice: 103 })); // long stop ABOVE entry = invalid
    expect(d.action).toBe("SKIP");
    expect(d.initialStopPrice).toBeNull(); // fail-safe null
    expect(d.reasons.some((r) => r.includes("geometry"))).toBe(true);
  });

  it("excessive slippage produces SKIP", () => {
    const d = decideEntry(entryInput({ expectedSlippageBps: src(40) }));
    expect(d.action).toBe("SKIP");
  });

  it("a null expectedSlippage (book too thin) produces SKIP — never extrapolated", () => {
    const d = decideEntry(entryInput({ expectedSlippageBps: src(null) }));
    expect(d.slippageRisk).toBeGreaterThanOrEqual(0.9);
    expect(d.action).toBe("SKIP");
  });

  it("missing order-book depth (UNAVAILABLE source) falls back safely, still can ENTER_NOW", () => {
    const d = decideEntry(entryInput({ bookDepthOk: null }));
    expect(d.sourceStatuses.bookDepth).toBe("MISSING");
    expect(d.action).toBe("ENTER_NOW"); // depth isn't required; other conditions clean
    expect(checkEntryInvariants(d, { signalFresh: true }).ok).toBe(true);
  });

  it("clean fresh setup → ENTER_NOW with valid protective geometry", () => {
    const d = decideEntry(entryInput());
    expect(d.action).toBe("ENTER_NOW");
    expect(d.initialStopPrice).not.toBeNull();
    expect(d.initialStopPrice! < d.targetEntry!).toBe(true); // long stop below entry
    expect(checkEntryInvariants(d, { signalFresh: true }).ok).toBe(true);
  });

  it("replaying the same fixture is deterministic", () => {
    expect(decideEntry(entryInput())).toEqual(decideEntry(entryInput()));
  });

  // ── review regressions (freshness/causal contract on microstructure inputs) ──────────────────────
  it("a FUTURE-timestamped microstructure input is REJECTED (ERROR, unused) — freshness/causal contract", () => {
    // A future-stamped pullback must NOT lower chase risk; a future-stamped slippage must NOT be trusted.
    const future = { value: 2, asOfMs: NOW + 60 * MIN };
    const d = decideEntry(entryInput({ pullbackDepthAtr: future, expectedSlippageBps: future }));
    expect(d.sourceStatuses.pullbackDepthAtr).toBe("ERROR");
    expect(d.sourceStatuses.expectedSlippageBps).toBe("ERROR");
  });

  it("a STALE microstructure input is neutral-filled, not used as fresh", () => {
    const d = decideEntry(entryInput({ candleExtensionAtr: src(4, 60 * MIN) })); // 60min old vs 10min TTL
    expect(d.sourceStatuses.candleExtensionAtr).toBe("STALE");
  });

  it("MISSING slippage + spread (absent sources) does NOT fabricate zero-risk — biases cautious", () => {
    // Absent sources (undefined) — distinct from src(null) which is the 'book too thin' reading.
    const d = decideEntry(entryInput({ spreadBps: undefined, expectedSlippageBps: undefined }));
    expect(d.sourceStatuses.spreadBps).toBe("MISSING");
    expect(d.slippageRisk).toBeGreaterThan(0.2); // not a fabricated 0
    expect(d.reasons.some((r) => r.includes("MISSING"))).toBe(true);
  });

  // ── adapter B: candle freshness gate — stale candle data can NEVER ENTER_NOW ──────────────────────
  it("candleFresh=false blocks ENTER_NOW even on an otherwise-clean fresh signal (WAIT_CONFIRMATION)", () => {
    const clean = decideEntry(entryInput());
    expect(clean.action).toBe("ENTER_NOW"); // baseline: same fixture WITHOUT the stale-candle flag enters
    const d = decideEntry(entryInput({ candleFresh: false }));
    expect(d.action).not.toBe("ENTER_NOW");
    expect(d.action).toBe("WAIT_CONFIRMATION");
  });

  it("candleFresh=true / undefined does not block a clean setup (adapter absent ⇒ no false block)", () => {
    expect(decideEntry(entryInput({ candleFresh: true })).action).toBe("ENTER_NOW");
    expect(decideEntry(entryInput({ candleFresh: null })).action).toBe("ENTER_NOW");
    expect(decideEntry(entryInput({ candleFresh: undefined })).action).toBe("ENTER_NOW");
  });

  it("dry-run regression: a MISSING slippage {value:null, asOfMs:null} is NOT 'book too thin' → cautious, can ENTER_NOW", () => {
    // The gather emits a MISSING source as {value:null, asOfMs:null}; that must NOT be read as thin-book
    // (which forces SKIP). It should be the cautious-default path so a clean fresh signal can still ENTER_NOW.
    const d = decideEntry(entryInput({ spreadBps: { value: null, asOfMs: null }, expectedSlippageBps: { value: null, asOfMs: null }, candleExtensionAtr: { value: null, asOfMs: null }, distanceFromVwapAtr: { value: null, asOfMs: null } }));
    expect(d.slippageRisk).toBeLessThan(0.9); // NOT the 0.95 thin-book value
    expect(d.action).toBe("ENTER_NOW");
    // A PRESENT null value WITH a fresh timestamp IS thin-book → SKIP (the real signal is preserved).
    const thin = decideEntry(entryInput({ expectedSlippageBps: src(null) }));
    expect(thin.action).toBe("SKIP");
  });

  // ── 2026-07-24 fix: decisionId collision across candidates sharing side+action ────────────────────
  // Root cause: decisionId used to be fourBrainDecisionId("entry", nowMs, `${side}:${action}`) — a pure
  // function of (nowMs, side, action) ONLY. Any two of the ~14-25 real candidates evaluated in one shadow
  // tick landing on the same side+action bucket (10 possible values) got a byte-identical decisionId even
  // though they were genuinely different candidates (different symbol/lane/targetEntry/stop). Confirmed
  // this caused REAL, PERMANENT, silent outcome loss: direction-entry-outcome-store.ts's
  // recordEntryOutcome() is idempotent per decisionId (a later candidate sharing the id is a silent
  // no-op returning false — never pushed, never aggregated), and direction-entry-reconciler.ts
  // unconditionally adds every processed row's decisionId to its removal set regardless of whether
  // recordEntryOutcome actually booked it, so four-brain-outcome-ledger.ts's removeEntryByIds() evicts
  // BOTH colliding pending rows in one pass — the losing candidate's outcome is discarded forever, not
  // merely delayed. entry-brain-tier1-realized-resolver.ts's consumedDecisionIds set (also keyed purely
  // by decisionId) compounds this: once ANY candidate sharing a colliding id claims one real close, every
  // OTHER candidate sharing that id can never claim a DIFFERENT real close either — even its own exact
  // lane/symbol match — starving that lane/symbol combo of Tier 1 coverage permanently.
  describe("decisionId collision fix (candidateKey salt)", () => {
    it("two candidates with the SAME side+action but DIFFERENT candidateKey get DIFFERENT decisionIds", () => {
      const a = decideEntry(entryInput({ side: "SHORT", signalAgeMs: 90 * MIN, candidateKey: "COMPOSITE_ESTIMATOR_BIDI_WIDE_SHORT::BNBUSDT::SHORT::sig-1" })); // SKIP via stale signal
      const b = decideEntry(entryInput({ side: "SHORT", signalAgeMs: 90 * MIN, candidateKey: "REGIME_COMPOSITE_CONFIRMATION_SHORT::ETHUSDT::SHORT::sig-2" }));
      expect(a.action).toBe("SKIP");
      expect(b.action).toBe("SKIP"); // same side+action bucket as `a` — would have collided pre-fix
      expect(a.decisionId).not.toBe(b.decisionId);
    });

    it("without a candidateKey (caller omits it), the pre-fix collision across same side+action still reproduces — proves the fix is opt-in via the new field, not a behavior change for un-migrated callers", () => {
      const a = decideEntry(entryInput({ side: "SHORT", signalAgeMs: 90 * MIN }));
      const b = decideEntry(entryInput({ side: "SHORT", signalAgeMs: 90 * MIN, targetEntry: 250, initialStopPrice: 240 })); // genuinely different candidate geometry
      expect(a.action).toBe("SKIP");
      expect(b.action).toBe("SKIP");
      expect(a.decisionId).toBe(b.decisionId); // the exact bug this task fixes, absent the salt
    });

    it("the SAME candidate re-decided at the same asOfMs (e.g. immediately after a crash-restart) still yields the SAME decisionId — crash-restart idempotency is preserved", () => {
      const opts = { side: "LONG" as const, candidateKey: "CG_WIDE_FAST_LONG::BTCUSDT::LONG::sig-9" };
      const first = decideEntry(entryInput(opts));
      const second = decideEntry(entryInput(opts));
      expect(first.decisionId).toBe(second.decisionId);
      expect(first.action).toBe(second.action);
    });

    it("an empty-string candidateKey falls back to the no-salt key (never fabricates a distinct id from an empty string)", () => {
      const withEmpty = decideEntry(entryInput({ side: "SHORT", signalAgeMs: 90 * MIN, candidateKey: "" }));
      const withoutField = decideEntry(entryInput({ side: "SHORT", signalAgeMs: 90 * MIN }));
      expect(withEmpty.decisionId).toBe(withoutField.decisionId);
    });

    it("candidateKey never changes the decision's substantive action/fields — only decisionId", () => {
      const base = entryInput({ candleExtensionAtr: src(3.5), distanceFromVwapAtr: src(3.0), pullbackDepthAtr: src(0) });
      const withSalt = decideEntry({ ...base, candidateKey: "SOME_LANE::SOLUSDT::LONG::sig-7" });
      const withoutSalt = decideEntry(base);
      expect(withSalt.action).toBe(withoutSalt.action);
      expect(withSalt.chaseRisk).toBe(withoutSalt.chaseRisk);
      expect(withSalt.decisionId).not.toBe(withoutSalt.decisionId);
    });
  });
});
