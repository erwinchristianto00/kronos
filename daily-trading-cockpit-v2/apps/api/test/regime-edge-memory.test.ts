import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RegimeEdgeMemoryStore,
  edgeVerdict,
  normalizeRegimeFamily,
  EDGE_MIN_SAMPLES,
} from "../src/lib/regime-edge-memory.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "edge-mem-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("edgeVerdict (pure rule)", () => {
  it("cold-start (n < MIN_SAMPLES) → ALLOW_INSUFFICIENT regardless of avgR sign", () => {
    const v = edgeVerdict({ n: EDGE_MIN_SAMPLES - 1, wins: 0, sumNetR: -5, avgNetR: -0.5, winRate: 0 });
    expect(v.decision).toBe("ALLOW_INSUFFICIENT");
    expect(v.allowed).toBe(true);
  });

  it("proven non-positive (n ≥ MIN, avgR ≤ 0) → VETO_NEGATIVE", () => {
    const v = edgeVerdict({ n: 400, wins: 200, sumNetR: -0.8, avgNetR: -0.002, winRate: 50 });
    expect(v.decision).toBe("VETO_NEGATIVE");
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe("EDGE_PROVEN_NEGATIVE");
  });

  it("proven positive (n ≥ MIN, avgR > 0) → ALLOW_PROVEN", () => {
    const v = edgeVerdict({ n: 64, wins: 49, sumNetR: 23.9, avgNetR: 0.373, winRate: 76.6 });
    expect(v.decision).toBe("ALLOW_PROVEN");
    expect(v.allowed).toBe(true);
  });
});

describe("normalizeRegimeFamily", () => {
  it("maps the live + label variants", () => {
    expect(normalizeRegimeFamily("Bullish expansion")).toBe("BULLISH_EXPANSION");
    expect(normalizeRegimeFamily("Bearish pressure")).toBe("BEARISH_EXPANSION");
    expect(normalizeRegimeFamily("Mixed rotation")).toBe("MIXED_ROTATION");
    expect(normalizeRegimeFamily(null)).toBe("OTHER");
  });
});

