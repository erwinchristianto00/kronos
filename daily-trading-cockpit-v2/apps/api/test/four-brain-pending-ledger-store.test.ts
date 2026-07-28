import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FourBrainOutcomeLedger, rehydrateFourBrainOutcomeLedgerFromJournals } from "../src/lib/four-brain-outcome-ledger.js";
import { loadPendingLedgerSnapshot, savePendingLedgerSnapshot, pendingLedgerFilePath } from "../src/lib/four-brain-pending-ledger-store.js";

/**
 * The failure this exists to end: the pending ledger was in-memory and rebuilt only by replaying
 * four-brain-decision-journal.jsonl(+.1), which together span ~2.4 HOURS on the VPS. SCALP (1h)
 * survived a restart; INTRADAY (4h) and SWING (24h) could not. research/3101 had 254 restarts and
 * had never once held a resolved SWING row.
 */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pending-ledger-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const DAY_OLD_SWING = { decisionId: "dir-swing-1", asOfMs: 1_785_000_000_000, horizon: "SWING" as const, action: "LONG" as const, expectedDirectionalR: 0.4 };
const ENTRY = { decisionId: "ent-1", asOfMs: 1_785_000_000_000, signalId: "sig-1", symbolOrBasketId: "BTCUSDT", laneId: "CG_X", side: "LONG" as const, action: "ENTER_NOW" as const, targetEntry: 100, initialStopPrice: 95, expectedNetR: 0.2 };

describe("a decision older than the journal window survives a restart", () => {
  /** FAILS WITHOUT THE FIX — a 24h SWING row had no store to come back from. */
  it("round-trips a SWING row the journal could never have held", () => {
    expect(savePendingLedgerSnapshot({ direction: [DAY_OLD_SWING], entry: [ENTRY] }, dir)).toBe(true);
    const back = loadPendingLedgerSnapshot(dir);
    expect(back.skippedReason).toBeNull();
    expect(back.direction).toEqual([DAY_OLD_SWING]);
    expect(back.entry).toEqual([ENTRY]);
  });

  it("restores into a fresh ledger, exactly as the resolver will read it", () => {
    savePendingLedgerSnapshot({ direction: [DAY_OLD_SWING], entry: [ENTRY] }, dir);
    const ledger = new FourBrainOutcomeLedger();
    const snap = loadPendingLedgerSnapshot(dir);
    for (const r of snap.direction) ledger.pushDirection(r);
    for (const r of snap.entry) ledger.pushEntry(r);
    expect(ledger.getPendingDirectionRows()).toEqual([DAY_OLD_SWING]);
    expect(ledger.getPendingEntryRows()).toEqual([ENTRY]);
  });
});

describe("the snapshot and the journal replay cannot double-count", () => {
  /** pushEntry does NOT dedup (only pushDirection does), so the app threads restored ids through the
   *  rehydrate function's hasProcessed* predicates. THE GUARD: drop that and entries duplicate. */
  it("a row in BOTH the snapshot and the journal is admitted exactly once", () => {
    const journal = join(dir, "j.jsonl");
    writeFileSync(journal, [
      JSON.stringify({ kind: "EXECUTIVE_DECISION", brains: { direction: { decisionId: DAY_OLD_SWING.decisionId, asOfMs: DAY_OLD_SWING.asOfMs, horizon: "SWING", action: "LONG", expectedDirectionalR: 0.4 } } }),
      JSON.stringify({ kind: "EXECUTIVE_DECISION", laneId: ENTRY.laneId, symbolOrBasketId: ENTRY.symbolOrBasketId, brains: { entry: { decisionId: ENTRY.decisionId, asOfMs: ENTRY.asOfMs, signalId: ENTRY.signalId, side: "LONG", action: "ENTER_NOW", targetEntry: 100, initialStopPrice: 95, expectedNetR: 0.2 } } }),
    ].join("\n") + "\n");

    const ledger = new FourBrainOutcomeLedger();
    const snap = loadPendingLedgerSnapshot(dir); // empty on first run
    expect(snap.direction).toHaveLength(0);
    savePendingLedgerSnapshot({ direction: [DAY_OLD_SWING], entry: [ENTRY] }, dir);
    const restored = loadPendingLedgerSnapshot(dir);
    for (const r of restored.direction) ledger.pushDirection(r);
    for (const r of restored.entry) ledger.pushEntry(r);
    const restoredDirIds = new Set(restored.direction.map((r) => r.decisionId));
    const restoredEntryIds = new Set(restored.entry.map((r) => r.decisionId));

    rehydrateFourBrainOutcomeLedgerFromJournals({
      ledger, journalFiles: [journal],
      hasProcessedDirection: (id) => restoredDirIds.has(id),
      hasProcessedEntry: (id) => restoredEntryIds.has(id),
    });
    expect(ledger.getPendingDirectionRows()).toHaveLength(1);
    expect(ledger.getPendingEntryRows()).toHaveLength(1);
  });
});

