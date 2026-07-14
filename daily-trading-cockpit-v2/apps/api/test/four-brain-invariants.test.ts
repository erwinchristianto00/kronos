import { describe, it, expect } from "vitest";
import {
  checkDirectionInvariants,
  checkEntryInvariants,
  checkExitInvariants,
  checkMarketStateInvariants,
} from "../src/lib/four-brain-invariants.js";
import { decideMarketState } from "../src/lib/market-state-brain.js";
import { decideDirection } from "../src/lib/direction-brain.js";
import { decideEntry } from "../src/lib/entry-brain.js";
import { decideExit } from "../src/lib/exit-brain.js";
import { marketInput, directionInput, entryInput, exitInput, src, NOW, MIN } from "./four-brain-fixtures.js";
import type { EntryDecision, ExitDecision } from "../src/lib/four-brain-types.js";

describe("Four-Brain invariants", () => {
  it("clean decisions from every brain satisfy their invariants", () => {
    expect(checkMarketStateInvariants(decideMarketState(marketInput())).ok).toBe(true);
    expect(checkDirectionInvariants(decideDirection(directionInput())).ok).toBe(true);
    expect(checkEntryInvariants(decideEntry(entryInput()), { signalFresh: true }).ok).toBe(true);
    expect(checkExitInvariants(decideExit(exitInput()), { side: "LONG", hardStopPrice: 97 }).ok).toBe(true);
  });

  it("catches validUntil < asOf", () => {
    const d = decideMarketState(marketInput());
    const broken = { ...d, validUntilMs: d.asOfMs - 1 };
    expect(checkMarketStateInvariants(broken).ok).toBe(false);
  });

  it("catches a probability out of 0..1", () => {
    const d = decideDirection(directionInput());
    expect(checkDirectionInvariants({ ...d, longScore: 1.5 }).ok).toBe(false);
    expect(checkDirectionInvariants({ ...d, confidence: -0.1 }).ok).toBe(false);
  });

  it("catches a hand-crafted ENTER_NOW on a stale signal", () => {
    const d: EntryDecision = { ...decideEntry(entryInput()), action: "ENTER_NOW" };
    expect(checkEntryInvariants(d, { signalFresh: false }).ok).toBe(false);
  });

  it("catches a suggestedStop that WIDENS the hard stop (LONG)", () => {
    const d: ExitDecision = { ...decideExit(exitInput()), action: "TIGHTEN_STOP", suggestedStop: 90 }; // below hard stop 97 = looser
    expect(checkExitInvariants(d, { side: "LONG", hardStopPrice: 97 }).ok).toBe(false);
  });

  it("catches exitFraction out of 0..1 and a negative trail distance", () => {
    const d = decideExit(exitInput());
    expect(checkExitInvariants({ ...d, exitFraction: 1.2 }).ok).toBe(false);
    expect(checkExitInvariants({ ...d, suggestedTrailDistance: -5 }).ok).toBe(false);
  });

  it("catches a HOLD while a hard exit already triggered", () => {
    const d: ExitDecision = { ...decideExit(exitInput()), action: "HOLD" };
    expect(checkExitInvariants(d, { hardExitTriggered: true }).ok).toBe(false);
  });

  it("every numeric output is finite-or-null across many fuzzed-ish inputs", () => {
    for (let i = 0; i < 20; i += 1) {
      const t = (i - 10) / 10;
      const d = decideMarketState(marketInput({ trend: src(t), volatility: src(Math.abs(t)), momentum: src(-t), eventRisk: src(Math.abs(t)) }));
      for (const v of Object.values(d.components)) expect(v === null || Number.isFinite(v)).toBe(true);
      expect(Number.isFinite(d.transitionRisk) && d.transitionRisk >= 0 && d.transitionRisk <= 1).toBe(true);
      expect(Number.isFinite(d.confidence) && d.confidence >= 0 && d.confidence <= 1).toBe(true);
      const e = decideEntry(entryInput({ candleExtensionAtr: src(t * 5), expectedSlippageBps: src(Math.abs(t) * 50) }));
      expect(Number.isFinite(e.chaseRisk) && e.chaseRisk >= 0 && e.chaseRisk <= 1).toBe(true);
      expect(Number.isFinite(e.slippageRisk) && e.slippageRisk >= 0 && e.slippageRisk <= 1).toBe(true);
    }
  });

  it("future timestamps never enter any brain's numeric output", () => {
    const d = decideMarketState(marketInput({ trend: { value: 5, asOfMs: NOW + 5 * MIN }, volatility: { value: 9, asOfMs: NOW + MIN } }));
    for (const v of Object.values(d.components)) expect(v === null || Number.isFinite(v)).toBe(true);
    expect(d.sourceStatuses.trend).toBe("ERROR");
  });
});
