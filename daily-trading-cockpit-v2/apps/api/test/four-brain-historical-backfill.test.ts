import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Candle } from "@dtc/shared";
import { HOUR } from "../src/lib/replay-tier-a-core.js";
import type { PathCandle } from "../src/lib/entry-exit-counterfactual.js";
import type { PendingDirectionRow, PendingEntryRow } from "../src/lib/four-brain-outcome-ledger.js";
import type { PositionPath } from "../src/lib/position-path-recorder.js";
import { DirectionEntryOutcomeStore } from "../src/lib/direction-entry-outcome-store.js";
import { ENTRY_TIER2_ELIGIBLE_AFTER_MS } from "../src/lib/direction-entry-reconciler.js";
import { MAX_UNRESOLVABLE_STALENESS_MS } from "../src/lib/direction-brain-resolver.js";
import {
  scanJournalForBackfillRows,
  resolveBackfillDirectionRow,
  resolveBackfillEntryRow,
  runHistoricalBackfillOverRows,
  writeBackfillResults,
  FOUR_BRAIN_DECISION_JOURNAL_FILE,
} from "../src/lib/four-brain-historical-backfill.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-historical-backfill-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────

function executiveRecord(opts: {
  decisionId: string;
  asOfMs: number;
  laneId?: string | null;
  symbolOrBasketId?: string | null;
  kind?: string;
  direction?: Record<string, unknown> | null;
  entry?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    kind: opts.kind ?? "EXECUTIVE_DECISION",
    asOfMs: opts.asOfMs,
    laneId: opts.laneId ?? "CG_WIDE_FAST_LONG",
    symbolOrBasketId: opts.symbolOrBasketId ?? "BTCUSDT",
    brains: {
      direction:
        opts.direction === undefined
          ? { decisionId: `${opts.decisionId}-dir`, asOfMs: opts.asOfMs, horizon: "SCALP", action: "LONG", expectedDirectionalR: 0.12 }
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

/** Flat 1h BTCUSDT candle series (no gaps, no data-quality failures) — enough for
 *  resolveDirectionOutcome/resolveBackfillDirectionRow to reach a real EVALUATED result. */
function flatCandles(startMs: number, count: number, price = 60000): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ openTime: startMs + i * HOUR, open: price, high: price + 5, low: price - 5, close: price, volume: 100 });
  }
  return out;
}

const pc = (o: number, h: number, l: number, cl: number, t = 0): PathCandle => ({ openTime: t, open: o, high: h, low: l, close: cl });

function entryRow(over: Partial<PendingEntryRow> & { decisionId: string; asOfMs: number }): PendingEntryRow {
  return {
    decisionId: over.decisionId,
    asOfMs: over.asOfMs,
    symbolOrBasketId: "symbolOrBasketId" in over ? (over.symbolOrBasketId as string | null) : "BTCUSDT",
    laneId: "laneId" in over ? (over.laneId as string | null) : "CG_WIDE_FAST_LONG",
    side: over.side ?? "LONG",
    action: over.action ?? "ENTER_NOW",
    targetEntry: over.targetEntry ?? 100,
    initialStopPrice: over.initialStopPrice ?? 95,
    expectedNetR: over.expectedNetR ?? 0.2,
  };
}

function closedPath(over: {
  key: string;
  laneId?: string;
  symbol?: string;
  direction?: "LONG" | "SHORT";
  firstTickMs: number;
  closedAtMs: number;
  closeR?: number | null;
}): PositionPath {
  return {
    key: over.key,
    meta: { laneId: over.laneId ?? "CG_WIDE_FAST_LONG", symbol: over.symbol ?? "BTCUSDT", direction: over.direction ?? "LONG", source: "engine" },
    ticks: [{ t: over.firstTickMs, r: 0 }],
    rawTickCount: 1,
    thinned: 0,
    closedAtMs: over.closedAtMs,
    closeR: over.closeR === undefined ? 0.5 : over.closeR,
  };
}

// ── scanJournalForBackfillRows ───────────────────────────────────────────────────────────────────────

