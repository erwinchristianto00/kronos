import { describe, it, expect } from "vitest";
import {
  resolveEntryBrainTier1Realized,
  resolveEntryBrainTier1RealizedWithDiagnostics,
  ENTRY_BRAIN_TIER1_DEFAULT_TTL_MS,
  type EntryBrainTier1ResolvedRow,
} from "../src/lib/entry-brain-tier1-realized-resolver.js";
import type { PendingEntryRow } from "../src/lib/four-brain-outcome-ledger.js";
import type { PositionPath } from "../src/lib/position-path-recorder.js";

const MIN = 60_000;

function pendingRow(over: Partial<PendingEntryRow> & { decisionId: string; asOfMs: number }): PendingEntryRow {
  // NOTE: uses `"key" in over` (not `??`) for laneId/symbolOrBasketId — `??` treats an explicitly
  // passed `null` as "absent" too, which would silently defeat tests that pass laneId: null on purpose.
  return {
    decisionId: over.decisionId,
    asOfMs: over.asOfMs,
    ...("signalId" in over ? { signalId: over.signalId } : {}),
    symbolOrBasketId: "symbolOrBasketId" in over ? (over.symbolOrBasketId as string | null) : "BTCUSDT",
    laneId: "laneId" in over ? (over.laneId as string | null) : "L1",
    side: over.side ?? "LONG",
    action: over.action ?? "ENTER_NOW",
    targetEntry: over.targetEntry ?? 100,
    initialStopPrice: over.initialStopPrice ?? 95,
    expectedNetR: over.expectedNetR ?? 0.5,
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
  lastTickR?: number;
  signalId?: string | null;
}): PositionPath {
  return {
    key: over.key,
    meta: {
      laneId: over.laneId ?? "L1",
      symbol: over.symbol ?? "BTCUSDT",
      direction: over.direction ?? "LONG",
      ...("signalId" in over ? { signalId: over.signalId } : {}),
      source: "engine",
    },
    ticks: [
      { t: over.firstTickMs, r: 0 },
      { t: over.closedAtMs, r: over.lastTickR ?? 0.4 },
    ],
    rawTickCount: 2,
    thinned: 0,
    closedAtMs: over.closedAtMs,
    closeR: over.closeR === undefined ? 0.4 : over.closeR,
  };
}