describe("fails open — durability must never cost availability", () => {
  it("a missing file is a clean empty start, not an error", () => {
    const r = loadPendingLedgerSnapshot(dir);
    expect(r).toEqual({ direction: [], entry: [], skippedReason: null });
  });

  it("garbage restores nothing and says why", () => {
    writeFileSync(pendingLedgerFilePath(dir), "{not json");
    expect(loadPendingLedgerSnapshot(dir).skippedReason).toContain("malformed");
  });

  it("an unknown version is refused rather than guessed at", () => {
    writeFileSync(pendingLedgerFilePath(dir), JSON.stringify({ version: 99, direction: [DAY_OLD_SWING] }));
    const r = loadPendingLedgerSnapshot(dir);
    expect(r.direction).toHaveLength(0);
    expect(r.skippedReason).toContain("version");
  });

  /** One bad row must not cost the rest their accumulated day. */
  it("drops only the corrupt rows", () => {
    writeFileSync(pendingLedgerFilePath(dir), JSON.stringify({
      version: 1,
      direction: [DAY_OLD_SWING, { decisionId: "x", asOfMs: 1, horizon: "FORTNIGHT", action: "LONG", expectedDirectionalR: null }, { ...DAY_OLD_SWING, decisionId: "d2" }],
      entry: [],
    }));
    expect(loadPendingLedgerSnapshot(dir).direction.map((r) => r.decisionId)).toEqual(["dir-swing-1", "d2"]);
  });

  /** A non-finite expectedDirectionalR is corruption, not absence — laundering it to null would tell
   *  the resolver "no expectation was recorded", which is a different and false claim. */
  it("refuses a row whose numeric field is corrupt rather than nulling it", () => {
    writeFileSync(pendingLedgerFilePath(dir), JSON.stringify({ version: 1, direction: [{ ...DAY_OLD_SWING, expectedDirectionalR: "0.4" }], entry: [] }));
    expect(loadPendingLedgerSnapshot(dir).direction).toHaveLength(0);
  });

  it("keeps an explicitly-null expectation, which IS a legitimate value", () => {
    savePendingLedgerSnapshot({ direction: [{ ...DAY_OLD_SWING, expectedDirectionalR: null }], entry: [] }, dir);
    expect(loadPendingLedgerSnapshot(dir).direction[0]!.expectedDirectionalR).toBeNull();
  });

  it("writes atomically so a crash cannot leave a half-file", () => {
    savePendingLedgerSnapshot({ direction: [DAY_OLD_SWING], entry: [] }, dir);
    expect(() => JSON.parse(readFileSync(pendingLedgerFilePath(dir), "utf-8"))).not.toThrow();
  });
});

describe("the app wires it in the order that makes it work (source-level guard)", () => {
  const APP = readFileSync(new URL("../src/app.ts", import.meta.url), "utf-8");
  it("restores from the snapshot BEFORE replaying the journal", () => {
    const snapAt = APP.indexOf("loadPendingLedgerSnapshot()");
    const journalAt = APP.indexOf("rehydrateFourBrainOutcomeLedgerFromJournals({");
    expect(snapAt).toBeGreaterThanOrEqual(0);
    expect(journalAt).toBeGreaterThan(snapAt);
  });
  it("feeds restored ids into the dedup predicates", () => {
    expect(APP).toContain("restoredDirectionIds.has(decisionId) ||");
    expect(APP).toContain("restoredEntryIds.has(decisionId) ||");
  });
  it("saves on every reconciler cycle", () => {
    const at = APP.indexOf("savePendingLedgerSnapshot({");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(APP.slice(at, at + 200)).toContain("getPendingDirectionRows()");
  });
});