describe("scanJournalForBackfillRows", () => {
  it("parses a valid EXECUTIVE_DECISION line into both a Direction and an Entry row", () => {
    const line = JSON.stringify(executiveRecord({ decisionId: "d1", asOfMs: 1000 }));
    const scan = scanJournalForBackfillRows([line]);
    expect(scan.directionRows.map((r) => r.decisionId)).toEqual(["d1-dir"]);
    expect(scan.entryRows.map((r) => r.decisionId)).toEqual(["d1-entry"]);
    expect(scan.badLines).toBe(0);
    expect(scan.skippedNonExecutiveDecision).toBe(0);
    expect(scan.parsedRecords).toBe(1);
  });

  it("skips blank lines and counts malformed JSON as badLines without aborting the scan", () => {
    const good = JSON.stringify(executiveRecord({ decisionId: "d1", asOfMs: 1000 }));
    const scan = scanJournalForBackfillRows(["", "   ", "{not json", good]);
    expect(scan.badLines).toBe(1);
    expect(scan.directionRows).toHaveLength(1);
    expect(scan.entryRows).toHaveLength(1);
  });

  it("skips non-EXECUTIVE_DECISION kinds (e.g. MARKET_SNAPSHOT) — never extracted", () => {
    const other = JSON.stringify({ kind: "MARKET_SNAPSHOT", asOfMs: 1 });
    const scan = scanJournalForBackfillRows([other]);
    expect(scan.skippedNonExecutiveDecision).toBe(1);
    expect(scan.directionRows).toHaveLength(0);
    expect(scan.entryRows).toHaveLength(0);
  });

  it("dedupes by decisionId across duplicate lines (current + rotated .1 concatenation can never overlap in time, but dedup is defense-in-depth)", () => {
    const line = JSON.stringify(executiveRecord({ decisionId: "d1", asOfMs: 1000 }));
    const scan = scanJournalForBackfillRows([line, line]);
    expect(scan.directionRows).toHaveLength(1);
    expect(scan.entryRows).toHaveLength(1);
  });

  it("a record with a missing/malformed brains.direction slice yields no Direction row but still extracts a valid Entry row", () => {
    const line = JSON.stringify(executiveRecord({ decisionId: "d1", asOfMs: 1000, direction: null }));
    const scan = scanJournalForBackfillRows([line]);
    expect(scan.directionRows).toHaveLength(0);
    expect(scan.entryRows).toHaveLength(1);
  });

  it("FOUR_BRAIN_DECISION_JOURNAL_FILE matches app.ts's own hardcoded journal filename literal", () => {
    expect(FOUR_BRAIN_DECISION_JOURNAL_FILE).toBe("four-brain-decision-journal.jsonl");
  });
});

// ── resolveBackfillDirectionRow ──────────────────────────────────────────────────────────────────────

describe("resolveBackfillDirectionRow", () => {
  it("is a thin pass-through to resolveDirectionOutcome: resolves EVALUATED against a real flat candle series", () => {
    const start = 0;
    const candles = flatCandles(start, 200);
    const row: PendingDirectionRow = { decisionId: "dir-1", asOfMs: 15 * HOUR, horizon: "SCALP", action: "LONG", expectedDirectionalR: 0.1 };
    const nowMs = 40 * HOUR;
    const outcome = resolveBackfillDirectionRow(row, candles, nowMs);
    expect(outcome.status).toBe("EVALUATED");
  });

  it("reports PENDING when nowMs has not yet reached the row's own horizon window", () => {
    const row: PendingDirectionRow = { decisionId: "dir-1", asOfMs: 15 * HOUR, horizon: "SWING", action: "LONG", expectedDirectionalR: 0.1 };
    const outcome = resolveBackfillDirectionRow(row, flatCandles(0, 50), 16 * HOUR);
    expect(outcome.status).toBe("PENDING");
  });
});

// ── resolveBackfillEntryRow ──────────────────────────────────────────────────────────────────────────

