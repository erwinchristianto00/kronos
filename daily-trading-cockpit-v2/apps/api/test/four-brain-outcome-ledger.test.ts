import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import {
  FourBrainOutcomeLedger,
  rehydrateFourBrainOutcomeLedgerFromJournals,
  wrapFourBrainJournalAppendForOutcomeLedger,
  extractPendingDirectionRow,
  extractPendingEntryRow,
  type PendingDirectionRow,
  type PendingEntryRow,
} from "../src/lib/four-brain-outcome-ledger.js";
import { DirectionEntryOutcomeStore } from "../src/lib/direction-entry-outcome-store.js";

function directionRow(n: number): PendingDirectionRow {
  return {
    decisionId: `dir-${n}`,
    asOfMs: n,
    horizon: "SCALP",
    action: "LONG",
    expectedDirectionalR: 0.1,
  };
}

function entryRow(n: number): PendingEntryRow {
  return {
    decisionId: `entry-${n}`,
    asOfMs: n,
    symbolOrBasketId: "BTCUSDT",
    laneId: "CG_WIDE_FAST_LONG",
    side: "LONG",
    action: "ENTER_NOW",
    targetEntry: 100,
    initialStopPrice: 95,
    expectedNetR: 0.2,
  };
}

function executiveRecord(opts: {
  decisionId: string;
  asOfMs: number;
  laneId?: string | null;
  symbolOrBasketId?: string | null;
  direction?: Record<string, unknown> | null;
  entry?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    kind: "EXECUTIVE_DECISION",
    asOfMs: opts.asOfMs,
    laneId: opts.laneId ?? "CG_WIDE_FAST_LONG",
    symbolOrBasketId: opts.symbolOrBasketId ?? "BTCUSDT",
    brains: {
      direction:
        opts.direction === undefined
          ? {
              decisionId: `${opts.decisionId}-dir`,
              asOfMs: opts.asOfMs,
              horizon: "SCALP",
              action: "LONG",
              expectedDirectionalR: 0.12,
            }
          : opts.direction,
      entry:
        opts.entry === undefined
          ? {
              decisionId: `${opts.decisionId}-entry`,
              asOfMs: opts.asOfMs,
              side: "LONG",
              action: "ENTER_NOW",
              targetEntry: 101,
              initialStopPrice: 96,
              expectedNetR: 0.18,
            }
          : opts.entry,
    },
  };
}

