import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CortexBrainStore, CortexDecisionJournal, runCortexShadowTick } from "../src/lib/cortex-brain-store.js";
import {
  assembleCortexContext,
  CORTEX_FEATURE_DIM,
  CORTEX_FEATURE_SCHEMA_VERSION,
  type CortexRefitResult,
} from "../src/lib/cortex-brain.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cortex-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const accepted = (w: number[]): CortexRefitResult => ({ w, nEff: 100, status: "ACCEPTED" });
const rejected = (w: number[]): CortexRefitResult => ({ w, nEff: 2, status: "REJECTED_NON_CONVERGENCE" });

describe("CortexBrainStore", () => {
  it("a fresh store is the empty (static-reproducing) state", () => {
    const s = new CortexBrainStore(join(tmp(), "cortex.json"));
    expect(s.get().cumulativeResolved).toBe(0);
    expect(s.get().featureSchemaVersion).toBe(CORTEX_FEATURE_SCHEMA_VERSION);
    expect(s.get().archetypes.BREADTH.w.every((v) => v === 0)).toBe(true);
  });

  it("applyRefit writes ONLY on ACCEPTED (a rejected fit never touches the model)", () => {
    const s = new CortexBrainStore(join(tmp(), "cortex.json"));
    const good = new Array(CORTEX_FEATURE_DIM).fill(0.5);
    expect(s.applyRefit("BREADTH", accepted(good), "2026-07-12T00:00:00Z")).toBe(true);
    expect(s.get().archetypes.BREADTH.w).toEqual(good);

    const broken = new Array(CORTEX_FEATURE_DIM).fill(99);
    expect(s.applyRefit("BREADTH", rejected(broken), "2026-07-12T01:00:00Z")).toBe(false);
    expect(s.get().archetypes.BREADTH.w).toEqual(good); // unchanged — last healthy preserved
  });

  it("addResolved ramps the cumulative count and persists across reload", () => {
    const file = join(tmp(), "cortex.json");
    const s = new CortexBrainStore(file);
    s.addResolved(120, "2026-07-12T00:00:00Z");
    s.applyRefit("TACTICAL", accepted(new Array(CORTEX_FEATURE_DIM).fill(0.2)), "2026-07-12T00:00:00Z");
    s.save();

    const reloaded = new CortexBrainStore(file);
    expect(reloaded.get().cumulativeResolved).toBe(120);
    expect(reloaded.get().archetypes.TACTICAL.w).toEqual(new Array(CORTEX_FEATURE_DIM).fill(0.2));
  });

  it("discards a stored model from a stale feature schema (degrades to the seed)", () => {
    const file = join(tmp(), "cortex.json");
    const s = new CortexBrainStore(file);
    s.applyRefit("BREADTH", accepted(new Array(CORTEX_FEATURE_DIM).fill(0.7)), "2026-07-12T00:00:00Z");
    s.save();
    // corrupt the schema version on disk
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    raw.featureSchemaVersion = 999;
    writeFileSync(file, JSON.stringify(raw), "utf-8");

    const reloaded = new CortexBrainStore(file);
    expect(reloaded.get().archetypes.BREADTH.w.every((v) => v === 0)).toBe(true); // seeded, not trusted
  });
});

describe("CortexDecisionJournal", () => {
  it("appends jsonl records and never throws", () => {
    const file = join(tmp(), "journal.jsonl");
    const j = new CortexDecisionJournal(file);
    j.append({ kind: "BRAIN_DECISION", posture: "RISK_ON" });
    j.append({ kind: "BRAIN_DECISION", posture: "FLAT" });
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).posture).toBe("FLAT");
  });

  it("swallows a write to an impossible path", () => {
    const j = new CortexDecisionJournal("/proc/nonexistent/\0/journal.jsonl");
    expect(() => j.append({ x: 1 })).not.toThrow();
  });

  it("rotates to a single .1 backup when it exceeds the size cap (bounded, no unbounded growth)", () => {
    const file = join(tmp(), "journal.jsonl");
    const j = new CortexDecisionJournal(file, 200); // tiny cap for the test
    // Each record is well over 200 bytes → the 2nd append sees an over-cap file, rotates, starts fresh.
    const big = { kind: "BRAIN_DECISION", pad: "x".repeat(300) };
    j.append(big);
    j.append(big);
    j.append(big);
    // The live file holds only the most-recent record(s); the older ones rolled to .1 — total ≤ 2×cap window.
    expect(existsSync(`${file}.1`)).toBe(true);
    const liveLines = readFileSync(file, "utf-8").trim().split("\n");
    expect(liveLines.length).toBeLessThanOrEqual(2); // did NOT keep growing unbounded
    // and both files together still parse as valid jsonl (nothing corrupted by the rename)
    expect(() => readFileSync(`${file}.1`, "utf-8").trim().split("\n").forEach((l) => JSON.parse(l))).not.toThrow();
  });
});

