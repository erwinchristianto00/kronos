import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RegimeEdgeMemoryStore,
  edgeVerdict,
  normalizeRegimeFamily,
  EDGE_MIN_SAMPLES,
  EDGE_MEMORY_BLOCK_WIDTH_MS,
  EDGE_MEMORY_FRESHNESS_LOOKBACK_MS,
  type ClosedOrderLike,
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

const NOW_ISO = "2026-06-14T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const HOUR_MS = EDGE_MEMORY_BLOCK_WIDTH_MS; // 1h — see module doc for why this is the clustering width

/** Store with a deterministic clock and NO cutover marker configured (cutover-specific tests inject
 *  their own resolver) — never relies on ambient process.env so the suite is deterministic regardless
 *  of what other test files in the same run set END_TO_END_CORRECTNESS_DEPLOYED_AT to. */
function makeStore(dir: string, resolvePolicyDeploymentAt: () => string | null = () => null): RegimeEdgeMemoryStore {
  return new RegimeEdgeMemoryStore(dir, () => NOW_ISO, resolvePolicyDeploymentAt);
}

/** One live HEADLINE order, `i` hours before NOW (so successive `i` land in distinct, fresh, 1h
 *  independence blocks — see EDGE_MEMORY_BLOCK_WIDTH_MS). */
function liveOrder(i: number, overrides: Partial<ClosedOrderLike> = {}): ClosedOrderLike {
  return {
    paperStatus: "PAPER_CLOSED_WIN",
    direction: "LONG",
    regime: "Bullish expansion",
    netR: 0.5,
    symbol: "BTCUSDT",
    resolvedAtMs: NOW_MS - (i + 1) * HOUR_MS,
    ...overrides,
  };
}

/** `count` live orders, each in its own distinct time block/symbol combo (so effectiveN === count),
 *  all comfortably within the freshness lookback. */
function makeProvenOrders(count: number, overrides: Partial<ClosedOrderLike> = {}): ClosedOrderLike[] {
  return Array.from({ length: count }, (_, i) => liveOrder(i, overrides));
}

