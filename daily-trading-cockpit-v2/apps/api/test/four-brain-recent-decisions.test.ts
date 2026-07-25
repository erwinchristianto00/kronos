import { describe, it, expect } from "vitest";
import {
  FourBrainRecentDecisionsBuffer,
  wrapFourBrainJournalAppendForRecentDecisions,
} from "../src/lib/four-brain-recent-decisions.js";

describe("FourBrainRecentDecisionsBuffer", () => {
  it("returns pushed records most-recent-first", () => {
    const buf = new FourBrainRecentDecisionsBuffer({ capacity: 10 });
    buf.push({ kind: "MARKET_SNAPSHOT", asOfMs: 1 });
    buf.push({ kind: "EXECUTIVE_DECISION", asOfMs: 2 });
    buf.push({ kind: "EXECUTIVE_DECISION", asOfMs: 3 });
    const all = buf.getAll();
    expect(all.map((r) => r.asOfMs)).toEqual([3, 2, 1]);
    expect(buf.size).toBe(3);
  });

  it("evicts the OLDEST record once capacity is exceeded (bounded, never grows past capacity)", () => {
    const buf = new FourBrainRecentDecisionsBuffer({ capacity: 3 });
    for (let i = 1; i <= 5; i++) buf.push({ kind: "MARKET_SNAPSHOT", asOfMs: i });
    expect(buf.size).toBe(3);
    // #1 and #2 were evicted; only the newest 3 remain, most-recent-first
    expect(buf.getAll().map((r) => r.asOfMs)).toEqual([5, 4, 3]);
  });

  it("defaults to a capacity of 100 when none is given, and tolerates a non-finite/non-positive capacity", () => {
    const bufDefault = new FourBrainRecentDecisionsBuffer();
    for (let i = 0; i < 150; i++) bufDefault.push({ kind: "MARKET_SNAPSHOT", i });
    expect(bufDefault.size).toBe(100);

    const bufBadCap = new FourBrainRecentDecisionsBuffer({ capacity: -5 });
    for (let i = 0; i < 150; i++) bufBadCap.push({ kind: "MARKET_SNAPSHOT", i });
    expect(bufBadCap.size).toBe(100); // falls back to the default rather than growing unbounded
  });

  it("getAll() returns a fresh array each call — callers cannot mutate internal state through it", () => {
    const buf = new FourBrainRecentDecisionsBuffer({ capacity: 5 });
    buf.push({ kind: "MARKET_SNAPSHOT", asOfMs: 1 });
    const a = buf.getAll();
    a.push({ kind: "INJECTED", asOfMs: 999 });
    expect(buf.getAll()).toHaveLength(1);
  });
});

describe("wrapFourBrainJournalAppendForRecentDecisions", () => {
  it("mirrors MARKET_SNAPSHOT and EXECUTIVE_DECISION records into the buffer AND always calls the real append", () => {
    const buf = new FourBrainRecentDecisionsBuffer({ capacity: 10 });
    const appended: Record<string, unknown>[] = [];
    const wrapped = wrapFourBrainJournalAppendForRecentDecisions((r) => appended.push(r), buf);

    wrapped({ kind: "MARKET_SNAPSHOT", asOfMs: 1 });
    wrapped({ kind: "EXECUTIVE_DECISION", asOfMs: 2 });
    wrapped({ kind: "FOUR_BRAIN_CYCLE_METRICS", asOfMs: 3 }); // irrelevant kind — real append still happens
    wrapped({ kind: "SOMETHING_ELSE", asOfMs: 4 });

    // the real (unconditional) append sees EVERY record, regardless of kind
    expect(appended.map((r) => r.asOfMs)).toEqual([1, 2, 3, 4]);
    // the buffer only mirrors the two relevant kinds
    expect(buf.getAll().map((r) => r.asOfMs)).toEqual([2, 1]);
  });

  it("never suppresses the real append even if the buffer push throws", () => {
    const buf = new FourBrainRecentDecisionsBuffer({ capacity: 10 });
    // Force buffer.push to throw to prove the wrapper's own try/catch protects the real append.
    buf.push = () => {
      throw new Error("boom");
    };
    const appended: Record<string, unknown>[] = [];
    const wrapped = wrapFourBrainJournalAppendForRecentDecisions((r) => appended.push(r), buf);

    expect(() => wrapped({ kind: "MARKET_SNAPSHOT", asOfMs: 1 })).not.toThrow();
    expect(appended).toHaveLength(1);
  });

  it("propagates a throw from the REAL append unchanged (this wrapper must not swallow real-append errors)", () => {
    const buf = new FourBrainRecentDecisionsBuffer({ capacity: 10 });
    const wrapped = wrapFourBrainJournalAppendForRecentDecisions(() => {
      throw new Error("real journal append failed");
    }, buf);
    expect(() => wrapped({ kind: "EXECUTIVE_DECISION", asOfMs: 1 })).toThrow("real journal append failed");
    // the buffer mirror still happened before the real append threw
    expect(buf.getAll()).toHaveLength(1);
  });
});