describe("RegimeEdgeMemoryStore", () => {
  it("seeded proven-negative slice vetoes; proven-positive slice allows", () => {
    const store = new RegimeEdgeMemoryStore(tmpDir(), () => "2026-06-14T00:00:00.000Z");
    store.seed(
      [
        { regime: "BULLISH_EXPANSION", direction: "LONG", n: 418, wins: 227, sumNetR: -0.8 },
        { regime: "MIXED_ROTATION", direction: "SHORT", n: 64, wins: 49, sumNetR: 23.9 },
      ],
      "test",
    );
    expect(store.verdict("Bullish expansion", "LONG").allowed).toBe(false);
    expect(store.verdict("Mixed rotation", "SHORT").allowed).toBe(true);
    // unseen slice → cold-start → allowed
    expect(store.verdict("Bullish expansion", "SHORT").decision).toBe("ALLOW_INSUFFICIENT");
  });

  it("lookup merges frozen seed with live aggregate; live can flip the verdict", () => {
    const store = new RegimeEdgeMemoryStore(tmpDir(), () => "2026-06-14T00:00:00.000Z");
    // Seed says break-even-negative LONG over 40 trades (veto).
    store.seed([{ regime: "BULLISH_EXPANSION", direction: "LONG", n: 40, wins: 20, sumNetR: -0.4 }], "seed");
    expect(store.verdict("Bullish expansion", "LONG").allowed).toBe(false);
    // Live: 40 strongly-positive LONG closes pull the combined avgR positive.
    const liveWins = Array.from({ length: 40 }, (_, i) => ({
      paperStatus: "PAPER_CLOSED_WIN",
      direction: "LONG" as const,
      regime: "Bullish expansion",
      netR: 1.0,
    }));
    store.updateFromClosedOrders(liveWins);
    const v = store.verdict("Bullish expansion", "LONG");
    expect(v.stat.n).toBe(80);
    expect(v.allowed).toBe(true);
  });

  it("updateFromClosedOrders is idempotent, counts HEADLINE only, excludes diagnostic/backfill/open", () => {
    const store = new RegimeEdgeMemoryStore(tmpDir(), () => "2026-06-14T00:00:00.000Z");
    const orders = [
      { paperStatus: "PAPER_CLOSED_LOSS", direction: "SHORT" as const, regime: "Bearish expansion", netR: -1 },
      { paperStatus: "PAPER_CLOSED_WIN", direction: "SHORT" as const, regime: "Bearish expansion", netR: 1 },
      // EXCLUDED: diagnostic probe (reject-sampled candidate — biases the gate falsely-negative)
      { paperStatus: "PAPER_CLOSED_WIN", direction: "SHORT" as const, regime: "Bearish expansion", netR: 2, paperOrderMode: "DIAGNOSTIC_ONLY" },
      // EXCLUDED: synthetic backfill and still-open
      { paperStatus: "PAPER_CLOSED_WIN", direction: "SHORT" as const, regime: "Bearish expansion", netR: 5, diagnosticLabel: "BACKFILL_DIAGNOSTIC" },
      { paperStatus: "PAPER_SUBMITTED", direction: "SHORT" as const, regime: "Bearish expansion", netR: null },
    ];
    store.updateFromClosedOrders(orders);
    store.updateFromClosedOrders(orders); // second call must not double-count
    const stat = store.lookup("Bearish expansion", "SHORT");
    expect(stat.n).toBe(2); // only the 2 HEADLINE closes
    expect(stat.sumNetR).toBeCloseTo(0, 6); // -1 + 1
  });

  it("persists seed + live across reload", () => {
    const dir = tmpDir();
    const a = new RegimeEdgeMemoryStore(dir, () => "2026-06-14T00:00:00.000Z");
    a.seed([{ regime: "MIXED_ROTATION", direction: "SHORT", n: 64, wins: 49, sumNetR: 23.9 }], "seed");
    a.updateFromClosedOrders([
      { paperStatus: "PAPER_CLOSED_LOSS", direction: "LONG", regime: "Mixed rotation", netR: -1 },
    ]);
    a.save();
    const b = new RegimeEdgeMemoryStore(dir);
    expect(b.verdict("Mixed rotation", "SHORT").allowed).toBe(true);
    expect(b.lookup("Mixed rotation", "LONG").n).toBe(1);
  });

  // Lane-level gate: a positive lane keeps the direction open while the losing
  // lane in the same direction stays vetoed (the missed-edge fix).
  it("lane gate: positive tight lane allowed, negative wide lane vetoed, direction rescued", () => {
    const store = new RegimeEdgeMemoryStore(tmpDir(), () => "2026-06-14T00:00:00.000Z");
    store.seed(
      [
        // direction aggregate SHORT is negative (dominated by the wide lane)…
        { regime: "BEARISH_EXPANSION", direction: "SHORT", n: 2000, wins: 700, sumNetR: -400 },
        // …but a tight short LANE is proven-positive
        { regime: "BEARISH_EXPANSION", direction: "SHORT", lane: "CG_BASELINE_CURRENT", n: 237, wins: 210, sumNetR: 17.8 },
        { regime: "BEARISH_EXPANSION", direction: "SHORT", lane: "CG_WIDE_STOP_TP_WIDE", n: 1853, wins: 650, sumNetR: -467 },
      ],
      "test",
    );
    // direction aggregate verdict is VETO…
    expect(store.verdict("Bearish pressure", "SHORT").allowed).toBe(false);
    // …but a positive lane exists → direction is rescuable
    expect(store.hasPositiveLane("Bearish pressure", "SHORT")).toBe(true);
    // lane-level verdicts split correctly
    expect(store.laneVerdict("Bearish pressure", "SHORT", "CG_BASELINE_CURRENT").allowed).toBe(true);
    expect(store.laneVerdict("Bearish pressure", "SHORT", "CG_WIDE_STOP_TP_WIDE").allowed).toBe(false);
    // a lane with no evidence is cold-start → allowed
    expect(store.laneVerdict("Bearish pressure", "SHORT", "CG_WIDE_FAST_SHORT").decision).toBe("ALLOW_INSUFFICIENT");
    // no positive lane in a slice with only a negative lane
    expect(store.hasPositiveLane("Bearish pressure", "LONG")).toBe(false);
  });

  it("updateFromClosedOrders aggregates lane-level by selectedLaneId", () => {
    const store = new RegimeEdgeMemoryStore(tmpDir(), () => "2026-06-14T00:00:00.000Z");
    store.updateFromClosedOrders([
      { paperStatus: "PAPER_CLOSED_WIN", direction: "SHORT", regime: "Bearish pressure", netR: 0.3, selectedLaneId: "CG_VARIANT_MATRIX:CG_BASELINE_CURRENT" },
      { paperStatus: "PAPER_CLOSED_LOSS", direction: "SHORT", regime: "Bearish pressure", netR: -1, selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE" },
    ]);
    expect(store.laneLookup("Bearish pressure", "SHORT", "CG_BASELINE_CURRENT").n).toBe(1);
    expect(store.laneLookup("Bearish pressure", "SHORT", "CG_WIDE_STOP_TP_WIDE").sumNetR).toBeCloseTo(-1, 6);
    expect(store.lookup("Bearish pressure", "SHORT").n).toBe(2); // direction aggregate still counts both
  });
});