describe("edgeVerdict (pure rule)", () => {
  it("cold-start (effectiveN < MIN_SAMPLES) → ALLOW_INSUFFICIENT regardless of lower-bound sign", () => {
    const v = edgeVerdict({
      n: 500, wins: 0, sumNetR: -5, avgNetR: -0.5, winRate: 0,
      effectiveN: EDGE_MIN_SAMPLES - 1, conservativeLowerBoundR: -0.5,
    });
    expect(v.decision).toBe("ALLOW_INSUFFICIENT");
    expect(v.allowed).toBe(true);
  });

  it("proven non-positive (effectiveN ≥ MIN, lower bound ≤ 0) → VETO_NEGATIVE", () => {
    const v = edgeVerdict({
      n: 400, wins: 200, sumNetR: -0.8, avgNetR: -0.002, winRate: 50,
      effectiveN: 40, conservativeLowerBoundR: -0.01,
    });
    expect(v.decision).toBe("VETO_NEGATIVE");
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe("EDGE_PROVEN_NEGATIVE");
  });

  it("un-boundable evidence (effectiveN ≥ MIN, lower bound null) → VETO_NEGATIVE, never a free pass", () => {
    const v = edgeVerdict({
      n: 100, wins: 60, sumNetR: 10, avgNetR: 0.1, winRate: 60,
      effectiveN: 40, conservativeLowerBoundR: null,
    });
    expect(v.decision).toBe("VETO_NEGATIVE");
    expect(v.allowed).toBe(false);
  });

  it("proven positive (effectiveN ≥ MIN, lower bound > 0) → ALLOW_PROVEN", () => {
    const v = edgeVerdict({
      n: 64, wins: 49, sumNetR: 23.9, avgNetR: 0.373, winRate: 76.6,
      effectiveN: 40, conservativeLowerBoundR: 0.2,
    });
    expect(v.decision).toBe("ALLOW_PROVEN");
    expect(v.allowed).toBe(true);
  });

  it("[Point 5] high raw n but low effectiveN still blocks ALLOW_PROVEN — the exact bug this point fixes", () => {
    const v = edgeVerdict({
      n: 5000, wins: 4000, sumNetR: 2000, avgNetR: 0.4, winRate: 80,
      effectiveN: 3, conservativeLowerBoundR: null,
    });
    expect(v.decision).toBe("ALLOW_INSUFFICIENT");
    expect(v.decision).not.toBe("ALLOW_PROVEN");
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
  it("[Point 5d] seed-only slices can never reach ALLOW_PROVEN or VETO_NEGATIVE — only ALLOW_INSUFFICIENT", () => {
    const store = makeStore(tmpDir());
    store.seed(
      [
        // Looks "proven-negative" by the OLD raw-n/avgR rule (n=418 ≥ 30, avgR<0)…
        { regime: "BULLISH_EXPANSION", direction: "LONG", n: 418, wins: 227, sumNetR: -0.8 },
        // …and this looks "proven-positive" by the OLD rule (n=640 ≥ 30, avgR>0).
        { regime: "MIXED_ROTATION", direction: "SHORT", n: 640, wins: 490, sumNetR: 239 },
      ],
      "test",
    );
    const negLooking = store.verdict("Bullish expansion", "LONG");
    expect(negLooking.decision).toBe("ALLOW_INSUFFICIENT"); // NEVER VETO_NEGATIVE from seed alone
    expect(negLooking.stat.effectiveN).toBe(0);
    expect(negLooking.stat.conservativeLowerBoundR).toBeNull();

    const posLooking = store.verdict("Mixed rotation", "SHORT");
    expect(posLooking.decision).toBe("ALLOW_INSUFFICIENT"); // NEVER ALLOW_PROVEN from seed alone
    expect(posLooking.stat.effectiveN).toBe(0);
    expect(posLooking.stat.conservativeLowerBoundR).toBeNull();

    // unseen slice → cold-start → same tier, for consistency
    expect(store.verdict("Bullish expansion", "SHORT").decision).toBe("ALLOW_INSUFFICIENT");
  });

  it("lookup merges seed's raw n into live's, but ALLOW_PROVEN requires genuine LIVE evidence", () => {
    const store = makeStore(tmpDir());
    store.seed([{ regime: "BULLISH_EXPANSION", direction: "LONG", n: 40, wins: 20, sumNetR: -0.4 }], "seed");
    expect(store.verdict("Bullish expansion", "LONG").decision).toBe("ALLOW_INSUFFICIENT");

    const liveWins = makeProvenOrders(EDGE_MIN_SAMPLES, { netR: 1.0 });
    store.updateFromClosedOrders(liveWins);
    const v = store.verdict("Bullish expansion", "LONG");
    expect(v.stat.n).toBe(40 + EDGE_MIN_SAMPLES); // merged raw n: seed + live (informational)
    expect(v.stat.effectiveN).toBe(EDGE_MIN_SAMPLES); // seed contributes 0 — this is ALL live
    expect(v.decision).toBe("ALLOW_PROVEN");
    expect(v.allowed).toBe(true);
  });

  it("updateFromClosedOrders is idempotent, counts HEADLINE only, excludes diagnostic/backfill/open", () => {
    const store = makeStore(tmpDir());
    const orders: ClosedOrderLike[] = [
      { paperStatus: "PAPER_CLOSED_LOSS", direction: "SHORT", regime: "Bearish expansion", netR: -1 },
      { paperStatus: "PAPER_CLOSED_WIN", direction: "SHORT", regime: "Bearish expansion", netR: 1 },
      // EXCLUDED: diagnostic probe (reject-sampled candidate — biases the gate falsely-negative)
      { paperStatus: "PAPER_CLOSED_WIN", direction: "SHORT", regime: "Bearish expansion", netR: 2, paperOrderMode: "DIAGNOSTIC_ONLY" },
      // EXCLUDED: synthetic backfill and still-open
      { paperStatus: "PAPER_CLOSED_WIN", direction: "SHORT", regime: "Bearish expansion", netR: 5, diagnosticLabel: "BACKFILL_DIAGNOSTIC" },
      { paperStatus: "PAPER_SUBMITTED", direction: "SHORT", regime: "Bearish expansion", netR: null },
    ];
    store.updateFromClosedOrders(orders);
    store.updateFromClosedOrders(orders); // second call must not double-count
    const stat = store.lookup("Bearish expansion", "SHORT");
    expect(stat.n).toBe(2); // only the 2 HEADLINE closes
    expect(stat.sumNetR).toBeCloseTo(0, 6); // -1 + 1
  });

  it("persists seed + live across reload", () => {
    const dir = tmpDir();
    const a = makeStore(dir);
    a.seed([{ regime: "MIXED_ROTATION", direction: "SHORT", n: 64, wins: 49, sumNetR: 23.9 }], "seed");
    a.updateFromClosedOrders([
      { paperStatus: "PAPER_CLOSED_LOSS", direction: "LONG", regime: "Mixed rotation", netR: -1, symbol: "ETHUSDT", resolvedAtMs: NOW_MS - HOUR_MS },
    ]);
    a.save();
    const b = makeStore(dir);
    expect(b.verdict("Mixed rotation", "SHORT").decision).toBe("ALLOW_INSUFFICIENT"); // seed-only, never "proven"
    expect(b.lookup("Mixed rotation", "LONG").n).toBe(1);
  });

  // Lane-level gate: a positive lane keeps the direction open while the losing
  // lane in the same direction stays vetoed (the missed-edge fix). Requires genuine LIVE evidence
  // per lane — Point 5d applies at the lane level too.
  it("lane gate (LIVE evidence): positive tight lane allowed, negative wide lane vetoed, direction rescued", () => {
    const store = makeStore(tmpDir());
    const tightWins = Array.from({ length: EDGE_MIN_SAMPLES }, (_, i) => liveOrder(i, {
      direction: "SHORT", regime: "Bearish expansion", netR: 0.3, selectedLaneId: "CG_VARIANT_MATRIX:CG_BASELINE_CURRENT",
    }));
    const wideLosses = Array.from({ length: EDGE_MIN_SAMPLES }, (_, i) => liveOrder(100 + i, {
      direction: "SHORT", regime: "Bearish expansion", netR: -0.4, selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE",
    }));
    store.updateFromClosedOrders([...tightWins, ...wideLosses]);

    // direction aggregate blends both lanes (30×0.3 + 30×-0.4 → net negative) → vetoed…
    expect(store.verdict("Bearish pressure", "SHORT").decision).toBe("VETO_NEGATIVE");
    // …but a positive lane exists → direction is rescuable
    expect(store.hasPositiveLane("Bearish pressure", "SHORT")).toBe(true);
    // lane-level verdicts split correctly
    expect(store.laneVerdict("Bearish pressure", "SHORT", "CG_BASELINE_CURRENT").decision).toBe("ALLOW_PROVEN");
    expect(store.laneVerdict("Bearish pressure", "SHORT", "CG_WIDE_STOP_TP_WIDE").decision).toBe("VETO_NEGATIVE");
    // a lane with no evidence is cold-start → allowed
    expect(store.laneVerdict("Bearish pressure", "SHORT", "CG_WIDE_FAST_SHORT").decision).toBe("ALLOW_INSUFFICIENT");
    // no positive lane in a slice with only a negative lane
    expect(store.hasPositiveLane("Bearish pressure", "LONG")).toBe(false);
  });

  it("[Point 5d] a seed-only positive-looking lane cannot rescue a direction — hasPositiveLane requires LIVE proof", () => {
    const store = makeStore(tmpDir());
    store.seed(
      [{ regime: "BEARISH_EXPANSION", direction: "SHORT", lane: "CG_BASELINE_CURRENT", n: 237, wins: 210, sumNetR: 17.8 }],
      "test",
    );
    expect(store.laneVerdict("Bearish pressure", "SHORT", "CG_BASELINE_CURRENT").decision).toBe("ALLOW_INSUFFICIENT");
    expect(store.hasPositiveLane("Bearish pressure", "SHORT")).toBe(false);
  });

  it("updateFromClosedOrders aggregates lane-level by selectedLaneId", () => {
    const store = makeStore(tmpDir());
    store.updateFromClosedOrders([
      { paperStatus: "PAPER_CLOSED_WIN", direction: "SHORT", regime: "Bearish pressure", netR: 0.3, selectedLaneId: "CG_VARIANT_MATRIX:CG_BASELINE_CURRENT" },
      { paperStatus: "PAPER_CLOSED_LOSS", direction: "SHORT", regime: "Bearish pressure", netR: -1, selectedLaneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE" },
    ]);
    expect(store.laneLookup("Bearish pressure", "SHORT", "CG_BASELINE_CURRENT").n).toBe(1);
    expect(store.laneLookup("Bearish pressure", "SHORT", "CG_WIDE_STOP_TP_WIDE").sumNetR).toBeCloseTo(-1, 6);
    expect(store.lookup("Bearish pressure", "SHORT").n).toBe(2); // direction aggregate still counts both
  });
});

describe("Point 5 — effectiveN over raw n (clustered same-instant rows)", () => {
  it("[FAIL] 200 rows resolved in the SAME hour block + symbol collapse to effectiveN=1, stay ALLOW_INSUFFICIENT", () => {
    const store = makeStore(tmpDir());
    const orders = Array.from({ length: 200 }, () => liveOrder(0, { netR: 0.5 }));
    store.updateFromClosedOrders(orders);
    const v = store.verdict("Bullish expansion", "LONG");
    expect(v.stat.n).toBe(200); // raw count stays visible for telemetry…
    expect(v.stat.effectiveN).toBe(1); // …but is ONE independent observation, not 200
    expect(v.decision).toBe("ALLOW_INSUFFICIENT");
    expect(v.decision).not.toBe("ALLOW_PROVEN");
  });

  it("[PASS] the same total n spread across ≥ EDGE_MIN_SAMPLES distinct blocks reaches ALLOW_PROVEN", () => {
    const store = makeStore(tmpDir());
    const orders = makeProvenOrders(EDGE_MIN_SAMPLES, { netR: 0.5 });
    store.updateFromClosedOrders(orders);
    const v = store.verdict("Bullish expansion", "LONG");
    expect(v.stat.effectiveN).toBe(EDGE_MIN_SAMPLES);
    expect(v.stat.conservativeLowerBoundR).not.toBeNull();
    expect(v.stat.conservativeLowerBoundR as number).toBeGreaterThan(0);
    expect(v.decision).toBe("ALLOW_PROVEN");
    expect(v.allowed).toBe(true);
  });
});

describe("Point 5e — cost-model cohort (never pool generations)", () => {
  it("[PASS] the newest cost-model generation is used exclusively, excluding an old strongly-negative one", () => {
    const store = makeStore(tmpDir());
    const oldGen = Array.from({ length: 60 }, (_, i) => liveOrder(i, { netR: -1.0, costModelVersion: 1 }));
    const newGen = Array.from({ length: 35 }, (_, i) => liveOrder(100 + i, { netR: 0.5, costModelVersion: 2 }));
    store.updateFromClosedOrders([...oldGen, ...newGen]);
    const v = store.verdict("Bullish expansion", "LONG");
    expect(v.stat.effectiveN).toBe(35); // only the newest generation's rows — the old 60 never pool in
    expect(v.decision).toBe("ALLOW_PROVEN");
  });

  it("an old-only generation can still gate itself (VETO_NEGATIVE) when it is the only cohort available", () => {
    const store = makeStore(tmpDir());
    const oldGen = Array.from({ length: 40 }, (_, i) => liveOrder(i, { netR: -1.0, costModelVersion: 1 }));
    store.updateFromClosedOrders(oldGen);
    expect(store.verdict("Bullish expansion", "LONG").decision).toBe("VETO_NEGATIVE");
  });
});

describe("Point 5f — policy-deployment cutover", () => {
  const CURRENT_DEPLOY = "2026-06-01T00:00:00.000Z";
  const STALE_DEPLOY = "2026-05-01T00:00:00.000Z";

  it("[FAIL] pre-cutover-stamped rows do not count toward current proof, even with high raw n", () => {
    const store = makeStore(tmpDir(), () => CURRENT_DEPLOY);
    const orders = makeProvenOrders(EDGE_MIN_SAMPLES + 10, { netR: 0.5, policyDeploymentAt: STALE_DEPLOY });
    store.updateFromClosedOrders(orders);
    const v = store.verdict("Bullish expansion", "LONG");
    expect(v.stat.effectiveN).toBe(0);
    expect(v.decision).toBe("ALLOW_INSUFFICIENT");
  });

  it("[PASS] current-marker-stamped rows DO count and can reach ALLOW_PROVEN", () => {
    const store = makeStore(tmpDir(), () => CURRENT_DEPLOY);
    const orders = makeProvenOrders(EDGE_MIN_SAMPLES + 10, { netR: 0.5, policyDeploymentAt: CURRENT_DEPLOY });
    store.updateFromClosedOrders(orders);
    expect(store.verdict("Bullish expansion", "LONG").decision).toBe("ALLOW_PROVEN");
  });

  it("no cutover configured (resolver returns null) does not retroactively block otherwise-valid evidence", () => {
    const store = makeStore(tmpDir(), () => null);
    const orders = makeProvenOrders(EDGE_MIN_SAMPLES, { netR: 0.5 }); // unstamped
    store.updateFromClosedOrders(orders);
    expect(store.verdict("Bullish expansion", "LONG").decision).toBe("ALLOW_PROVEN");
  });
});

describe("Point 5 — freshness lookback", () => {
  it("[FAIL] evidence older than the lookback window does not count toward current proof", () => {
    const store = makeStore(tmpDir());
    const staleBaseMs = EDGE_MEMORY_FRESHNESS_LOOKBACK_MS + 10 * HOUR_MS; // just past the lookback edge
    const orders = Array.from({ length: EDGE_MIN_SAMPLES + 5 }, (_, i) => liveOrder(i, {
      netR: 0.5,
      resolvedAtMs: NOW_MS - staleBaseMs - i * HOUR_MS,
    }));
    store.updateFromClosedOrders(orders);
    const v = store.verdict("Bullish expansion", "LONG");
    expect(v.stat.effectiveN).toBe(0);
    expect(v.decision).toBe("ALLOW_INSUFFICIENT");
  });

  it("[PASS] evidence within the lookback window counts", () => {
    const store = makeStore(tmpDir());
    const orders = makeProvenOrders(EDGE_MIN_SAMPLES, { netR: 0.5 });
    store.updateFromClosedOrders(orders);
    expect(store.verdict("Bullish expansion", "LONG").decision).toBe("ALLOW_PROVEN");
  });
});