describe("resolveBackfillEntryRow", () => {
  const MIN = 60_000;
  const row = entryRow({ decisionId: "e1", asOfMs: 10 * MIN });

  it("books TIER1_REALIZED when a resolved Tier1 row is supplied — Tier1 always wins over Tier2", () => {
    const tier1: import("../src/lib/entry-brain-tier1-realized-resolver.js").EntryBrainTier1ResolvedRow = {
      decisionId: "e1",
      status: "RESOLVED",
      confidence: "MEASURED",
      laneId: "CG_WIDE_FAST_LONG",
      symbolOrBasketId: "BTCUSDT",
      side: "LONG",
      decisionAsOfMs: row.asOfMs,
      expectedNetR: 0.2,
      targetEntry: 100,
      initialStopPrice: 95,
      matchedCloseKey: "CG_WIDE_FAST_LONG::BTCUSDT::LONG::1",
      openedAtMs: 12 * MIN,
      closedAtMs: 20 * MIN,
      realizedR: 0.55,
      realizedRSource: "engine",
    };
    const resolution = resolveBackfillEntryRow(row, tier1, null, 100 * MIN);
    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.record?.tier).toBe("TIER1_REALIZED");
    expect(resolution.record?.realizedNetR).toBe(0.55);
    expect(resolution.record?.matchedCloseKey).toBe("CG_WIDE_FAST_LONG::BTCUSDT::LONG::1");
  });

  it("reports PENDING (no record) before the Tier2-eligible deadline, even with no Tier1 match", () => {
    const nowMs = row.asOfMs + ENTRY_TIER2_ELIGIBLE_AFTER_MS - 1;
    const resolution = resolveBackfillEntryRow(row, undefined, null, nowMs);
    expect(resolution.status).toBe("PENDING");
    expect(resolution.record).toBeNull();
  });

  it("falls through to Tier2 simulation once eligible, with archived candles available", () => {
    const nowMs = row.asOfMs + ENTRY_TIER2_ELIGIBLE_AFTER_MS + 1;
    const path: PathCandle[] = [pc(100, 100.5, 99.5, 100, row.asOfMs)];
    for (let i = 1; i <= 40; i += 1) path.push(pc(100, 100.5, 99.5, 100.1, row.asOfMs + i * 900_000));
    const resolution = resolveBackfillEntryRow(row, undefined, path, nowMs);
    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.record?.tier).toBe("TIER2_SIMULATED");
    expect(resolution.record?.confidence).toBe("MEASURED"); // ENTER_NOW
  });

  it("reports INSTRUMENT_DATA_MISSING (transient, no record) when no archived candles exist yet and not yet stale", () => {
    const nowMs = row.asOfMs + ENTRY_TIER2_ELIGIBLE_AFTER_MS + 1;
    const resolution = resolveBackfillEntryRow(row, undefined, null, nowMs);
    expect(resolution.status).toBe("INSTRUMENT_DATA_MISSING");
    expect(resolution.record).toBeNull();
  });

  it("reports EXPIRED_UNRESOLVABLE (terminal) once past MAX_UNRESOLVABLE_STALENESS_MS with still no usable data", () => {
    const nowMs = row.asOfMs + MAX_UNRESOLVABLE_STALENESS_MS + 1;
    const resolution = resolveBackfillEntryRow(row, undefined, null, nowMs);
    expect(resolution.status).toBe("EXPIRED_UNRESOLVABLE");
    expect(resolution.record?.status).toBe("EXPIRED_UNRESOLVABLE");
    expect(resolution.record?.tier).toBeNull();
    expect(resolution.record?.realizedNetR).toBeNull(); // never fabricated
  });

  it("a row with no symbolOrBasketId can never fetch/simulate — same staleness-capped MISSING→EXPIRED path, never fabricated", () => {
    const noSymbolRow = entryRow({ decisionId: "e2", asOfMs: 10 * MIN, symbolOrBasketId: null });
    const eligibleNow = noSymbolRow.asOfMs + ENTRY_TIER2_ELIGIBLE_AFTER_MS + 1;
    const notStale = resolveBackfillEntryRow(noSymbolRow, undefined, null, eligibleNow);
    expect(notStale.status).toBe("INSTRUMENT_DATA_MISSING");
    const staleNow = noSymbolRow.asOfMs + MAX_UNRESOLVABLE_STALENESS_MS + 1;
    const stale = resolveBackfillEntryRow(noSymbolRow, undefined, null, staleNow);
    expect(stale.status).toBe("EXPIRED_UNRESOLVABLE");
  });
});