describe("FourBrainOutcomeLedger", () => {
  it("rehydrates unprocessed journal rows after restart and never rehydrates terminal outcomes", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "four-brain-rehydrate-"));
    try {
      const journal = join(dataDir, "four-brain-decision-journal.jsonl");
      writeFileSync(
        journal,
        `${JSON.stringify(executiveRecord({ decisionId: "restart", asOfMs: 1000 }))}\n`,
        "utf-8",
      );
      const store = new DirectionEntryOutcomeStore(dataDir);
      const firstLedger = new FourBrainOutcomeLedger();
      const first = rehydrateFourBrainOutcomeLedgerFromJournals({
        ledger: firstLedger,
        journalFiles: [journal],
        hasProcessedDirection: (id) => store.hasProcessedDirection(id),
        hasProcessedEntry: (id) => store.hasProcessedEntry(id),
      });
      expect(first.directionRehydrated).toBe(1);
      expect(first.entryRehydrated).toBe(1);
      expect(first.directionPendingRestored).toBe(1);
      expect(first.entryPendingRestored).toBe(1);
      expect(first.directionEvictedDuringRehydrate).toBe(0);
      expect(first.entryEvictedDuringRehydrate).toBe(0);

      store.recordDirectionOutcome({
        decisionId: "restart-dir",
        horizon: "SCALP",
        action: "LONG",
        asOfMs: 1000,
        status: "RESOLVED",
        chosenNetR: 0.1,
        win: 1,
        regretR: 0,
        calibrationGapR: 0,
      });
      store.recordEntryOutcome({
        decisionId: "restart-entry",
        tier: "TIER2_SIMULATED",
        laneId: "CG_WIDE_FAST_LONG",
        symbolOrBasketId: "BTCUSDT",
        side: "LONG",
        action: "ENTER_NOW",
        confidence: "MEASURED",
        asOfMs: 1000,
        status: "RESOLVED",
        expectedNetR: 0.18,
        realizedNetR: 0.1,
        realizedRSource: null,
        horizonTruncated: false,
        matchedCloseKey: null,
      });

      const restartedStore = new DirectionEntryOutcomeStore(dataDir);
      const restartedLedger = new FourBrainOutcomeLedger();
      const second = rehydrateFourBrainOutcomeLedgerFromJournals({
        ledger: restartedLedger,
        journalFiles: [journal],
        hasProcessedDirection: (id) => restartedStore.hasProcessedDirection(id),
        hasProcessedEntry: (id) => restartedStore.hasProcessedEntry(id),
      });
      expect(second.directionSkippedProcessed).toBe(1);
      expect(second.entrySkippedProcessed).toBe(1);
      expect(restartedLedger.directionSize).toBe(0);
      expect(restartedLedger.entrySize).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reports capacity loss explicitly so a deployment audit can refuse an unsafe restart", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "four-brain-rehydrate-capacity-"));
    try {
      const journal = join(dataDir, "four-brain-decision-journal.jsonl");
      writeFileSync(
        journal,
        [1, 2, 3].map((n) => JSON.stringify(executiveRecord({ decisionId: `cap-${n}`, asOfMs: n * 1000 }))).join("\n"),
        "utf-8",
      );
      const ledger = new FourBrainOutcomeLedger({ directionCapacity: 2, entryCapacity: 2 });
      const result = rehydrateFourBrainOutcomeLedgerFromJournals({
        ledger,
        journalFiles: [journal],
        hasProcessedDirection: () => false,
        hasProcessedEntry: () => false,
      });
      expect(result.directionEligibleUnprocessed).toBe(3);
      expect(result.entryEligibleUnprocessed).toBe(3);
      expect(result.directionPendingRestored).toBe(2);
      expect(result.entryPendingRestored).toBe(2);
      expect(result.directionEvictedDuringRehydrate).toBe(1);
      expect(result.entryEvictedDuringRehydrate).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("pushes and returns Direction rows oldest-first (basic push/get correctness)", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 10, entryCapacity: 10 });
    ledger.pushDirection(directionRow(1));
    ledger.pushDirection(directionRow(2));
    ledger.pushDirection(directionRow(3));
    expect(ledger.getPendingDirectionRows().map((r) => r.decisionId)).toEqual(["dir-1", "dir-2", "dir-3"]);
    expect(ledger.directionSize).toBe(3);
  });

  it("pushes and returns Entry rows oldest-first (basic push/get correctness)", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 10, entryCapacity: 10 });
    ledger.pushEntry(entryRow(1));
    ledger.pushEntry(entryRow(2));
    expect(ledger.getPendingEntryRows().map((r) => r.decisionId)).toEqual(["entry-1", "entry-2"]);
    expect(ledger.entrySize).toBe(2);
  });

  it("FIFO evicts the OLDEST Direction row once capacity is exceeded, and the correct N survive in order", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 3, entryCapacity: 10 });
    for (let i = 1; i <= 4; i++) ledger.pushDirection(directionRow(i)); // N+1 into capacity-N
    expect(ledger.directionSize).toBe(3);
    // #1 was evicted (oldest); #2, #3, #4 survive in original chronological order — not just length-3.
    expect(ledger.getPendingDirectionRows().map((r) => r.decisionId)).toEqual(["dir-2", "dir-3", "dir-4"]);
    expect(ledger.droppedPendingBeforeResolution.direction).toBe(1);
    expect(ledger.droppedPendingBeforeResolution.entry).toBe(0);
  });

  it("FIFO evicts the OLDEST Entry row once capacity is exceeded, independent of Direction's capacity", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 10, entryCapacity: 2 });
    for (let i = 1; i <= 5; i++) ledger.pushEntry(entryRow(i)); // N+3 into capacity-N
    expect(ledger.entrySize).toBe(2);
    expect(ledger.getPendingEntryRows().map((r) => r.decisionId)).toEqual(["entry-4", "entry-5"]);
    expect(ledger.droppedPendingBeforeResolution.entry).toBe(3);
    expect(ledger.droppedPendingBeforeResolution.direction).toBe(0);
  });

  it("defaults to Direction capacity 2000 / Entry capacity 10000 and tolerates bad capacity options", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: -1, entryCapacity: Number.NaN });
    for (let i = 0; i < 2001; i++) ledger.pushDirection(directionRow(i));
    for (let i = 0; i < 10_001; i++) ledger.pushEntry(entryRow(i));
    expect(ledger.directionSize).toBe(2000);
    expect(ledger.entrySize).toBe(10_000);
  });

  it("getPendingDirectionRows/getPendingEntryRows return fresh arrays — callers cannot mutate internal state", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 10, entryCapacity: 10 });
    ledger.pushDirection(directionRow(1));
    ledger.pushEntry(entryRow(1));
    const dirs = ledger.getPendingDirectionRows();
    dirs.push(directionRow(999));
    const entries = ledger.getPendingEntryRows();
    entries.push(entryRow(999));
    expect(ledger.getPendingDirectionRows()).toHaveLength(1);
    expect(ledger.getPendingEntryRows()).toHaveLength(1);
  });

  it("getPendingDirectionRows/getPendingEntryRows return fresh ROW objects too — mutating a field on a", () => {
    // returned row must NOT corrupt the ledger's internally held row (a shallow array-only copy would leak
    // this, since the row objects themselves would still be shared by reference).
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 10, entryCapacity: 10 });
    ledger.pushDirection(directionRow(1));
    ledger.pushEntry(entryRow(1));

    const dirs = ledger.getPendingDirectionRows();
    dirs[0].expectedDirectionalR = 999;
    dirs[0].decisionId = "tampered";
    expect(ledger.getPendingDirectionRows()[0]).toEqual(directionRow(1));

    const entries = ledger.getPendingEntryRows();
    entries[0].expectedNetR = 999;
    entries[0].decisionId = "tampered";
    expect(ledger.getPendingEntryRows()[0]).toEqual(entryRow(1));
  });
});

