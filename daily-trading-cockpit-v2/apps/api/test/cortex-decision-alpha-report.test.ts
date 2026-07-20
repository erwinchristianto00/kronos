import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCortexShadowDecisionAlphaReport } from "../src/lib/cortex-decision-alpha-report.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cortex-decision-alpha-report-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("buildCortexShadowDecisionAlphaReport (#219, 2026-07-20)", () => {
  it("on an empty/fresh instance (no journal, no lane stores yet) reports zero examples, never a fabricated 0-edge", () => {
    const dataDir = tmp();
    const report = buildCortexShadowDecisionAlphaReport({
      dataDir,
      journalFile: join(dataDir, "cortex-decision-journal.jsonl"),
      nowMs: Date.parse("2026-07-20T00:00:00Z"),
    });
    expect(report.reportOnly).toBe(true);
    expect(report.examplesConsidered).toBe(0);
    expect(report.journalBadLines).toBe(0);
    expect(report.decisionAlpha).toEqual({ n: 0, cumulativeTiltDeltaR: 0, meanTiltDeltaR: null, perLane: [] });
  });

  it("is a pure read: never writes to the journal file or any store under dataDir", () => {
    const dataDir = tmp();
    const journalFile = join(dataDir, "cortex-decision-journal.jsonl");
    buildCortexShadowDecisionAlphaReport({ dataDir, journalFile, nowMs: Date.now() });
    expect(existsSync(journalFile)).toBe(false); // never created — nothing to write
  });
});
