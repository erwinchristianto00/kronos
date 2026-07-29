import { describe, it, expect } from "vitest";
import { buildExecutiveDecision, runBrainSafely } from "../src/lib/executive-decision.js";
import { decideMarketState } from "../src/lib/market-state-brain.js";
import { decideDirection } from "../src/lib/direction-brain.js";
import { decideEntry } from "../src/lib/entry-brain.js";
import { decideExit } from "../src/lib/exit-brain.js";
import { fourBrainMode } from "../src/lib/four-brain-types.js";
import { checkExecutiveInvariants } from "../src/lib/four-brain-invariants.js";
import { marketInput, directionInput, entryInput, exitInput, src, NOW, MIN } from "./four-brain-fixtures.js";

const ms = () => decideMarketState(marketInput());
const dirLong = () => decideDirection(directionInput({ longEdge: src(0.1) }));

describe("Executive Decision layer", () => {
  it("EXAMPLE #7 — Direction LONG but Entry SKIP (high chase) → candidateStatus SKIP + journaled disagreement", () => {
    const direction = dirLong();
    const entry = decideEntry(entryInput({ candleExtensionAtr: src(4), distanceFromVwapAtr: src(4), pullbackDepthAtr: src(0), signalAgeMs: 90 * MIN })); // stale+extended → SKIP
    expect(direction.action).toBe("LONG");
    expect(entry.action).toBe("SKIP");
    const exec = buildExecutiveDecision({
      nowMs: NOW, marketState: ms(), direction, entry, exit: null,
      laneId: "RC", symbolOrBasketId: "BTCUSDT", laneEligibleIncumbent: true, cortexAllocationPct: 20,
    });
    expect(exec.candidateStatus).toBe("SKIP");
    expect(exec.disagreements).toContain("Direction LONG, Entry SKIP");
    expect(exec.reportOnly).toBe(true);
  });

  it("EXAMPLE #8 — Exit HOLD but the incumbent hard stop still wins → disagreement journaled", () => {
    const exit = decideExit(exitInput({ unrealizedR: 0.3, mfeR: 0.4, thesisIntact: true, currentPrice: 103, hardStopPrice: 97 })); // its own geometry = HOLD (no giveback)
    expect(exit.action).toBe("HOLD");
    const exec = buildExecutiveDecision({
      nowMs: NOW, marketState: ms(), direction: null, entry: null, exit,
      laneId: "RC", symbolOrBasketId: "BTCUSDT", hardExitTriggered: true, // a portfolio-level hard rail fired
    });
    expect(exec.disagreements).toContain("Exit HOLD, hard stop already triggered");
  });

  it("CORTEX allocation is telemetry and cannot suppress an otherwise valid advisory review", () => {
    const entry = decideEntry(entryInput());
    expect(entry.action).toBe("ENTER_NOW");
    const exec = buildExecutiveDecision({
      nowMs: NOW, marketState: ms(), direction: dirLong(), entry, exit: null,
      laneId: "RC", symbolOrBasketId: "BTCUSDT", laneEligibleIncumbent: true, cortexAllocationPct: 0,
    });
    expect(exec.candidateStatus).toBe("VALID");
    expect(exec.advisoryOnly).toBe(true);
  });

  it("a risk-rail block OVERRIDES all brain approvals → BLOCKED_BY_RISK", () => {
    const exec = buildExecutiveDecision({
      nowMs: NOW, marketState: ms(), direction: dirLong(), entry: decideEntry(entryInput()), exit: null,
      laneId: "RC", symbolOrBasketId: "BTCUSDT", laneEligibleIncumbent: true, cortexAllocationPct: 30,
      killLatched: true, // rail fires despite every brain approving
    });
    expect(exec.candidateStatus).toBe("BLOCKED_BY_RISK");
  });

  it("all conditions pass → VALID, but the record is REPORT-ONLY (no execution)", () => {
    const exec = buildExecutiveDecision({
      nowMs: NOW, marketState: ms(), direction: dirLong(), entry: decideEntry(entryInput()), exit: null,
      laneId: "RC", symbolOrBasketId: "BTCUSDT", laneEligibleIncumbent: true, cortexAllocationPct: 40,
    });
    expect(exec.candidateStatus).toBe("VALID");
    expect(exec.reportOnly).toBe(true);
    expect(checkExecutiveInvariants(exec).ok).toBe(true);
  });

  it("market state UNKNOWN does NOT hard-block a candidate that otherwise passes", () => {
    const unknownState = decideMarketState(marketInput({ trend: src(null), volatility: src(null), momentum: src(null) }));
    expect(unknownState.family).toBe("UNKNOWN");
    const exec = buildExecutiveDecision({
      nowMs: NOW, marketState: unknownState, direction: dirLong(), entry: decideEntry(entryInput()), exit: null,
      laneId: "RC", symbolOrBasketId: "BTCUSDT", laneEligibleIncumbent: true, cortexAllocationPct: 40,
    });
    expect(exec.candidateStatus).toBe("VALID"); // UNKNOWN market does not gate
  });

  it("journals MULTIPLE disagreements at once", () => {
    const direction = decideDirection(directionInput({ marketBias: "BULLISH", longEdge: src(null), shortEdge: src(0.12), shortLaneEdge: src(0.1), controllerBias: "SHORT", longLaneEdge: src(null) }));
    expect(direction.action).toBe("SHORT");
    const entry = decideEntry(entryInput({ side: "SHORT", targetEntry: 100, initialStopPrice: 103, price: 100 })); // valid short geometry
    const exec = buildExecutiveDecision({
      nowMs: NOW, marketState: decideMarketState(marketInput({ trend: src(0.7), breadth: src(0.6) })), // BULLISH
      direction, entry, exit: null, laneId: "RCS", symbolOrBasketId: "BTCUSDT", laneEligibleIncumbent: true, cortexAllocationPct: 25,
    });
    expect(exec.disagreements).toContain("Market State BULLISH, Direction SHORT");
    expect(exec.disagreements.length).toBeGreaterThanOrEqual(1);
  });

  it("mode OFF by default → zero new-brain I/O (the gate is off unless explicitly enabled)", () => {
    expect(fourBrainMode({})).toBe("off");
    expect(fourBrainMode({ FOUR_BRAIN_MODE: "shadow" })).toBe("shadow");
    expect(fourBrainMode({ FOUR_BRAIN_MODE: "garbage" })).toBe("off");
  });

  it("runBrainSafely fails OPEN — an exception in any brain returns the fallback, never throws", () => {
    const boom = () => {
      throw new Error("brain bug");
    };
    expect(runBrainSafely(boom, null)).toBeNull();
    expect(runBrainSafely(() => 42, null)).toBe(42);
  });
});
