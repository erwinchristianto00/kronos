/**
 * Four-Brain edge-memory feedback (Track 2) tests.
 *
 * Covers, in order:
 *  (a) foldDirectionOutcomeRecordsForEdgeMemory — the pure fold: RESOLVED-only, LONG/SHORT-only
 *      diagnostic-exclusion discipline (mirrors regime-edge-memory.ts's own DIAGNOSTIC_ONLY exclusion).
 *  (b) FourBrainEdgeMemoryStore — rebuild-from-store, n=0 never-fabricated-zero.
 *  (c) fourBrainEdgeVerdict — the 3-way ALLOW_INSUFFICIENT / VETO_NEGATIVE / ALLOW_PROVEN rule.
 *  (d) getFourBrainEdgeMemory — singleton + rebuild-on-read (fail-without/pass-with for staleness).
 *  (e) End-to-end wiring: buildFourBrainGatherInput (four-brain-live-gather-bindings.ts) actually derives
 *      fourBrainLongVeto/fourBrainShortVeto per-horizon from real resolved outcomes, AND
 *      assembleFourBrainTick (four-brain-live-gather.ts) carries those fields through into the
 *      DirectionInput decideDirection() actually consumes — the "3rd necessary file" fix, proven with an
 *      explicit fail-without/pass-with pair.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DirectionEntryOutcomeStore,
  _resetDirectionEntryOutcomeStoreForTests,
  getDirectionEntryOutcomeStore,
  type DirectionOutcomeRecord,
} from "../src/lib/direction-entry-outcome-store.js";
import {
  FourBrainEdgeMemoryStore,
  MIN_SAMPLES,
  foldDirectionOutcomeRecordsForEdgeMemory,
  fourBrainEdgeVerdict,
  getFourBrainEdgeMemory,
  _resetFourBrainEdgeMemoryForTests,
} from "../src/lib/four-brain-edge-memory.js";
import { buildFourBrainGatherInput, type FourBrainBindingDeps } from "../src/lib/four-brain-live-gather-bindings.js";
import { assembleFourBrainTick } from "../src/lib/four-brain-live-gather.js";
import type { FourBrainGatherInput } from "../src/lib/four-brain-live-gather.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-four-brain-edge-memory-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  _resetFourBrainEdgeMemoryForTests();
  _resetDirectionEntryOutcomeStoreForTests();
});

const HOUR_MS = 3_600_000;

function directionRecord(n: number, overrides: Partial<DirectionOutcomeRecord> = {}): DirectionOutcomeRecord {
  return {
    decisionId: `dir-${n}`,
    horizon: "INTRADAY",
    action: "LONG",
    // 2026-07-26: one full DAY apart, not one hour. The edge memory now gates on non-overlapping
    // windows, and 1h spacing put 4 INTRADAY rows (and 24 SWING rows) inside a single window — so
    // these fixtures were only ever "n rows", never "n independent observations". Day spacing makes
    // every row its own window at every horizon, which is what the fixtures always meant.
    asOfMs: n * 24 * HOUR_MS,
    status: "RESOLVED",
    chosenNetR: 0.1,
    win: 1,
    regretR: 0,
    calibrationGapR: 0.02,
    ...overrides,
  };
}

/** Seed `count` RESOLVED records with the given action/horizon/chosenNetR into a real store. */
function seed(
  store: DirectionEntryOutcomeStore,
  count: number,
  overrides: Partial<DirectionOutcomeRecord> = {},
): void {
  for (let i = 0; i < count; i += 1) {
    store.recordDirectionOutcome(
      directionRecord(i, { decisionId: `${overrides.action ?? "LONG"}-${overrides.horizon ?? "INTRADAY"}-${i}`, ...overrides }),
      HOUR_MS,
    );
  }
}