describe("entry-brain-tier1-realized-resolver — strict windowed match", () => {
  it("reports the exact rejection reason instead of only a zero match count", () => {
    const pending = [
      pendingRow({ decisionId: "canonical-lane", asOfMs: 10 * MIN, laneId: "COMPOSITE_ESTIMATOR_BIDI_FAST_LONG" }),
      pendingRow({ decisionId: "missing-id", asOfMs: 10 * MIN, laneId: null }),
    ];
    const closed = [
      closedPath({
        key: "vm-close",
        laneId: "CG_LONG_VARIANT_MATRIX:LG_FAST",
        firstTickMs: 12 * MIN,
        closedAtMs: 20 * MIN,
      }),
    ];
    const result = resolveEntryBrainTier1RealizedWithDiagnostics(pending, closed);
    expect(result.diagnostics.matchedRows).toBe(0);
    expect(result.diagnostics.rejectionReasons.NO_EXACT_LANE_SYMBOL_SIDE_CLOSE).toBe(1);
    expect(result.diagnostics.rejectionReasons.MISSING_IDENTITY).toBe(1);
    expect(result.diagnostics.matchableClosedPaths).toBe(1);
  });

  it("joins a pending Entry decision to the real close that opened within its TTL window", () => {
    const decisionAsOf = 10 * MIN;
    const openedAtMs = 12 * MIN; // within [decisionAsOf, decisionAsOf+ttl] window from the close's perspective
    const closedAtMs = 60 * MIN;
    const pending = [pendingRow({ decisionId: "d1", asOfMs: decisionAsOf })];
    const closed = [closedPath({ key: "pp:1", firstTickMs: openedAtMs, closedAtMs, closeR: 0.7 })];

    const result = resolveEntryBrainTier1Realized(pending, closed);
    expect(result).toHaveLength(1);
    const row = result[0]!;
    expect(row.status).toBe("RESOLVED");
    const resolved = row as EntryBrainTier1ResolvedRow;
    expect(resolved.confidence).toBe("MEASURED");
    expect(resolved.decisionId).toBe("d1");
    expect(resolved.matchedCloseKey).toBe("pp:1");
    expect(resolved.realizedR).toBe(0.7);
    expect(resolved.openedAtMs).toBe(openedAtMs);
    expect(resolved.closedAtMs).toBe(closedAtMs);
  });

  it("uses exact signal identity when multiple same-lane candidates share a time window", () => {
    const pending = [
      pendingRow({ decisionId: "wrong-signal", signalId: "obs-a", asOfMs: 11 * MIN }),
      pendingRow({ decisionId: "owning-signal", signalId: "obs-b", asOfMs: 10 * MIN }),
    ];
    const closed = [
      closedPath({
        key: "pp:signal",
        signalId: "obs-b",
        firstTickMs: 12 * MIN,
        closedAtMs: 50 * MIN,
      }),
    ];

    const result = resolveEntryBrainTier1RealizedWithDiagnostics(pending, closed);
    const byId = new Map(result.rows.map((row) => [row.decisionId, row]));
    expect(byId.get("owning-signal")?.status).toBe("RESOLVED");
    expect(byId.get("wrong-signal")?.status).toBe("PENDING");
    expect(result.diagnostics.signalIdentityMatches).toBe(1);
    expect(result.diagnostics.rejectionReasons.SIGNAL_ID_MISMATCH).toBe(1);
  });

  it("never falls back to a newer decision carrying a different non-null signal id", () => {
    const pending = [
      pendingRow({ decisionId: "different", signalId: "obs-other", asOfMs: 11 * MIN }),
    ];
    const closed = [
      closedPath({
        key: "pp:different",
        signalId: "obs-real",
        firstTickMs: 12 * MIN,
        closedAtMs: 50 * MIN,
      }),
    ];

    const result = resolveEntryBrainTier1RealizedWithDiagnostics(pending, closed);
    expect(result.rows[0]?.status).toBe("PENDING");
    expect(result.diagnostics.rejectionReasons.SIGNAL_ID_MISMATCH).toBe(1);
  });

  it("joins canonical and variant-matrix lane namespaces without rewriting historical identity", () => {
    const pending = [
      pendingRow({
        decisionId: "canonical",
        asOfMs: 10 * MIN,
        laneId: "CG_WIDE_FAST_LONG",
        symbolOrBasketId: "btcusdt",
      }),
    ];
    const closed = [
      closedPath({
        key: "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG::BTCUSDT::LONG::real-1",
        laneId: "CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG",
        firstTickMs: 12 * MIN,
        closedAtMs: 50 * MIN,
      }),
    ];

    const result = resolveEntryBrainTier1RealizedWithDiagnostics(pending, closed);
    const row = result.rows[0] as EntryBrainTier1ResolvedRow;
    expect(row.status).toBe("RESOLVED");
    expect(row.laneId).toBe("CG_WIDE_FAST_LONG");
    expect(row.matchedCloseKey).toBe("CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG::BTCUSDT::LONG::real-1");
    expect(result.diagnostics.namespaceNormalizedMatches).toBe(1);
  });

  it("normalizes both matrix namespaces but still keeps side as a strict independent axis", () => {
    const pending = [
      pendingRow({
        decisionId: "long-matrix",
        asOfMs: 10 * MIN,
        laneId: "CG_LONG_VARIANT_MATRIX:CG_EXP_MFE_10X",
        side: "LONG",
      }),
    ];
    const wrongSide = closedPath({
      key: "wrong-side",
      laneId: "CG_VARIANT_MATRIX:CG_EXP_MFE_10X",
      direction: "SHORT",
      firstTickMs: 12 * MIN,
      closedAtMs: 50 * MIN,
    });
    expect(resolveEntryBrainTier1Realized(pending, [wrongSide])[0]!.status).toBe("PENDING");

    const rightSide = { ...wrongSide, key: "right-side", meta: { ...wrongSide.meta!, direction: "LONG" as const } };
    expect(resolveEntryBrainTier1Realized(pending, [rightSide])[0]!.status).toBe("RESOLVED");
  });

  it("never claims an out-of-window close (decision too far before open)", () => {
    const decisionAsOf = 0;
    const openedAtMs = ENTRY_BRAIN_TIER1_DEFAULT_TTL_MS + 5 * MIN; // outside ttl from decisionAsOf
    const closedAtMs = openedAtMs + 50 * MIN;
    const pending = [pendingRow({ decisionId: "d-stale", asOfMs: decisionAsOf })];
    const closed = [closedPath({ key: "pp:stale", firstTickMs: openedAtMs, closedAtMs })];

    const result = resolveEntryBrainTier1Realized(pending, closed);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("PENDING");
  });

  it("never claims a decision made AFTER the close's own open", () => {
    const openedAtMs = 10 * MIN;
    const decisionAsOf = openedAtMs + 5 * MIN; // decision comes after the real open — cannot be the cause
    const closedAtMs = openedAtMs + 60 * MIN;
    const pending = [pendingRow({ decisionId: "d-late", asOfMs: decisionAsOf })];
    const closed = [closedPath({ key: "pp:late", firstTickMs: openedAtMs, closedAtMs })];

    const result = resolveEntryBrainTier1Realized(pending, closed);
    expect(result[0]!.status).toBe("PENDING");
  });

  it("with 2 candidate decisions and 1 close, only the correct (latest in-window) decision wins", () => {
    const openedAtMs = 40 * MIN;
    const closedAtMs = 100 * MIN;
    const earlier = pendingRow({ decisionId: "d-earlier", asOfMs: 5 * MIN });
    const correct = pendingRow({ decisionId: "d-correct", asOfMs: 38 * MIN }); // latest at-or-before open
    const closed = [closedPath({ key: "pp:one", firstTickMs: openedAtMs, closedAtMs })];

    const result = resolveEntryBrainTier1Realized([earlier, correct], closed);
    const byId = new Map(result.map((r) => [r.decisionId, r]));

    expect(byId.get("d-correct")!.status).toBe("RESOLVED");
    expect((byId.get("d-correct") as EntryBrainTier1ResolvedRow).matchedCloseKey).toBe("pp:one");
    expect(byId.get("d-earlier")!.status).toBe("PENDING");
  });

  it("a decision, once it claims a close, can never be reused to claim a second close (no double-count)", () => {
    const decisionAsOf = 10 * MIN;
    const pending = [pendingRow({ decisionId: "d-shared", asOfMs: decisionAsOf })];
    const closeA = closedPath({ key: "pp:a", firstTickMs: 12 * MIN, closedAtMs: 50 * MIN, closeR: 0.3 });
    const closeB = closedPath({ key: "pp:b", firstTickMs: 13 * MIN, closedAtMs: 55 * MIN, closeR: 0.9 });

    const result = resolveEntryBrainTier1Realized(pending, [closeA, closeB]);
    // Only one output row per input decision — it can only be resolved against ONE close.
    expect(result).toHaveLength(1);
    const resolved = result[0] as EntryBrainTier1ResolvedRow;
    expect(resolved.status).toBe("RESOLVED");
    // Deterministic: closes are processed oldest-open-first, so the older close (pp:a) wins the claim.
    expect(resolved.matchedCloseKey).toBe("pp:a");
    expect(resolved.realizedR).toBe(0.3);
  });

  it("an unmatched pending row returns PENDING, never a fabricated value", () => {
    const pending = [pendingRow({ decisionId: "d-lonely", asOfMs: 10 * MIN })];
    const result = resolveEntryBrainTier1Realized(pending, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      decisionId: "d-lonely",
      status: "PENDING",
      laneId: "L1",
      symbolOrBasketId: "BTCUSDT",
      side: "LONG",
      decisionAsOfMs: 10 * MIN,
      expectedNetR: 0.5,
    });
  });

  it("a pending row with null laneId/symbolOrBasketId can never be joined — always PENDING", () => {
    const pending = [
      pendingRow({ decisionId: "d-no-lane", asOfMs: 10 * MIN, laneId: null }),
      pendingRow({ decisionId: "d-no-symbol", asOfMs: 10 * MIN, symbolOrBasketId: null }),
    ];
    const closed = [closedPath({ key: "pp:x", firstTickMs: 12 * MIN, closedAtMs: 50 * MIN })];

    const result = resolveEntryBrainTier1Realized(pending, closed);
    expect(result.every((r) => r.status === "PENDING")).toBe(true);
  });

  it("does not match across different laneId, symbol, or side", () => {
    const pending = [
      pendingRow({ decisionId: "d-wrong-lane", asOfMs: 10 * MIN, laneId: "OTHER_LANE" }),
      pendingRow({ decisionId: "d-wrong-symbol", asOfMs: 10 * MIN, symbolOrBasketId: "ETHUSDT" }),
      pendingRow({ decisionId: "d-wrong-side", asOfMs: 10 * MIN, side: "SHORT" }),
      pendingRow({ decisionId: "d-right", asOfMs: 10 * MIN }),
    ];
    const closed = [closedPath({ key: "pp:y", firstTickMs: 12 * MIN, closedAtMs: 50 * MIN })];

    const result = resolveEntryBrainTier1Realized(pending, closed);
    const byId = new Map(result.map((r) => [r.decisionId, r]));
    expect(byId.get("d-wrong-lane")!.status).toBe("PENDING");
    expect(byId.get("d-wrong-symbol")!.status).toBe("PENDING");
    expect(byId.get("d-wrong-side")!.status).toBe("PENDING");
    expect(byId.get("d-right")!.status).toBe("RESOLVED");
  });

  it("skips closed paths with no meta, no closedAtMs, or no honest R (never fabricates a join)", () => {
    const pending = [pendingRow({ decisionId: "d1", asOfMs: 10 * MIN })];
    const noMeta: PositionPath = { ...closedPath({ key: "pp:nometa", firstTickMs: 12 * MIN, closedAtMs: 50 * MIN }), meta: null };
    const notClosed: PositionPath = { ...closedPath({ key: "pp:open", firstTickMs: 12 * MIN, closedAtMs: 50 * MIN }), closedAtMs: null };
    const noR: PositionPath = {
      ...closedPath({ key: "pp:nor", firstTickMs: 12 * MIN, closedAtMs: 50 * MIN }),
      closeR: null,
      ticks: [],
    };

    const result = resolveEntryBrainTier1Realized(pending, [noMeta, notClosed, noR]);
    expect(result[0]!.status).toBe("PENDING");
  });

  it("is idempotent: repeated calls over the same snapshot never accumulate or double-count", () => {
    const pending = [pendingRow({ decisionId: "d1", asOfMs: 10 * MIN })];
    const closed = [closedPath({ key: "pp:rep", firstTickMs: 12 * MIN, closedAtMs: 50 * MIN, closeR: 0.6 })];

    const first = resolveEntryBrainTier1Realized(pending, closed);
    const second = resolveEntryBrainTier1Realized(pending, closed);
    const third = resolveEntryBrainTier1Realized(pending, closed);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(third).toHaveLength(1);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect((first[0] as EntryBrainTier1ResolvedRow).realizedR).toBe(0.6);

    // Inputs must not have been mutated by any call.
    expect(pending[0]!.decisionId).toBe("d1");
    expect(closed[0]!.key).toBe("pp:rep");
  });

  it("respects a custom ttlMsForLane instead of the default", () => {
    const decisionAsOf = 0;
    const openedAtMs = 10 * MIN; // would be out-of-window under a 5-min ttl
    const closedAtMs = 40 * MIN;
    const pending = [pendingRow({ decisionId: "d-shortttl", asOfMs: decisionAsOf })];
    const closed = [closedPath({ key: "pp:shortttl", firstTickMs: openedAtMs, closedAtMs })];

    const tightTtl = resolveEntryBrainTier1Realized(pending, closed, { ttlMsForLane: () => 5 * MIN });
    expect(tightTtl[0]!.status).toBe("PENDING");

    const looseTtl = resolveEntryBrainTier1Realized(pending, closed, { ttlMsForLane: () => 15 * MIN });
    expect(looseTtl[0]!.status).toBe("RESOLVED");
  });

  it("falls back to the last tick's r as realizedR when closeR is unset", () => {
    const pending = [pendingRow({ decisionId: "d1", asOfMs: 10 * MIN })];
    const closed = [
      closedPath({ key: "pp:fallback", firstTickMs: 12 * MIN, closedAtMs: 50 * MIN, closeR: null, lastTickR: 0.25 }),
    ];
    const result = resolveEntryBrainTier1Realized(pending, closed);
    expect((result[0] as EntryBrainTier1ResolvedRow).realizedR).toBe(0.25);
  });

  it("tags realizedRSource verbatim from the matched close's meta.source, so RAW (executor) and NET " +
    "(engine) realizedR are never silently mixed as the same unit downstream", () => {
    const pendingEngine = pendingRow({ decisionId: "d-engine", asOfMs: 10 * MIN, symbolOrBasketId: "BTCUSDT" });
    const pendingExecutor = pendingRow({ decisionId: "d-executor", asOfMs: 10 * MIN, symbolOrBasketId: "ETHUSDT" });
    const engineClose: PositionPath = {
      ...closedPath({ key: "pp:engine", symbol: "BTCUSDT", firstTickMs: 12 * MIN, closedAtMs: 50 * MIN, closeR: 0.5 }),
      meta: { laneId: "L1", symbol: "BTCUSDT", direction: "LONG", source: "engine" },
    };
    const executorClose: PositionPath = {
      ...closedPath({ key: "pp:executor", symbol: "ETHUSDT", firstTickMs: 12 * MIN, closedAtMs: 50 * MIN, closeR: 0.5 }),
      meta: { laneId: "L1", symbol: "ETHUSDT", direction: "LONG", source: "executor" },
    };

    const result = resolveEntryBrainTier1Realized([pendingEngine, pendingExecutor], [engineClose, executorClose]);
    const byId = new Map(result.map((r) => [r.decisionId, r]));

    expect((byId.get("d-engine") as EntryBrainTier1ResolvedRow).realizedRSource).toBe("engine");
    expect((byId.get("d-executor") as EntryBrainTier1ResolvedRow).realizedRSource).toBe("executor");
  });
});