describe("pushDirection decisionId dedup (regression: Direction Brain candidate-fan-out flooding)", () => {
  // ROOT CAUSE this guards against: a Direction decision is computed ONCE per horizon per shadow tick but
  // gets embedded (byte-identical decisionId) into EVERY entry-candidate's EXECUTIVE_DECISION record for
  // that tick (~14-25 candidates/tick measured) — each call is genuinely the SAME decision, not N distinct
  // ones. Without a decisionId dedup guard, pushDirection floods the FIFO pending ledger, evicting
  // genuinely-distinct decisions before they can ever reach their own resolution horizon.

  it("pushing the SAME decisionId many times (simulating one tick's candidate fan-out) admits exactly ONE pending row", () => {
    // Capacity (50) is deliberately far above the push count (20) so this asserts dedup specifically —
    // not FIFO eviction (which would also cap the count, but for the wrong reason).
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 50, entryCapacity: 10 });
    const sharedRow = directionRow(1); // one real Direction decision ("dir-1")
    for (let i = 0; i < 20; i++) ledger.pushDirection({ ...sharedRow }); // 20 candidates sharing one horizon
    expect(ledger.directionSize).toBe(1);
    expect(ledger.getPendingDirectionRows()).toEqual([sharedRow]);
    expect(ledger.deduplicatedDirectionPushes).toBe(19);
    // No FIFO churn should have occurred — every one of the 19 suppressed pushes was a dedup skip, not an
    // eviction of some other row.
    expect(ledger.droppedPendingBeforeResolution.direction).toBe(0);
  });

  it("does not over-dedup: multiple DIFFERENT decisionIds are all pushed independently, not collapsed to one", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 10, entryCapacity: 10 });
    ledger.pushDirection(directionRow(1));
    ledger.pushDirection(directionRow(2));
    ledger.pushDirection(directionRow(3));
    expect(ledger.directionSize).toBe(3);
    expect(ledger.getPendingDirectionRows().map((r) => r.decisionId)).toEqual(["dir-1", "dir-2", "dir-3"]);
    expect(ledger.deduplicatedDirectionPushes).toBe(0);
  });

  it("a decisionId already evicted via FIFO capacity is still never re-admitted (seen-set outlives the row's own membership)", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 2, entryCapacity: 10, directionSeenCapacity: 10 });
    ledger.pushDirection(directionRow(1));
    ledger.pushDirection(directionRow(2));
    ledger.pushDirection(directionRow(3)); // evicts dir-1 (FIFO, capacity 2)
    expect(ledger.getPendingDirectionRows().map((r) => r.decisionId)).toEqual(["dir-2", "dir-3"]);
    expect(ledger.droppedPendingBeforeResolution.direction).toBe(1);

    ledger.pushDirection(directionRow(1)); // a stale duplicate of the already-evicted decision arrives late
    expect(ledger.directionSize).toBe(2); // must NOT be re-admitted
    expect(ledger.getPendingDirectionRows().map((r) => r.decisionId)).toEqual(["dir-2", "dir-3"]);
    expect(ledger.deduplicatedDirectionPushes).toBe(1);
  });

  it("a decisionId already removed via removeDirectionByIds (resolved) is still never re-pushed", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 10, entryCapacity: 10 });
    ledger.pushDirection(directionRow(1));
    ledger.removeDirectionByIds(new Set(["dir-1"]));
    expect(ledger.directionSize).toBe(0);

    ledger.pushDirection(directionRow(1)); // a late duplicate of the already-resolved decision arrives
    expect(ledger.directionSize).toBe(0); // must NOT be re-admitted
    expect(ledger.deduplicatedDirectionPushes).toBe(1);
  });
});