describe("foldDirectionOutcomeRecordsForEdgeMemory — pure fold (diagnostic-exclusion discipline)", () => {
  it("counts RESOLVED LONG/SHORT rows, bucketed by direction+horizon", () => {
    const records: DirectionOutcomeRecord[] = [
      directionRecord(1, { action: "LONG", horizon: "INTRADAY", chosenNetR: 0.2 }),
      directionRecord(2, { action: "LONG", horizon: "INTRADAY", chosenNetR: -0.1 }),
      directionRecord(3, { action: "SHORT", horizon: "INTRADAY", chosenNetR: 0.05 }),
      directionRecord(4, { action: "LONG", horizon: "SWING", chosenNetR: 0.3 }),
    ];
    const buckets = foldDirectionOutcomeRecordsForEdgeMemory(records);
    expect(buckets.get("LONG::INTRADAY")).toMatchObject({ n: 2, sumNetR: 0.1 });
    expect(buckets.get("SHORT::INTRADAY")).toMatchObject({ n: 1, sumNetR: 0.05 });
    expect(buckets.get("LONG::SWING")).toMatchObject({ n: 1, sumNetR: 0.3 });
    expect(buckets.get("SHORT::SWING")).toBeUndefined();
  });

  it("excludes EXPIRED_UNRESOLVABLE rows (never a real chosenNetR)", () => {
    const records: DirectionOutcomeRecord[] = [
      directionRecord(1, { action: "LONG", status: "EXPIRED_UNRESOLVABLE", chosenNetR: null, win: null }),
      directionRecord(2, { action: "LONG", chosenNetR: 0.1 }),
    ];
    const buckets = foldDirectionOutcomeRecordsForEdgeMemory(records);
    expect(buckets.get("LONG::INTRADAY")).toMatchObject({ n: 1, sumNetR: 0.1 });
  });

  it("excludes FLAT rows (chosenNetR is pinned to exactly 0 — not a real directional outcome)", () => {
    const records: DirectionOutcomeRecord[] = [
      directionRecord(1, { action: "FLAT", chosenNetR: 0 }),
      directionRecord(2, { action: "LONG", chosenNetR: 0.1 }),
    ];
    const buckets = foldDirectionOutcomeRecordsForEdgeMemory(records);
    expect(buckets.size).toBe(1);
    expect(buckets.get("LONG::INTRADAY")).toMatchObject({ n: 1, sumNetR: 0.1 });
  });

  it("excludes BOTH rows (chosenNetR is a blended mean, not attributable to either single side)", () => {
    const records: DirectionOutcomeRecord[] = [
      directionRecord(1, { action: "BOTH", chosenNetR: 0.05 }),
      directionRecord(2, { action: "SHORT", chosenNetR: -0.2 }),
    ];
    const buckets = foldDirectionOutcomeRecordsForEdgeMemory(records);
    expect(buckets.size).toBe(1);
    expect(buckets.get("SHORT::INTRADAY")).toMatchObject({ n: 1, sumNetR: -0.2 });
  });
});

describe("FourBrainEdgeMemoryStore", () => {
  it("lookup on an empty store returns n=0, avgNetR:null (never a fabricated zero)", () => {
    const outcomeStore = new DirectionEntryOutcomeStore(tmp());
    const edge = new FourBrainEdgeMemoryStore(outcomeStore);
    expect(edge.lookup("LONG", "INTRADAY")).toEqual({ n: 0, effectiveN: 0, avgNetR: null });
  });

  it("lookup reflects the outcome store's RESOLVED records at construction time", () => {
    const outcomeStore = new DirectionEntryOutcomeStore(tmp());
    seed(outcomeStore, 3, { action: "LONG", horizon: "INTRADAY", chosenNetR: 0.1 });
    const edge = new FourBrainEdgeMemoryStore(outcomeStore);
    const l = edge.lookup("LONG", "INTRADAY");
    expect(l.n).toBe(3);
    expect(l.avgNetR).toBeCloseTo(0.1, 6);
  });

  it("rebuild() re-folds from the store's CURRENT state (idempotent, picks up new rows)", () => {
    const outcomeStore = new DirectionEntryOutcomeStore(tmp());
    const edge = new FourBrainEdgeMemoryStore(outcomeStore);
    expect(edge.lookup("LONG", "INTRADAY").n).toBe(0);
    seed(outcomeStore, 5, { action: "LONG", horizon: "INTRADAY", chosenNetR: 0.2 });
    // FAIL-WITHOUT: before calling rebuild(), the store's snapshot is stale.
    expect(edge.lookup("LONG", "INTRADAY").n).toBe(0);
    // PASS-WITH: after rebuild(), the new rows are reflected.
    edge.rebuild();
    expect(edge.lookup("LONG", "INTRADAY").n).toBe(5);
  });
});