// ── runHistoricalBackfillOverRows: "one close claimed once" GLOBAL invariant ────────────────────────

describe("runHistoricalBackfillOverRows", () => {
  const MIN = 60_000;

  it("Tier1 matching is batched ONCE across all Entry rows — a single real close can never resolve two different decisions", () => {
    const rowA = entryRow({ decisionId: "eA", asOfMs: 10 * MIN });
    const rowB = entryRow({ decisionId: "eB", asOfMs: 20 * MIN });
    const close = closedPath({ key: "K1", firstTickMs: 25 * MIN, closedAtMs: 30 * MIN });
    const scan = scanJournalForBackfillRows([]); // build manually below instead of via journal lines
    scan.directionRows.length = 0;
    scan.entryRows.push(rowA, rowB);

    const nowMs = 30 * MIN + ENTRY_TIER2_ELIGIBLE_AFTER_MS + 1; // eligible, but no archive coverage below
    const results = runHistoricalBackfillOverRows(scan, {
      btcCandles: [],
      closedPositionPaths: [close],
      fetchTier2Candles: () => null, // no archive coverage — isolates the Tier1 behavior being tested
      isCloseAlreadyClaimed: () => false,
      nowMs,
    });

    const resolvedTier1 = results.entry.filter((e) => e.resolution.record?.tier === "TIER1_REALIZED");
    expect(resolvedTier1).toHaveLength(1); // NEVER 2 — the close can only ever be claimed once
    // the latest eligible candidate (rowB, asOfMs=20min <= openedAtMs=25min) is the honest owner.
    expect(resolvedTier1[0]!.row.decisionId).toBe("eB");
    // the loser (rowA) falls through Tier1 entirely — with no archive candles it reports transient MISSING,
    // never a fabricated Tier1/Tier2 result for the close it didn't actually cause.
    const loser = results.entry.find((e) => e.row.decisionId === "eA")!;
    expect(loser.resolution.status).toBe("INSTRUMENT_DATA_MISSING");
  });

  it("isCloseAlreadyClaimed excludes a close from Tier1 matching entirely (cross-run 'one close claimed once' memory)", () => {
    const rowA = entryRow({ decisionId: "eA", asOfMs: 20 * MIN });
    const close = closedPath({ key: "ALREADY_CLAIMED", firstTickMs: 25 * MIN, closedAtMs: 30 * MIN });
    const scan = scanJournalForBackfillRows([]);
    scan.entryRows.push(rowA);

    const nowMs = 30 * MIN + ENTRY_TIER2_ELIGIBLE_AFTER_MS + 1;
    const results = runHistoricalBackfillOverRows(scan, {
      btcCandles: [],
      closedPositionPaths: [close],
      fetchTier2Candles: () => null,
      isCloseAlreadyClaimed: (key) => key === "ALREADY_CLAIMED",
      nowMs,
    });

    expect(results.entry[0]!.resolution.record?.tier).not.toBe("TIER1_REALIZED");
    expect(results.entry[0]!.resolution.status).toBe("INSTRUMENT_DATA_MISSING");
  });

  it("only fetches Tier2 candles for rows Tier1 did NOT already resolve", () => {
    const tier1Winner = entryRow({ decisionId: "eWin", asOfMs: 20 * MIN });
    const tier2Candidate = entryRow({ decisionId: "eNoTier1", asOfMs: 5 * MIN, symbolOrBasketId: "ETHUSDT" });
    const close = closedPath({ key: "K2", firstTickMs: 25 * MIN, closedAtMs: 30 * MIN });
    const scan = scanJournalForBackfillRows([]);
    scan.entryRows.push(tier1Winner, tier2Candidate);

    const fetchedFor: string[] = [];
    const nowMs = 30 * MIN + ENTRY_TIER2_ELIGIBLE_AFTER_MS + 1;
    runHistoricalBackfillOverRows(scan, {
      btcCandles: [],
      closedPositionPaths: [close],
      fetchTier2Candles: (symbol) => {
        fetchedFor.push(symbol);
        return null;
      },
      isCloseAlreadyClaimed: () => false,
      nowMs,
    });

    expect(fetchedFor).toEqual(["ETHUSDT"]); // never for the Tier1-resolved winner
  });

  it("resolves Direction rows against the supplied btcCandles independent of Entry resolution", () => {
    const dirRow: PendingDirectionRow = { decisionId: "dir-1", asOfMs: 15 * HOUR, horizon: "SCALP", action: "LONG", expectedDirectionalR: 0.1 };
    const scan = scanJournalForBackfillRows([]);
    scan.directionRows.push(dirRow);
    const results = runHistoricalBackfillOverRows(scan, {
      btcCandles: flatCandles(0, 200),
      closedPositionPaths: [],
      fetchTier2Candles: () => null,
      isCloseAlreadyClaimed: () => false,
      nowMs: 40 * HOUR,
    });
    expect(results.direction).toHaveLength(1);
    expect(results.direction[0]!.outcome.status).toBe("EVALUATED");
  });
});

