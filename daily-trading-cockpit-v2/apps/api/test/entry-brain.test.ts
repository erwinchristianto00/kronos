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
});