describe("fourBrainEdgeVerdict", () => {
  it("n < MIN_SAMPLES ⇒ ALLOW_INSUFFICIENT with avgNetR:null, EVEN if the observed rows are strongly negative (never leak a premature verdict)", () => {
    const outcomeStore = new DirectionEntryOutcomeStore(tmp());
    seed(outcomeStore, MIN_SAMPLES - 1, { action: "LONG", horizon: "INTRADAY", chosenNetR: -5 });
    const edge = new FourBrainEdgeMemoryStore(outcomeStore);
    const v = fourBrainEdgeVerdict(edge, "Bullish expansion", "LONG", "INTRADAY");
    expect(v.verdict).toBe("ALLOW_INSUFFICIENT");
    expect(v.avgNetR).toBeNull();
    expect(v.n).toBe(MIN_SAMPLES - 1);
  });

  it("n >= MIN_SAMPLES, avg <= 0 ⇒ VETO_NEGATIVE", () => {
    const outcomeStore = new DirectionEntryOutcomeStore(tmp());
    seed(outcomeStore, MIN_SAMPLES, { action: "LONG", horizon: "INTRADAY", chosenNetR: -0.05 });
    const edge = new FourBrainEdgeMemoryStore(outcomeStore);
    const v = fourBrainEdgeVerdict(edge, null, "LONG", "INTRADAY");
    expect(v.verdict).toBe("VETO_NEGATIVE");
    expect(v.avgNetR).toBeCloseTo(-0.05, 6);
    expect(v.n).toBe(MIN_SAMPLES);
  });

  it("n >= MIN_SAMPLES, avg > 0 ⇒ ALLOW_PROVEN", () => {
    const outcomeStore = new DirectionEntryOutcomeStore(tmp());
    seed(outcomeStore, MIN_SAMPLES, { action: "SHORT", horizon: "SWING", chosenNetR: 0.12 });
    const edge = new FourBrainEdgeMemoryStore(outcomeStore);
    const v = fourBrainEdgeVerdict(edge, "Mixed rotation", "SHORT", "SWING");
    expect(v.verdict).toBe("ALLOW_PROVEN");
    expect(v.avgNetR).toBeCloseTo(0.12, 6);
  });

  it("regimeRaw is accepted but does not change the result (self-referential store has no regime axis — documented deviation)", () => {
    const outcomeStore = new DirectionEntryOutcomeStore(tmp());
    seed(outcomeStore, MIN_SAMPLES, { action: "LONG", horizon: "INTRADAY", chosenNetR: -0.1 });
    const edge = new FourBrainEdgeMemoryStore(outcomeStore);
    const a = fourBrainEdgeVerdict(edge, "Bullish expansion", "LONG", "INTRADAY");
    const b = fourBrainEdgeVerdict(edge, "Bearish pressure", "LONG", "INTRADAY");
    expect(a).toEqual(b);
  });

  it("a different horizon slice is independently gated (no cross-horizon contamination)", () => {
    const outcomeStore = new DirectionEntryOutcomeStore(tmp());
    seed(outcomeStore, MIN_SAMPLES, { action: "LONG", horizon: "INTRADAY", chosenNetR: -0.1 });
    const edge = new FourBrainEdgeMemoryStore(outcomeStore);
    expect(fourBrainEdgeVerdict(edge, null, "LONG", "INTRADAY").verdict).toBe("VETO_NEGATIVE");
    expect(fourBrainEdgeVerdict(edge, null, "LONG", "SWING").verdict).toBe("ALLOW_INSUFFICIENT");
  });
});

describe("getFourBrainEdgeMemory — singleton + rebuild-on-read", () => {
  it("rebuilds fresh on every call, reflecting rows recorded to the backing store after the first getFourBrainEdgeMemory() call", () => {
    const dir = tmp();
    const first = getFourBrainEdgeMemory(dir);
    expect(fourBrainEdgeVerdict(first, null, "LONG", "INTRADAY").n).toBe(0);

    seed(getDirectionEntryOutcomeStore(dir), MIN_SAMPLES, { action: "LONG", horizon: "INTRADAY", chosenNetR: 0.3 });

    const second = getFourBrainEdgeMemory(dir);
    expect(second).toBe(first); // same singleton object identity
    const v = fourBrainEdgeVerdict(second, null, "LONG", "INTRADAY");
    expect(v.verdict).toBe("ALLOW_PROVEN");
    expect(v.n).toBe(MIN_SAMPLES);
  });
});

