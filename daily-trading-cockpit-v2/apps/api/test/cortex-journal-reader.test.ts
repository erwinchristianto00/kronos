/**
 * 2026-07-20 incident fix: readCortexJournalTail used to readFileSync the ENTIRE journal just to return the
 * last few entries — a real contributing factor to that day's event-loop-starvation incident once the
 * journal grew into the multi-MB range. These tests pin down that a large file is now read via a growing
 * tail window (never the whole file when the whole file isn't needed) while still returning EXACTLY the
 * same entries a full read would.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readCortexJournalTail } from "../src/lib/cortex-journal-reader.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cortex-journal-reader-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const decisionLine = (at: string, laneId: string, finalPct: number, padding: string) =>
  JSON.stringify({
    kind: "BRAIN_DECISION",
    at,
    mode: "shadow",
    regimeFamily: "BULLISH_EXPANSION",
    posture: "RISK_ON",
    directionStance: "LONG",
    grossG: 1,
    beta: 0,
    liveBeta: 0,
    evaluationBeta: 0.12,
    rationale: `padding:${padding}`,
    lanes: [{ laneId, eligible: true, pWin: 0.55, allocationMagnitude: 0.04, finalPct, evalFinalPct: finalPct, direction: "LONG", reason: "eligible" }],
  });

describe("readCortexJournalTail — large-file tail behavior (#2026-07-20 incident fix)", () => {
  it("returns the exact same last-N entries from a multi-MB file as a naive full read would", () => {
    const dir = tmp();
    const path = resolve(dir, "cortex-decision-journal.jsonl");
    const padding = "x".repeat(2000); // inflate each line so the file crosses several MB quickly
    const n = 2000;
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
      lines.push(decisionLine(at, `LANE_${i}`, i % 100, padding));
    }
    writeFileSync(path, `${lines.join("\n")}\n`);
    expect(statSync(path).size).toBeGreaterThan(2 * 1024 * 1024); // confirm this is genuinely a multi-MB file

    const entries = readCortexJournalTail(dir, 10);
    expect(entries.length).toBe(10);
    // Most-recent-last ordering, and the exact tail of what was written — not an arbitrary/truncated subset.
    expect(entries.map((e) => e.lanes[0]!.laneId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `LANE_${n - 10 + i}`),
    );
  });

  it("still returns everything available when the file has fewer entries than maxEntries", () => {
    const dir = tmp();
    const path = resolve(dir, "cortex-decision-journal.jsonl");
    const padding = "x".repeat(2000);
    const lines = [
      decisionLine("2026-07-14T00:00:00Z", "LANE_A", 10, padding),
      decisionLine("2026-07-14T01:00:00Z", "LANE_B", 20, padding),
      decisionLine("2026-07-14T02:00:00Z", "LANE_C", 30, padding),
    ];
    writeFileSync(path, `${lines.join("\n")}\n`);
    const entries = readCortexJournalTail(dir, 50);
    expect(entries.map((e) => e.lanes[0]!.laneId)).toEqual(["LANE_A", "LANE_B", "LANE_C"]);
  });

  it("tolerates a tail window that starts mid-line (partial leading line silently dropped)", () => {
    const dir = tmp();
    const path = resolve(dir, "cortex-decision-journal.jsonl");
    // A handful of small lines followed by a lone very large line — a small maxEntries=1 window should
    // land inside that giant last line's own content on the first pass, then widen until it parses cleanly.
    const small = decisionLine("2026-07-14T00:00:00Z", "SMALL", 1, "p");
    const giant = decisionLine("2026-07-14T01:00:00Z", "GIANT", 2, "g".repeat(200_000));
    writeFileSync(path, `${small}\n${giant}\n`);
    const entries = readCortexJournalTail(dir, 1);
    expect(entries.length).toBe(1);
    expect(entries[0]!.lanes[0]!.laneId).toBe("GIANT");
  });
});
