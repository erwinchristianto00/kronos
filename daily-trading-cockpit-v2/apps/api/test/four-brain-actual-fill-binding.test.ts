import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutiveDecision } from "../src/lib/four-brain-types.js";
import {
  fourBrainActualFillBindingFilePath,
  FourBrainActualFillBindingStore,
} from "../src/lib/four-brain-actual-fill-binding.js";
import { DirectionEntryOutcomeStore } from "../src/lib/direction-entry-outcome-store.js";
import {
  runDirectionEntryReconciliationCycle,
  type OutcomeLedgerLike,
} from "../src/lib/direction-entry-reconciler.js";
import type { PendingEntryRow } from "../src/lib/four-brain-outcome-ledger.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-four-brain-actual-fill-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

function executive(overrides: Partial<Record<string, unknown>> = {}): ExecutiveDecision {
  return {
    decisionId: "exec-exact-1",
    asOfMs: NOW,
    candidateStatus: "VALID",
    laneId: "CROSS_SECTIONAL_DIRECTIONAL_LONG",
    symbolOrBasketId: "ETHUSDT",
    entry: {
      action: "ENTER_NOW",
      side: "LONG",
      validUntilMs: NOW + 5 * 60_000,
      expectedNetR: 0.18,
    },
    marketState: {
      authority: {
        canonicalRegimeFamily: "BULLISH",
        scannerRegime: "BULLISH_EXPANSION",
      },
    },
    marketContext: { snapshotId: "canonical-snapshot-1" },
    ...overrides,
  } as unknown as ExecutiveDecision;
}

function bindingInput() {
  return {
    bindingKey: "directional:ETHUSDT:one",
    source: "SINGLE_SYMBOL" as const,
    laneId: "CROSS_SECTIONAL_DIRECTIONAL_LONG",
    symbol: "ETHUSDT",
    side: "LONG" as const,
    signalId: "scan-1",
    openedAtMs: NOW + 30_000,
    entryPrice: 2_000,
    entryPriceConfirmed: true,
    riskUsd: 10,
  };
}

