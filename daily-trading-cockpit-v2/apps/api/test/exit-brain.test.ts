import { describe, it, expect } from "vitest";
import { decideExit } from "../src/lib/exit-brain.js";
import { checkExitInvariants } from "../src/lib/four-brain-invariants.js";
import { exitInput } from "./four-brain-fixtures.js";

describe("Exit Brain", () => {
  it("the hard stop OUTRANKS a would-be HOLD (breached hard stop → EXIT_NOW)", () => {
    // A clean position that would HOLD, but price has already breached the hard stop.
    const d = decideExit(exitInput({ currentPrice: 96.5, hardStopPrice: 97 })); // long, price below stop
    expect(d.action).toBe("EXIT_NOW");
    expect(d.exitFraction).toBe(1);
    // invariant: hard-exit-triggered must not HOLD
    expect(checkExitInvariants(d, { side: "LONG", hardStopPrice: 97, hardExitTriggered: true }).ok).toBe(true);
  });

  it("the kill switch OUTRANKS everything (killLatched → EXIT_NOW)", () => {
    const d = decideExit(exitInput({ killLatched: true, momentumDecay: false, thesisIntact: true }));
    expect(d.action).toBe("EXIT_NOW");
  });

  it("Exit Brain NEVER widens the hard stop (suggestedStop stays protective)", () => {
    const d = decideExit(exitInput({ unrealizedR: 0.6, momentumDecay: true, divergence: true })); // → MOVE_TO_BREAKEVEN/TIGHTEN
    if (d.suggestedStop != null) {
      expect(d.suggestedStop).toBeGreaterThanOrEqual(97); // never below the incumbent hard stop for a LONG
    }
    expect(checkExitInvariants(d, { side: "LONG", hardStopPrice: 97 }).ok).toBe(true);
  });

  it("high giveback risk can produce SCALE_OUT or TRAIL", () => {
    const d = decideExit(exitInput({ mfeR: 2.0, unrealizedR: 0.6, structureBreak: true, divergence: true }));
    expect(["SCALE_OUT", "TRAIL", "TIGHTEN_STOP"]).toContain(d.action);
    expect(d.reasons.some((r) => r.toLowerCase().includes("giveback"))).toBe(true);
  });

  it("strong remaining edge + intact thesis → HOLD", () => {
    const d = decideExit(exitInput({ unrealizedR: 0.3, mfeR: 0.4, thesisIntact: true, momentumDecay: false, divergence: false, structureBreak: false, orderFlowReversal: false }));
    expect(d.action).toBe("HOLD");
    expect(d.continuationProbability).toBeGreaterThan(0.6);
  });

  it("missing MFE/MAE never produces NaN", () => {
    const d = decideExit(exitInput({ mfeR: null, maeR: null, unrealizedR: null }));
    expect(d.edgeRemainingR === null || Number.isFinite(d.edgeRemainingR)).toBe(true);
    expect(Number.isFinite(d.reversalRisk)).toBe(true);
    expect(Number.isFinite(d.continuationProbability)).toBe(true);
    expect(Number.isFinite(d.exitFraction)).toBe(true);
    expect(checkExitInvariants(d).ok).toBe(true);
  });

  it("exitFraction is always within 0..1", () => {
    for (const o of [{}, { killLatched: true }, { mfeR: 3, unrealizedR: 0.5, divergence: true, structureBreak: true }, { unrealizedR: 5 }]) {
      const d = decideExit(exitInput(o));
      expect(d.exitFraction).toBeGreaterThanOrEqual(0);
      expect(d.exitFraction).toBeLessThanOrEqual(1);
    }
  });

  it("distinguishes premature-exit vs giveback vs remaining edge in its reasons", () => {
    const hold = decideExit(exitInput({ unrealizedR: 0.3, thesisIntact: true }));
    expect(hold.reasons.some((r) => r.includes("premature-exit") || r.includes("remaining edge"))).toBe(true);
  });

  it("review regression: a NaN currentPrice never leaks NaN into suggestedStop/suggestedTrailDistance", () => {
    // NaN mark price (fetch gap) with a TIGHTEN_STOP-selecting position; suggestedStop must be finite-or-null.
    const d = decideExit(exitInput({ currentPrice: Number.NaN, unrealizedR: 1.5, hardStopPrice: 90, momentumDecay: true, divergence: true }));
    expect(d.suggestedStop === null || Number.isFinite(d.suggestedStop)).toBe(true);
    expect(d.suggestedTrailDistance === null || Number.isFinite(d.suggestedTrailDistance)).toBe(true);
    const t = decideExit(exitInput({ currentPrice: Number.NaN, mfeR: 2, unrealizedR: 0.6, divergence: true })); // → TRAIL branch
    expect(t.suggestedTrailDistance === null || Number.isFinite(t.suggestedTrailDistance)).toBe(true);
  });

  // ── 2026-07-24 defensive-hygiene fix: decisionId collision across candidates sharing side+action ──────
  // Mirrors the Entry Brain fix exactly (see entry-brain.ts / entry-brain.test.ts). Root cause: decisionId
  // used to be fourBrainDecisionId("exit", nowMs, `${side}:${action}`) — a pure function of (nowMs, side,
  // action) ONLY. Verified empirically (2026-07-24) against real testnet journal data: 85.5% of exit
  // candidates within a tick collide on this decisionId (one tick had 9 candidates across 9 different
  // symbols, 8 of which shared the exact same id), even though they are genuinely different decisions
  // (different position/symbol/lane). Confirmed CURRENTLY HARMLESS: no Exit-outcome ledger/reconciler
  // analogous to direction-entry-outcome-store.ts exists yet, and the real Exit Brain shadow-counterfactual
  // store (exit-brain-shadow.ts) already dedupes on a separate, already-unique `sp:${positionId}:${variant}`
  // key. Fixed preventively so a FUTURE Exit-outcome ledger built the same way Entry's was doesn't inherit
  // the identical silent-loss bug (recordOutcome-style idempotent-per-decisionId store discarding a
  // colliding candidate's outcome forever, per the Entry Brain incident this mirrors).
  describe("decisionId collision fix (candidateKey salt)", () => {
    it("two candidates with the SAME side+action but DIFFERENT candidateKey get DIFFERENT decisionIds", () => {
      const a = decideExit(exitInput({ candidateKey: "CG_WIDE_FAST_LONG::BTCUSDT::LONG::pos-1" })); // HOLD (clean fixture)
      const b = decideExit(exitInput({ candidateKey: "CG_WIDE_TREND::ETHUSDT::LONG::pos-2" }));
      expect(a.action).toBe("HOLD");
      expect(b.action).toBe("HOLD"); // same side+action bucket as `a` — would have collided pre-fix
      expect(a.decisionId).not.toBe(b.decisionId);
    });

    it("without a candidateKey (caller omits it), the pre-fix collision across same side+action still reproduces — proves the fix is opt-in via the new field, not a behavior change for un-migrated callers", () => {
      const a = decideExit(exitInput()); // HOLD
      const b = decideExit(exitInput({ entryPrice: 250, currentPrice: 255, hardStopPrice: 240 })); // genuinely different position, same HOLD bucket
      expect(a.action).toBe("HOLD");
      expect(b.action).toBe("HOLD");
      expect(a.decisionId).toBe(b.decisionId); // the exact bug this task fixes, absent the salt
    });

    it("the SAME candidate re-decided at the same asOfMs (e.g. immediately after a crash-restart) still yields the SAME decisionId — crash-restart idempotency is preserved", () => {
      const opts = { candidateKey: "CG_WIDE_FAST_LONG::BTCUSDT::LONG::pos-9" };
      const first = decideExit(exitInput(opts));
      const second = decideExit(exitInput(opts));
      expect(first.decisionId).toBe(second.decisionId);
      expect(first.action).toBe(second.action);
    });

    it("an empty-string candidateKey falls back to the no-salt key (never fabricates a distinct id from an empty string)", () => {
      const withEmpty = decideExit(exitInput({ candidateKey: "" }));
      const withoutField = decideExit(exitInput());
      expect(withEmpty.decisionId).toBe(withoutField.decisionId);
    });

    it("candidateKey never changes the decision's substantive action/fields — only decisionId", () => {
      const base = exitInput({ mfeR: 2.0, unrealizedR: 0.6, structureBreak: true, divergence: true }); // giveback branch
      const withSalt = decideExit({ ...base, candidateKey: "SOME_LANE::SOLUSDT::LONG::pos-7" });
      const withoutSalt = decideExit(base);
      expect(withSalt.action).toBe(withoutSalt.action);
      expect(withSalt.exitFraction).toBe(withoutSalt.exitFraction);
      expect(withSalt.reversalRisk).toBe(withoutSalt.reversalRisk);
      expect(withSalt.decisionId).not.toBe(withoutSalt.decisionId);
    });
  });
});