describe("End-to-end wiring: buildFourBrainGatherInput derives fourBrainLongVeto/fourBrainShortVeto from real resolved outcomes", () => {
  const edgeStub = {
    lookup: (_r: string | null, _d: "LONG" | "SHORT") => ({ avgNetR: 0, n: 0 }),
    verdict: () => ({ decision: "ALLOW_PROVEN" }),
    hasPositiveLane: () => true,
  };

  function baseDeps(o: Partial<FourBrainBindingDeps> = {}): FourBrainBindingDeps {
    return {
      instanceId: "3101",
      nowMs: 1_800_000_000_000,
      horizons: ["INTRADAY", "SWING"],
      axisScore: null, axisAtMs: null, axisSlopePerHour: null,
      btcAtrPercentile: null, atrAtMs: null,
      advancersPct: null, breadthAtMs: null,
      sentiment: null, sentimentAtMs: null,
      safetyEvents: [],
      regimeRaw: "Bullish expansion", edgeMemory: edgeStub,
      controllerBias: "UNKNOWN", convictionScore: null, allowsLong: true, allowsShort: true,
      bestLaneReportForDirection: () => null,
      crowdAlignLong: null, crowdAtMs: null, kronosAgree: null, kronosAtMs: null,
      openSignals: [], maxSignalAgeMs: 50 * 60_000, crowdingStateForSymbol: () => null,
      openPositions: [], markPriceForSymbol: () => ({ price: null, atMs: null }),
      cortexDecisionId: null, cortexFinalPctForLane: () => null, laneEligibleIncumbent: () => true,
      killLatched: false, killReason: null,
      ...o,
    } as FourBrainBindingDeps;
  }

  it("FAIL-WITHOUT: no resolved outcomes yet ⇒ fourBrainLongVeto/fourBrainShortVeto false for every horizon (ALLOW_INSUFFICIENT, never a premature veto)", () => {
    const dir = tmp();
    getFourBrainEdgeMemory(dir); // seed the singleton against an empty store
    const input = buildFourBrainGatherInput(baseDeps());
    for (const d of input.directions) {
      expect(d.fourBrainLongVeto).toBe(false);
      expect(d.fourBrainShortVeto).toBe(false);
    }
  });

  it("PASS-WITH: >=MIN_SAMPLES proven-negative LONG outcomes for ONE horizon ⇒ fourBrainLongVeto true ONLY for that horizon", () => {
    const dir = tmp();
    seed(getDirectionEntryOutcomeStore(dir), MIN_SAMPLES, { action: "LONG", horizon: "INTRADAY", chosenNetR: -0.08 });
    getFourBrainEdgeMemory(dir); // rebuild against the seeded store

    const input = buildFourBrainGatherInput(baseDeps());
    const intraday = input.directions.find((d) => d.horizon === "INTRADAY")!;
    const swing = input.directions.find((d) => d.horizon === "SWING")!;
    expect(intraday.fourBrainLongVeto).toBe(true);
    expect(intraday.fourBrainShortVeto).toBe(false); // SHORT bucket untouched
    expect(swing.fourBrainLongVeto).toBe(false); // different horizon ⇒ still insufficient
  });
});

describe("End-to-end wiring: assembleFourBrainTick carries fourBrainLongVeto/fourBrainShortVeto through to DirectionInput", () => {
  function rawReading(value: number | null) {
    return { sourceId: "x", raw: value, normalized: value, unit: "R", observedAtMs: null, freshnessClass: "regime" as const, missingReason: null };
  }

  function gatherInput(o: { fourBrainLongVeto?: boolean; fourBrainShortVeto?: boolean }): FourBrainGatherInput {
    return {
      instanceId: "3101",
      nowMs: 1_800_000_000_000,
      supportedLanes: new Set(),
      marketState: {
        trend: rawReading(null), volatility: rawReading(null), liquidity: rawReading(null),
        breadth: rawReading(null), momentum: rawReading(null), eventRisk: rawReading(null),
        sentiment: rawReading(null), safetyEvents: [], validityMs: 900_000,
      },
      directions: [
        {
          horizon: "INTRADAY",
          marketBias: "NEUTRAL",
          transitionRisk: 0,
          longEdge: rawReading(null),
          shortEdge: rawReading(null),
          conviction: rawReading(null),
          longLaneEdge: rawReading(null),
          shortLaneEdge: rawReading(null),
          kronosAgree: rawReading(null),
          crowdingAlignLong: rawReading(null),
          fourBrainLongVeto: o.fourBrainLongVeto,
          fourBrainShortVeto: o.fourBrainShortVeto,
          validityMs: 900_000,
        },
      ],
      entryCandidatesRaw: [],
      exitCandidatesRaw: [],
    };
  }

  it("PASS-WITH: a true fourBrainLongVeto on the raw DirectionRawReadings flows through to DirectionInput.fourBrainLongVeto", () => {
    const gathered = assembleFourBrainTick(gatherInput({ fourBrainLongVeto: true, fourBrainShortVeto: false }));
    expect(gathered.directionInputs[0]!.input.fourBrainLongVeto).toBe(true);
    expect(gathered.directionInputs[0]!.input.fourBrainShortVeto).toBe(false);
  });

  it("undefined (not yet computed) never fabricates a veto", () => {
    const gathered = assembleFourBrainTick(gatherInput({}));
    expect(gathered.directionInputs[0]!.input.fourBrainLongVeto).toBeUndefined();
    expect(gathered.directionInputs[0]!.input.fourBrainShortVeto).toBeUndefined();
  });
});