describe("extractPendingDirectionRow / extractPendingEntryRow", () => {
  it("extracts a well-formed Direction slice from an EXECUTIVE_DECISION record", () => {
    const rec = executiveRecord({ decisionId: "exec-1", asOfMs: 1000 });
    const row = extractPendingDirectionRow(rec);
    expect(row).toEqual({
      decisionId: "exec-1-dir",
      asOfMs: 1000,
      horizon: "SCALP",
      action: "LONG",
      expectedDirectionalR: 0.12,
    });
  });

  it("extracts a well-formed Entry slice, pulling laneId/symbolOrBasketId from the executive record", () => {
    const rec = executiveRecord({ decisionId: "exec-1", asOfMs: 1000, laneId: "RC_LANE", symbolOrBasketId: "ETHUSDT" });
    const row = extractPendingEntryRow(rec);
    expect(row).toEqual({
      decisionId: "exec-1-entry",
      asOfMs: 1000,
      symbolOrBasketId: "ETHUSDT",
      laneId: "RC_LANE",
      side: "LONG",
      action: "ENTER_NOW",
      targetEntry: 101,
      initialStopPrice: 96,
      expectedNetR: 0.18,
    });
  });

  it("returns null when brains.direction/brains.entry is null (a MISSING-input cycle) — never a fabricated row", () => {
    const rec = executiveRecord({ decisionId: "exec-1", asOfMs: 1000, direction: null, entry: null });
    expect(extractPendingDirectionRow(rec)).toBeNull();
    expect(extractPendingEntryRow(rec)).toBeNull();
  });

  it("returns null when a required field is malformed (bad horizon/action/side, missing decisionId, non-finite asOfMs)", () => {
    expect(
      extractPendingDirectionRow(
        executiveRecord({
          decisionId: "exec-1",
          asOfMs: 1000,
          direction: { decisionId: "d1", asOfMs: 1000, horizon: "BOGUS", action: "LONG", expectedDirectionalR: 0.1 },
        }),
      ),
    ).toBeNull();
    expect(
      extractPendingDirectionRow(
        executiveRecord({
          decisionId: "exec-1",
          asOfMs: 1000,
          direction: { decisionId: "", asOfMs: 1000, horizon: "SCALP", action: "LONG", expectedDirectionalR: 0.1 },
        }),
      ),
    ).toBeNull();
    expect(
      extractPendingEntryRow(
        executiveRecord({
          decisionId: "exec-1",
          asOfMs: 1000,
          entry: { decisionId: "e1", asOfMs: Number.NaN, side: "LONG", action: "ENTER_NOW" },
        }),
      ),
    ).toBeNull();
    expect(
      extractPendingEntryRow(
        executiveRecord({
          decisionId: "exec-1",
          asOfMs: 1000,
          entry: { decisionId: "e1", asOfMs: 1000, side: "SIDEWAYS", action: "ENTER_NOW" },
        }),
      ),
    ).toBeNull();
  });

  it("treats a null expectedDirectionalR/expectedNetR as MISSING, not a fabricated 0", () => {
    const rec = executiveRecord({
      decisionId: "exec-1",
      asOfMs: 1000,
      direction: { decisionId: "d1", asOfMs: 1000, horizon: "SWING", action: "FLAT", expectedDirectionalR: null },
      entry: { decisionId: "e1", asOfMs: 1000, side: "SHORT", action: "SKIP", expectedNetR: null },
    });
    expect(extractPendingDirectionRow(rec)?.expectedDirectionalR).toBeNull();
    expect(extractPendingEntryRow(rec)?.expectedNetR).toBeNull();
  });
});

