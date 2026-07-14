import { describe, it, expect } from "vitest";
import { simulateTrade, evaluateEntryActions, evaluateExitActions, aggregateEntry, type PathCandle, type EntryParams, type ExitParams } from "../src/lib/entry-exit-counterfactual.js";

const c = (o: number, h: number, l: number, cl: number, t = 0): PathCandle => ({ openTime: t, open: o, high: h, low: l, close: cl });
const P = { direction: "LONG" as const, riskDistance: 2, horizonBars: 3, costRoundTripR: 0.05 };

describe("counterfactual trade simulator — causal + conservative intrabar", () => {
  it("a clean LONG winner: netR = grossR − cost, mfe tracked, not stopped", () => {
    const path = [c(100, 100, 100, 100), c(100, 101.5, 100.2, 101), c(101, 102.5, 101, 102)];
    const o = simulateTrade(path, 0, 100, { ...P, horizonBars: 2 });
    expect(o.stoppedOut).toBe(false);
    expect(o.grossR).toBeCloseTo(1.0); // (102−100)/2
    expect(o.netR).toBeCloseTo(0.95);
    expect(o.mfeR).toBeCloseTo(1.25); // high 102.5
    expect(o.timeToMfeBars).toBe(2);
  });
  it("CONSERVATIVE: a bar touching BOTH stop and target is a STOP + flagged AMBIGUOUS_INTRABAR", () => {
    const path = [c(100, 100, 100, 100), c(100, 102.5, 97.5, 98)]; // high hits +1.25R, low hits stop − ambiguous
    const o = simulateTrade(path, 0, 100, P);
    expect(o.stoppedOut).toBe(true);
    expect(o.grossR).toBe(-1);
    expect(o.netR).toBeCloseTo(-1.05); // cost applied EXACTLY once (−1 − 0.05)
    expect(o.ambiguousIntrabar).toBe(true); // both stop and ≥+1R favorable touched same bar
  });
  it("a stop bar that did NOT reach +1R favorable is NOT ambiguous", () => {
    const path = [c(100, 100, 100, 100), c(100, 100.5, 97.5, 98)]; // high only +0.25R, low hits stop
    expect(simulateTrade(path, 0, 100, P).ambiguousIntrabar).toBe(false);
  });
});

describe("entry actions", () => {
  it("WAIT_PULLBACK enters cheaper than ENTER_NOW ⇒ negative chase cost", () => {
    // bar1 dips to 99 (pullback 0.5·risk = 1 ⇒ target 99), then recovers.
    const path = [c(100, 100, 100, 100), c(100, 100.2, 99, 99.5), c(99.5, 102, 99.5, 101.5), c(101.5, 103, 101, 102.5)];
    const params: EntryParams = { ...P, waitWindowBars: 3, pullbackFrac: 0.5, breakoutFrac: 0.5, confirmBars: 1 };
    const res = evaluateEntryActions(path, params);
    const now = res.find((r) => r.action === "ENTER_NOW")!;
    const pull = res.find((r) => r.action === "WAIT_PULLBACK")!;
    expect(now.chaseCostR).toBe(0);
    expect(pull.outcome.entered).toBe(true);
    expect(pull.outcome.entryPrice).toBeCloseTo(99);
    expect(pull.chaseCostR).toBeCloseTo(-0.5); // (99−100)/2
    const skip = res.find((r) => r.action === "SKIP")!;
    expect(skip.outcome.entered).toBe(false);
    expect(skip.opportunityCostR).toBe(now.outcome.netR); // records what ENTER_NOW would have earned
  });
  it("aggregateEntry summarizes enteredRate + mean metrics per action", () => {
    const path = [c(100, 100, 100, 100), c(100, 101.5, 100.2, 101), c(101, 102.5, 101, 102), c(102, 103, 101.5, 102.5)];
    const params: EntryParams = { ...P, waitWindowBars: 3, pullbackFrac: 0.5, breakoutFrac: 0.5, confirmBars: 1 };
    const agg = aggregateEntry([evaluateEntryActions(path, params), evaluateEntryActions(path, params)]);
    expect(agg.ENTER_NOW.n).toBe(2);
    expect(agg.ENTER_NOW.enteredRate).toBe(1);
    expect(agg.SKIP.enteredRate).toBe(0);
  });
});

describe("exit actions", () => {
  it("EXIT_NOW that dodges a later stop-out shows a positive avoidedLoss vs HOLD", () => {
    // rise to +0.5R at bar1, then crash through the stop by bar2 ⇒ HOLD is stopped, EXIT_NOW banked +0.45.
    const path = [c(100, 100, 100, 100), c(100, 101.2, 100, 101), c(101, 101, 95, 96), c(96, 96, 95, 95.5)];
    const params: ExitParams = { ...P, trailFrac: 0.75, tpR: 2 };
    const res = evaluateExitActions(path, params);
    const hold = res.find((r) => r.action === "HOLD")!;
    const now = res.find((r) => r.action === "EXIT_NOW")!;
    expect(hold.finalNetR).toBeCloseTo(-1.05); // stopped
    expect(now.finalNetR).toBeCloseTo(0.45); // exit at bar1 close 101
    expect(now.avoidedLossR!).toBeGreaterThan(1.4); // 0.45 − (−1.05)
    expect(hold.avoidedLossR).toBe(0);
  });
  it("TRAIL is CONSERVATIVE adverse-first: a bar's own high cannot arm a trail its own low then trips", () => {
    // LONG entry 100, risk 10, trailFrac 0.5. Bar1 high 108 arms peak=0.8 but its low(0R) must NOT exit;
    // Bar2 low 103 (0.3R) trips the armed trail (0.8−0.5=0.3). Correct exit = bar 2, NOT bar 1.
    const path = [c(100, 100, 100, 100), c(100, 108, 100, 107), c(107, 107, 103, 104), c(104, 104, 90, 92)];
    const params: ExitParams = { direction: "LONG", riskDistance: 10, horizonBars: 10, costRoundTripR: 0.05, trailFrac: 0.5, tpR: 2 };
    const trail = evaluateExitActions(path, params).find((r) => r.action === "TRAIL")!;
    expect(trail.exitBar).toBe(2); // NOT 1 (the favorable-first bug exited on bar 1)
    expect(trail.finalNetR).toBeCloseTo(0.25); // (0.8−0.5) − 0.05
  });
});