describe("[EFFECTIVE-N] the sufficiency gate counts non-overlapping windows, not raw rows (2026-07-26)", () => {
  // Found on live testnet data: LONG/SWING was firing VETO_NEGATIVE off raw n=45 whose rows fell in
  // only ~4 distinct 24h windows, with avgNetR -3.63R produced by that handful of overlapping
  // decisions. The outcome store's own report already gates on effective sample size for exactly
  // this reason; this memory was the one consumer still reading raw n, so it suppressed real LONG
  // scores on evidence it did not have.
  const DAY_MS = 24 * HOUR_MS;
  /** Minimal stand-in for the outcome store — the edge memory only ever reads direction.records. */
  const storeOf = (records: DirectionOutcomeRecord[]): FourBrainEdgeMemoryStore =>
    new FourBrainEdgeMemoryStore({
      getState: () => ({ direction: { records } }),
    } as unknown as DirectionEntryOutcomeStore);

  /** 60 LONG/SWING rows, strongly negative, but PACKED into `blocks` distinct 24h windows. */
  const packed = (blocks: number): DirectionOutcomeRecord[] =>
    Array.from({ length: 60 }, (_, i) =>
      directionRecord(i, {
        decisionId: `packed-${i}`,
        action: "LONG",
        horizon: "SWING",
        chosenNetR: -3.6,
        win: 0,
        asOfMs: 30 * DAY_MS + (i % blocks) * DAY_MS + Math.floor(i / blocks) * 60_000,
      }),
    );

  it("MANY rows packed into FEW windows do NOT reach sufficiency", () => {
    const store = storeOf(packed(3));
    const look = store.lookup("LONG", "SWING");
    expect(look.n).toBe(60);
    expect(look.effectiveN).toBe(3);
    expect(look.avgNetR).toBeCloseTo(-3.6, 6);
    // Strongly negative mean, plenty of raw rows — and still NOT enough evidence to veto.
    expect(fourBrainEdgeVerdict(store, null, "LONG", "SWING").verdict).toBe("ALLOW_INSUFFICIENT");
  });

  it("FAILS-WITHOUT-FIX control: raw n clears MIN_SAMPLES while effectiveN does not", () => {
    const look = storeOf(packed(3)).lookup("LONG", "SWING");
    expect(look.n).toBeGreaterThanOrEqual(MIN_SAMPLES); // the old gate would have vetoed on this
    expect(look.effectiveN).toBeLessThan(MIN_SAMPLES); // the new gate refuses on this
  });

  it("the SAME rows spread across enough windows DO reach sufficiency", () => {
    const spread = Array.from({ length: 60 }, (_, i) =>
      directionRecord(i, {
        decisionId: `spread-${i}`,
        action: "LONG",
        horizon: "SWING",
        chosenNetR: -3.6,
        win: 0,
        asOfMs: 30 * DAY_MS + i * DAY_MS,
      }),
    );
    const store = storeOf(spread);
    expect(store.lookup("LONG", "SWING").effectiveN).toBe(60);
    expect(fourBrainEdgeVerdict(store, null, "LONG", "SWING").verdict).toBe("VETO_NEGATIVE");
  });

  it("INTRADAY blocks are 4h wide and effectiveN never exceeds n", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      directionRecord(i, {
        decisionId: `intra-${i}`,
        action: "LONG",
        horizon: "INTRADAY",
        chosenNetR: 0.5,
        asOfMs: 30 * DAY_MS + Math.floor(i / 2) * 4 * HOUR_MS + (i % 2) * 60_000,
      }),
    );
    const look = storeOf(rows).lookup("LONG", "INTRADAY");
    expect(look.n).toBe(8);
    expect(look.effectiveN).toBe(4); // 2 rows per 4h block
    expect(look.effectiveN).toBeLessThanOrEqual(look.n);
  });
});