describe("wrapFourBrainJournalAppendForOutcomeLedger", () => {
  it("mirrors Direction + Entry rows from an EXECUTIVE_DECISION record AND always calls the real append", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 10, entryCapacity: 10 });
    const appended: Record<string, unknown>[] = [];
    const wrapped = wrapFourBrainJournalAppendForOutcomeLedger((r) => appended.push(r), ledger);

    wrapped(executiveRecord({ decisionId: "exec-1", asOfMs: 1 }));
    wrapped({ kind: "MARKET_SNAPSHOT", asOfMs: 2 }); // irrelevant kind — real append still happens, ledger untouched
    wrapped(executiveRecord({ decisionId: "exec-2", asOfMs: 3 }));

    expect(appended.map((r) => r.asOfMs)).toEqual([1, 2, 3]);
    expect(ledger.directionSize).toBe(2);
    expect(ledger.entrySize).toBe(2);
    expect(ledger.getPendingDirectionRows().map((r) => r.decisionId)).toEqual(["exec-1-dir", "exec-2-dir"]);
  });

  it("never suppresses the real append even if ledger push throws (non-interference contract)", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 10, entryCapacity: 10 });
    ledger.pushDirection = () => {
      throw new Error("boom");
    };
    const appended: Record<string, unknown>[] = [];
    const wrapped = wrapFourBrainJournalAppendForOutcomeLedger((r) => appended.push(r), ledger);

    expect(() => wrapped(executiveRecord({ decisionId: "exec-1", asOfMs: 1 }))).not.toThrow();
    expect(appended).toHaveLength(1);
    expect(appended[0]?.asOfMs).toBe(1);
  });

  it("propagates a throw from the REAL append unchanged (this wrapper must not swallow real-append errors)", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 10, entryCapacity: 10 });
    const wrapped = wrapFourBrainJournalAppendForOutcomeLedger(() => {
      throw new Error("real journal append failed");
    }, ledger);

    expect(() => wrapped(executiveRecord({ decisionId: "exec-1", asOfMs: 1 }))).toThrow(
      "real journal append failed",
    );
    // the ledger mirror still happened before the real append threw
    expect(ledger.directionSize).toBe(1);
    expect(ledger.entrySize).toBe(1);
  });

  it("does not alter or suppress the real append's record contents (non-interference on data, not just control flow)", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 10, entryCapacity: 10 });
    const appended: Record<string, unknown>[] = [];
    const wrapped = wrapFourBrainJournalAppendForOutcomeLedger((r) => appended.push(r), ledger);
    const rec = executiveRecord({ decisionId: "exec-1", asOfMs: 1 });
    wrapped(rec);
    expect(appended[0]).toBe(rec); // same reference, untouched
  });

  it("mirrors exactly ONE Direction row when many EXECUTIVE_DECISION records from one tick share an identical brains.direction slice (regression: candidate-fan-out flooding)", () => {
    // Reproduces the real shape of the bug: four-brain-shadow-tick.ts computes ONE DirectionDecision per
    // horizon per tick, then embeds that SAME object (same decisionId) into every entry candidate's
    // EXECUTIVE_DECISION record sharing that horizon. Here, 18 candidates (a realistic per-tick count)
    // each carry the identical INTRADAY direction slice, while each candidate's own Entry slice is
    // genuinely distinct (different symbol) — exactly as buildExecutiveDecision produces in practice.
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 100, entryCapacity: 100 });
    const appended: Record<string, unknown>[] = [];
    const wrapped = wrapFourBrainJournalAppendForOutcomeLedger((r) => appended.push(r), ledger);
    const sharedDirection = {
      decisionId: "dir-1000-intraday-long",
      asOfMs: 1000,
      horizon: "INTRADAY",
      action: "LONG",
      expectedDirectionalR: 0.2,
    };

    for (let i = 0; i < 18; i++) {
      wrapped(
        executiveRecord({
          decisionId: `exec-candidate-${i}`,
          asOfMs: 1000,
          symbolOrBasketId: `SYM${i}USDT`,
          direction: sharedDirection,
        }),
      );
    }

    expect(appended).toHaveLength(18); // the real journal append still happens for every candidate, untouched
    expect(ledger.directionSize).toBe(1); // exactly ONE Direction row admitted, not 18
    expect(ledger.getPendingDirectionRows()[0]?.decisionId).toBe("dir-1000-intraday-long");
    expect(ledger.entrySize).toBe(18); // Entry rows are genuinely distinct per candidate — none deduped
  });

  it("still mirrors separate Direction rows for genuinely different decisionIds (e.g. two horizons in one tick) — no over-dedup", () => {
    const ledger = new FourBrainOutcomeLedger({ directionCapacity: 100, entryCapacity: 100 });
    const wrapped = wrapFourBrainJournalAppendForOutcomeLedger(() => {}, ledger);
    const intraday = {
      decisionId: "dir-1000-intraday-long",
      asOfMs: 1000,
      horizon: "INTRADAY",
      action: "LONG",
      expectedDirectionalR: 0.2,
    };
    const swing = {
      decisionId: "dir-1000-swing-short",
      asOfMs: 1000,
      horizon: "SWING",
      action: "SHORT",
      expectedDirectionalR: -0.1,
    };

    wrapped(executiveRecord({ decisionId: "exec-a", asOfMs: 1000, direction: intraday }));
    wrapped(executiveRecord({ decisionId: "exec-b", asOfMs: 1000, direction: intraday })); // duplicate — same horizon
    wrapped(executiveRecord({ decisionId: "exec-c", asOfMs: 1000, direction: swing })); // genuinely different horizon

    expect(ledger.directionSize).toBe(2);
    expect(ledger.getPendingDirectionRows().map((r) => r.decisionId).sort()).toEqual([
      "dir-1000-intraday-long",
      "dir-1000-swing-short",
    ]);
  });
});