// ── writeBackfillResults ─────────────────────────────────────────────────────────────────────────────

describe("writeBackfillResults", () => {
  it("books RESOLVED/EXPIRED_UNRESOLVABLE rows and skips PENDING/INSTRUMENT_DATA_MISSING (never a terminal record for a non-terminal status)", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    const dirEvaluated: PendingDirectionRow = { decisionId: "dir-ok", asOfMs: 15 * HOUR, horizon: "SCALP", action: "LONG", expectedDirectionalR: 0.1 };
    const results = {
      direction: [
        { row: dirEvaluated, outcome: resolveBackfillDirectionRow(dirEvaluated, flatCandles(0, 200), 40 * HOUR) },
      ],
      entry: [
        {
          row: entryRow({ decisionId: "e-missing", asOfMs: 0 }),
          resolution: { status: "INSTRUMENT_DATA_MISSING" as const, record: null },
        },
      ],
    };
    const summary = writeBackfillResults(store, results);
    expect(summary.directionBooked).toBe(1);
    expect(summary.entryBooked).toBe(0);
    expect(summary.entryNotTerminal).toBe(1);

    const report = store.buildReport();
    expect(report.direction.coverage.evaluated).toBe(1);
  });

  it("is idempotent per decisionId: re-writing the SAME results a second time books nothing new", () => {
    const store = new DirectionEntryOutcomeStore(tmp());
    const dirRow: PendingDirectionRow = { decisionId: "dir-dup", asOfMs: 15 * HOUR, horizon: "SCALP", action: "LONG", expectedDirectionalR: 0.1 };
    const results = { direction: [{ row: dirRow, outcome: resolveBackfillDirectionRow(dirRow, flatCandles(0, 200), 40 * HOUR) }], entry: [] };

    const first = writeBackfillResults(store, results);
    expect(first.directionBooked).toBe(1);
    const second = writeBackfillResults(store, results);
    expect(second.directionBooked).toBe(0);
    expect(second.directionSkippedAlreadyProcessed).toBe(1);
  });

  it("persists to disk (flush) — a fresh store instance over the same dataDir sees the booked outcome", () => {
    const dataDir = tmp();
    const store = new DirectionEntryOutcomeStore(dataDir);
    const dirRow: PendingDirectionRow = { decisionId: "dir-persist", asOfMs: 15 * HOUR, horizon: "SCALP", action: "LONG", expectedDirectionalR: 0.1 };
    writeBackfillResults(store, { direction: [{ row: dirRow, outcome: resolveBackfillDirectionRow(dirRow, flatCandles(0, 200), 40 * HOUR) }] , entry: [] });

    const reloaded = new DirectionEntryOutcomeStore(dataDir);
    expect(reloaded.buildReport().direction.coverage.evaluated).toBe(1);
  });
});