describe("Four-Brain actual-fill binding", () => {
  it("preserves a v1 candidate as legacy audit without promoting it into the new exact cohort", () => {
    const dataDir = tmp();
    writeFileSync(fourBrainActualFillBindingFilePath(dataDir), JSON.stringify({
      version: 1,
      candidates: [{
        decisionId: "legacy-decision",
        asOfMs: NOW,
        validUntilMs: NOW + 5 * 60_000,
        laneId: "CROSS_SECTIONAL_DIRECTIONAL_LONG",
        symbol: "ETHUSDT",
        side: "LONG",
        signalId: "legacy-scan",
        expectedNetR: 0.18,
        canonicalRegimeFamily: "BULLISH",
        scannerRegime: "BULLISH_EXPANSION",
        marketContextSnapshotId: "legacy-context",
      }],
      bindings: [],
    }));

    const binding = new FourBrainActualFillBindingStore(dataDir);
    expect(binding.getStatus()).toMatchObject({
      candidates: 0,
      entryAdmission: { observed: 0, exactCandidatesRecorded: 0 },
    });
  });

  it("does not retrospectively convert a historical unbound fill into executor-observed evidence", () => {
    const dataDir = tmp();
    writeFileSync(fourBrainActualFillBindingFilePath(dataDir), JSON.stringify({
      version: 2,
      candidates: [],
      bindings: [{
        bindingKey: "old-unbound",
        source: "SINGLE_SYMBOL",
        laneId: "CROSS_SECTIONAL_DIRECTIONAL_LONG",
        symbol: "ETHUSDT",
        side: "LONG",
        signalId: "old-scan",
        openedAtMs: NOW,
        entryPrice: 2_000,
        entryPriceConfirmed: true,
        riskUsd: 10,
        decision: null,
        status: "UNBOUND",
        closedAtMs: null,
        realizedNetR: null,
        closeSettlementConfirmed: null,
        terminalReason: "NO_EXACT_EXECUTIVE_ENTER_NOW_AT_FILL",
      }],
      entryAdmissionAudit: {},
    }));

    const binding = new FourBrainActualFillBindingStore(dataDir);
    expect(binding.getStatus()).toMatchObject({
      candidates: 0, open: 0, measured: 0, unmeasured: 0, unbound: 1,
      executorObserved: { candidates: 0, open: 0, measured: 0, unmeasured: 0 },
    });
    expect(binding.listClosedMeasuredOutcomes()).toEqual([]);
    expect(binding.listClosedObservedExecutorOutcomes()).toEqual([]);
  });

  it("keeps pre-repair unbound fills audit-only while a new cohort still fails closed on a new unbound fill", () => {
    const binding = new FourBrainActualFillBindingStore(tmp());
    binding.bindActualFill({ ...bindingInput(), bindingKey: "old-unbound", openedAtMs: NOW });
    binding.bindActualFill({ ...bindingInput(), bindingKey: "new-unbound", openedAtMs: NOW + 10_000 });

    expect(binding.getStatus({ sinceMs: NOW + 5_000 })).toMatchObject({
      unbound: 1,
      auditOnlyBeforeCohort: { bindings: 1, unbound: 1, lastUnboundAtMs: NOW },
      cohortSinceMs: NOW + 5_000,
    });
  });

  it("binds only the same VALID ENTER_NOW signal and resolves settled net-R exactly once", () => {
    const binding = new FourBrainActualFillBindingStore(tmp());
    binding.observeExecutiveDecision(executive(), { signalId: "scan-1" }, { source: "PRE_ENTRY_EXECUTOR" });
    binding.bindActualFill(bindingInput());
    expect(binding.getStatus()).toMatchObject({
      candidates: 1, open: 1, measured: 0, unmeasured: 0, unbound: 0,
      executorObserved: { candidates: 0, open: 0, measured: 0, unmeasured: 0 },
      preEntryAdmission: { observed: 1, enterNow: 1, validEnterNow: 1, exactCandidatesRecorded: 1 },
    });

    binding.completeActualFill({
      bindingKey: "directional:ETHUSDT:one",
      closedAtMs: NOW + 60 * 60_000,
      netPnlUsd: 2.5,
      settlementConfirmed: true,
      reason: "TP",
    });
    // Idempotency is intentional: a later lifecycle sweep must not alter the first settled outcome.
    binding.completeActualFill({
      bindingKey: "directional:ETHUSDT:one",
      closedAtMs: NOW + 70 * 60_000,
      netPnlUsd: -9,
      settlementConfirmed: true,
      reason: "late duplicate",
    });

    expect(binding.getStatus()).toMatchObject({
      candidates: 1, open: 0, measured: 1, unmeasured: 0, unbound: 0,
      executorObserved: { candidates: 0, open: 0, measured: 0, unmeasured: 0 },
      preEntryAdmission: { observed: 1, enterNow: 1, validEnterNow: 1, exactCandidatesRecorded: 1 },
    });
    expect(binding.listClosedMeasuredOutcomes()).toEqual([
      expect.objectContaining({
        decisionId: "exec-exact-1",
        laneId: "CROSS_SECTIONAL_DIRECTIONAL_LONG",
        symbolOrBasketId: "ETHUSDT",
        side: "LONG",
        realizedNetR: 0.25,
        matchedCloseKey: "actual-fill:directional:ETHUSDT:one:1800000030000",
      }),
    ]);
  });

  it("keeps an incumbent-only ENTER_NOW fill in the executor-observed cohort, not Four-Brain direct", () => {
    const binding = new FourBrainActualFillBindingStore(tmp());
    binding.observeExecutiveDecision(executive({ candidateStatus: "INCUMBENT_ONLY" }), { signalId: "scan-1" });
    binding.bindActualFill(bindingInput());
    expect(binding.getStatus()).toMatchObject({
      candidates: 0, open: 0, measured: 0, unmeasured: 0, unbound: 0,
      executorObserved: { candidates: 1, open: 1, measured: 0, unmeasured: 0 },
      entryAdmission: { observed: 1, enterNow: 1, validEnterNow: 0, exactCandidatesRecorded: 0 },
    });
    expect(binding.listClosedMeasuredOutcomes()).toEqual([]);
  });

  it("records a pre-fill WAIT decision against an executor fill without feeding the direct cohort", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW + 1_000);
    const binding = new FourBrainActualFillBindingStore(tmp());
    binding.observeExecutiveDecision(executive({
      decisionId: "exec-wait-observed",
      entry: {
        action: "WAIT_CONFIRMATION",
        side: "LONG",
        validUntilMs: NOW + 5 * 60_000,
        expectedNetR: 0.11,
      },
      candidateStatus: "WAIT",
    }), { signalId: "scan-1" });
    binding.bindActualFill(bindingInput());
    expect(binding.getStatus()).toMatchObject({
      candidates: 0, open: 0, measured: 0, unmeasured: 0, unbound: 0,
      executorObserved: {
        candidates: 1, open: 1, measured: 0, unmeasured: 0,
        byEntryAction: { WAIT_CONFIRMATION: 1 },
      },
    });

    binding.completeActualFill({
      bindingKey: "directional:ETHUSDT:one",
      closedAtMs: NOW + 60 * 60_000,
      netPnlUsd: 2.5,
      settlementConfirmed: true,
    });
    expect(binding.listClosedMeasuredOutcomes()).toEqual([]);
    expect(binding.listClosedObservedExecutorOutcomes()).toEqual([
      expect.objectContaining({
        decisionId: "exec-wait-observed",
        action: "WAIT_CONFIRMATION",
        candidateStatus: "WAIT",
        realizedNetR: 0.25,
      }),
    ]);
  });

  it("never binds a decision recorded after the actual fill", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW + 60_000);
    const binding = new FourBrainActualFillBindingStore(tmp());
    binding.observeExecutiveDecision(executive({
      decisionId: "exec-too-late",
      entry: {
        action: "WAIT_CONFIRMATION",
        side: "LONG",
        validUntilMs: NOW + 5 * 60_000,
        expectedNetR: 0.11,
      },
      candidateStatus: "WAIT",
    }), { signalId: "scan-1" });
    binding.bindActualFill(bindingInput());
    expect(binding.getStatus()).toMatchObject({
      candidates: 0, open: 0, measured: 0, unmeasured: 0, unbound: 1,
      executorObserved: { candidates: 1, open: 0, measured: 0, unmeasured: 0 },
    });
  });

  it("separates WAIT/SKIP and a valid entry without identity from an exact recorded candidate", () => {
    const binding = new FourBrainActualFillBindingStore(tmp());
    binding.observeExecutiveDecision(executive({
      decisionId: "exec-wait",
      entry: { action: "WAIT_CONFIRMATION" },
      candidateStatus: "WAIT",
    }), { signalId: "scan-wait" });
    binding.observeExecutiveDecision(executive({
      decisionId: "exec-skip",
      entry: { action: "SKIP" },
      candidateStatus: "SKIP",
    }), { signalId: "scan-skip" });
    binding.observeExecutiveDecision(executive({ decisionId: "exec-missing-id" }), { signalId: null });
    // A duplicate journal/retry must not make the admission funnel look healthier than it is.
    binding.observeExecutiveDecision(executive({ decisionId: "exec-missing-id" }), { signalId: null });

    expect(binding.getStatus()).toMatchObject({
      candidates: 0,
      entryAdmission: {
        observed: 3,
        enterNow: 1,
        validEnterNow: 1,
        exactCandidatesRecorded: 0,
        waiting: 1,
        skipped: 1,
        missingSignalIdentity: 1,
        invalidCandidateMetadata: 1,
      },
    });
  });

  it("makes the direct exact exchange outcome win over the legacy window matcher", async () => {
    const binding = new FourBrainActualFillBindingStore(tmp());
    binding.observeExecutiveDecision(executive(), { signalId: "scan-1" }, { source: "PRE_ENTRY_EXECUTOR" });
    binding.bindActualFill(bindingInput());
    binding.completeActualFill({
      bindingKey: "directional:ETHUSDT:one",
      closedAtMs: NOW + 60 * 60_000,
      netPnlUsd: 2.5,
      settlementConfirmed: true,
    });

    const pending: PendingEntryRow = {
      decisionId: "exec-exact-1",
      asOfMs: NOW,
      laneId: "CROSS_SECTIONAL_DIRECTIONAL_LONG",
      symbolOrBasketId: "ETHUSDT",
      side: "LONG",
      action: "ENTER_NOW",
      targetEntry: 2_000,
      initialStopPrice: 1_990,
      expectedNetR: 0.18,
      canonicalRegimeFamily: "BULLISH",
      scannerRegime: "BULLISH_EXPANSION",
      marketContextSnapshotId: "canonical-snapshot-1",
    };
    let entries = [pending];
    const ledger: OutcomeLedgerLike = {
      getPendingDirectionRows: () => [],
      getPendingEntryRows: () => entries,
      removeDirectionByIds: () => {},
      removeEntryByIds: (ids) => { entries = entries.filter((row) => !ids.has(row.decisionId)); },
    };
    const outcomes = new DirectionEntryOutcomeStore(tmp());
    const result = await runDirectionEntryReconciliationCycle({
      ledger,
      store: outcomes,
      listClosedPositionPaths: () => [],
      fetchDirectionCandles: async () => null,
      fetchEntryTier2Candles: async () => null,
      actualFillBindings: binding,
      now: () => NOW + 2 * 60 * 60_000,
    });

    expect(result.directActualFillProcessed).toBe(1);
    expect(entries).toHaveLength(0);
    expect(outcomes.getState().entry.records).toEqual([
      expect.objectContaining({
        decisionId: "exec-exact-1",
        tier: "TIER1_REALIZED",
        confidence: "MEASURED",
        realizedNetR: 0.25,
        realizedRSource: "actual_fill_binding",
      }),
    ]);
  });
});
