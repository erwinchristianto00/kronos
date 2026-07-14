import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  UnifiedTestnetOrchestrator,
  UnifiedTestnetOrchestratorStore,
  isUnifiedTestnetOrchestratorEnabled,
  type UnifiedOrchestratorInput,
} from "../src/lib/unified-testnet-orchestrator.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function build(): UnifiedTestnetOrchestrator {
  const dir = mkdtempSync(join(tmpdir(), "unified-orchestrator-"));
  dirs.push(dir);
  return new UnifiedTestnetOrchestrator({
    enabled: true,
    store: new UnifiedTestnetOrchestratorStore(dir),
    confirmSamples: 2,
    choppySamples: 2,
  });
}

function input(id: string, direction: "LONG" | "SHORT" | "NEUTRAL"): UnifiedOrchestratorInput {
  return {
    sampleId: id,
    capturedAt: new Date(1_700_000_000_000 + Number(id.replace(/\D/g, "")) * 60_000).toISOString(),
    primaryDirection: direction,
    primaryConfidence: direction === "NEUTRAL" ? null : "MEDIUM",
    primaryReason: `controller ${direction}`,
    votes: [],
    neutralProposalAllowed: false,
    neutralProposalReason: "rolling edge unavailable",
  };
}

describe("UnifiedTestnetOrchestrator", () => {
  it("can only be enabled on testnet", () => {
    expect(isUnifiedTestnetOrchestratorEnabled({ UNIFIED_ORCHESTRATOR_ENABLED: "1" } as NodeJS.ProcessEnv, "testnet")).toBe(true);
    expect(isUnifiedTestnetOrchestratorEnabled({ UNIFIED_ORCHESTRATOR_ENABLED: "1" } as NodeJS.ProcessEnv, "mainnet")).toBe(false);
  });

  it("requires persistent confirmation before arming a direction", () => {
    const orchestrator = build();
    expect(orchestrator.update(input("1", "LONG")).brainState).toBe("FLAT");
    expect(orchestrator.update(input("2", "LONG")).brainState).toBe("LONG");
    expect(orchestrator.allowsPaperOrder({ selectedLaneId: "CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG", direction: "LONG" })).toBe(true);
    expect(orchestrator.allowsPaperOrder({ selectedLaneId: "CG_WIDE_FAST_SHORT", direction: "SHORT" })).toBe(false);
  });

  it("uses warning and flat handoff before reversing", () => {
    const orchestrator = build();
    orchestrator.update(input("1", "LONG"));
    orchestrator.update(input("2", "LONG"));
    expect(orchestrator.update(input("3", "SHORT")).brainState).toBe("LONG_WARNING");
    expect(orchestrator.update(input("4", "SHORT")).brainState).toBe("FLAT");
    expect(orchestrator.update(input("5", "SHORT")).brainState).toBe("SHORT");
  });

  it("locks directional entries in chop and only admits healthy neutral baskets", () => {
    const orchestrator = build();
    orchestrator.update(input("1", "NEUTRAL"));
    const locked = orchestrator.update({
      ...input("2", "NEUTRAL"),
      neutralProposalAllowed: true,
      neutralProposalReason: null,
    });
    expect(locked.brainState).toBe("CHOPPY_LOCK");
    expect(orchestrator.canOpenNewEntries()).toBe(true);
    expect(orchestrator.allowsCrossSectionalLane("CROSS_SECTIONAL_MARKET_NEUTRAL")).toBe(true);
    expect(orchestrator.allowsPaperOrder({ selectedLaneId: "CG_WIDE_FAST_LONG", direction: "LONG" })).toBe(false);
  });

  it("places every legacy single-symbol executor into manage-only", () => {
    const orchestrator = build();
    expect(orchestrator.allowsLegacySingleSymbolEntry("REGIME_COMPOSITE_CONFIRMATION_LONG", "LONG")).toBe(false);
    expect(orchestrator.getStatus().legacyExecutorEntryMode).toBe("MANAGE_ONLY");
  });

  it("banks an opposing after-cost winner and hard-cuts half-stop loss", () => {
    const orchestrator = build();
    orchestrator.update(input("1", "SHORT"));
    orchestrator.update(input("2", "SHORT"));
    expect(orchestrator.legacyExitDecision({
      direction: "LONG",
      entryPrice: 100,
      stopPrice: 96,
      currentPrice: 101,
      peakFavorableR: 0.4,
      msHeld: 1_000,
    }).reason).toBe("UNIFIED_REGIME_FLIP_BANK");
    expect(orchestrator.legacyExitDecision({
      direction: "LONG",
      entryPrice: 100,
      stopPrice: 96,
      currentPrice: 97.9,
      peakFavorableR: 0,
      msHeld: 1_000,
    }).reason).toBe("UNIFIED_REGIME_FLIP_HARD_CUT");
  });

  it("hard-vetoes an otherwise-confirming primary when a veto vote is present", () => {
    const orchestrator = build();
    // Two consecutive confirming LONG primaries normally arm LONG (see the confirmation test above).
    // A veto vote (e.g. REGIME_EDGE_MEMORY proving LONG net-negative in this regime) forces the
    // candidate to NEUTRAL on every sample, so the brain must never arm the direction. This locks in
    // the candidateFrom veto branch that was previously dead (no runtime source ever set veto:true).
    const vetoVote = {
      source: "REGIME_EDGE_MEMORY",
      direction: "LONG" as const,
      confidence: 1,
      veto: true,
      reason: 'LONG proven net-negative in "Bullish pressure" (EDGE_PROVEN_NEGATIVE)',
    };
    expect(orchestrator.update({ ...input("1", "LONG"), votes: [vetoVote] }).brainState).toBe("FLAT");
    const second = orchestrator.update({ ...input("2", "LONG"), votes: [vetoVote] });
    expect(second.brainState).not.toBe("LONG");
    expect(second.candidateDirection).toBe("NEUTRAL");
    expect(orchestrator.allowsPaperOrder({ selectedLaneId: "CG_WIDE_FAST_LONG", direction: "LONG" })).toBe(false);
  });
});