describe("runCortexShadowTick (Phase 1: decide + journal, drive nothing)", () => {
  it("advances the resolved count, journals a valid decision, and reproduces static at β≈0", () => {
    const dir = tmp();
    const store = new CortexBrainStore(join(dir, "cortex.json"));
    const journal = new CortexDecisionJournal(join(dir, "journal.jsonl"));
    const context = assembleCortexContext(
      { regimeFamily: "BEARISH_EXPANSION", axisScore: -0.5, axisSlopePerHour: -0.02, allowLong: false, allowShort: true, portfolioDrawdownPct: 0, killBudgetUtilization: 0, killLatched: false },
      [{ laneId: "CG_WIDE_FAST_SHORT", direction: "SHORT", edgeMemAvgNetR: 0.1, edgeMemN: 40, laneNetAvgR: 0.1, laneNetAvgN: 40, lanePf: 1.2, crowdingAlign: 0, kronosAgree: null, convictionScore: 0.7, vetoed: false, staticWeightPct: 30 }],
    );
    const { decision, invariants } = runCortexShadowTick({ store, journal, context, nowIso: "2026-07-12T00:00:00Z", mode: "shadow", resolvedThisCycle: 3 });
    expect(invariants.ok).toBe(true);
    expect(store.get().cumulativeResolved).toBe(3);
    expect(decision.beta).toBeLessThan(0.01); // 3 closes ⇒ β≈0 ⇒ ~static
    expect(Math.abs(decision.lanes[0]!.finalPct - 30)).toBeLessThan(0.2);
    const line = JSON.parse(readFileSync(join(dir, "journal.jsonl"), "utf-8").trim());
    expect(line.kind).toBe("BRAIN_DECISION");
    expect(line.mode).toBe("shadow");
  });
});

describe("recordResolvedOutcomes (#218 — exact-once ledger, idempotent, per-family)", () => {
  const out = (laneId: string, id: string, fam: string, ms: number) => ({ laneId, observationId: id, regimeFamily: fam, resolvedAtMs: ms });
  it("advances cumulativeResolved + resolvedByFamily by DISTINCT outcomes", () => {
    const s = new CortexBrainStore(join(tmp(), "cortex.json"));
    const n = s.recordResolvedOutcomes(
      [out("L1", "a", "BULL", 100), out("L1", "b", "BULL", 200), out("L2", "c", "BEAR", 300)],
      0,
      "2026-07-13T00:00:00Z",
    );
    expect(n).toBe(3);
    expect(s.get().cumulativeResolved).toBe(3);
    expect(s.get().resolvedByFamily).toEqual({ BULL: 2, BEAR: 1 });
  });

  it("is EXACT-ONCE + out-of-order safe: re-running same outcomes (incl. a lower resolvedAtMs) adds 0", () => {
    const s = new CortexBrainStore(join(tmp(), "cortex.json"));
    s.recordResolvedOutcomes([out("L1", "a", "BULL", 500)], 0, "t0"); // high resolvedAtMs first
    // A distinct earlier-resolvedAt outcome that surfaces LATER is still counted (scalar watermark would drop it).
    expect(s.recordResolvedOutcomes([out("L1", "b", "BULL", 100)], 0, "t1")).toBe(1);
    // Re-running the same two adds nothing (exact-once by laneId::observationId).
    expect(s.recordResolvedOutcomes([out("L1", "a", "BULL", 500), out("L1", "b", "BULL", 100)], 0, "t2")).toBe(0);
    expect(s.get().cumulativeResolved).toBe(2);
    expect(s.get().resolvedByFamily).toEqual({ BULL: 2 });
  });

  it("prunes ledger ids older than pruneBeforeMs (bounded) without touching the counters", () => {
    const s = new CortexBrainStore(join(tmp(), "cortex.json"));
    s.recordResolvedOutcomes([out("L1", "old", "BULL", 100), out("L1", "new", "BULL", 10_000)], 5_000, "t0");
    expect(s.get().cumulativeResolved).toBe(2); // both counted
    expect(Object.keys(s.get().countedObservations)).toEqual(["L1::new"]); // "old" pruned (100 < 5000)
  });

  it("persists the counted ledger + counters across a save/reload", () => {
    const file = join(tmp(), "cortex.json");
    const s = new CortexBrainStore(file);
    s.recordResolvedOutcomes([out("L1", "a", "BULL", 100), out("L2", "b", "BEAR", 200)], 0, "t0");
    s.save();
    const reloaded = new CortexBrainStore(file);
    expect(reloaded.get().cumulativeResolved).toBe(2);
    expect(reloaded.get().resolvedByFamily).toEqual({ BULL: 1, BEAR: 1 });
    // The ledger persists → a post-reload re-run of the same outcomes still adds 0 (exact-once survives restart).
    expect(reloaded.recordResolvedOutcomes([out("L1", "a", "BULL", 100)], 0, "t1")).toBe(0);
  });
});
