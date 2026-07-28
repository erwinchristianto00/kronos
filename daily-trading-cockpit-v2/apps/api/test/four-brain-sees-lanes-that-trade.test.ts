import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { variantMatrixOpenSignals } from "../src/lib/current-guard-variant-matrix.js";
import { normalizeEntryTier1LaneNamespace } from "../src/lib/entry-brain-tier1-realized-resolver.js";

/**
 * Entry Brain Tier 1 had resolved 0 of 1,664 decisions and could never resolve one: the four-brain
 * evaluated COMPOSITE_ESTIMATOR/INTRADAY_MOMENTUM/REGIME_COMPOSITE while all 309 closed position
 * paths came from CG_VARIANT_MATRIX:* / CG_LONG_VARIANT_MATRIX:*. Every rejection was
 * NO_EXACT_LANE_SYMBOL_SIDE_CLOSE — the two halves were looking at different universes.
 *
 * The join key is `normalizeEntryTier1LaneNamespace(laneId)::SYMBOL::SIDE`, so what these tests
 * really pin is that the id this accessor emits COLLIDES with the id a real position path carries.
 * An accessor that returned beautifully-shaped rows under a non-joining id would leave the column
 * exactly as empty as before while looking fixed.
 */
const APP_SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/app.ts"), "utf-8");

type Obs = Record<string, unknown>;
function obs(o: Partial<Obs> = {}): Obs {
  return {
    observationId: "OID-1",
    variantId: "CG_WIDE_FAST_LONG",
    symbol: "BTCUSDT",
    direction: "LONG",
    status: "OPEN",
    openedAt: new Date(1_800_000_000_000).toISOString(),
    simulatedEntryPrice: 100,
    simulatedStopLoss: 97,
    ...o,
  };
}
const storeOf = (rows: Obs[]) => ({ all: rows }) as unknown as Parameters<typeof variantMatrixOpenSignals>[0];
const NOW = 1_800_000_000_000;

describe("the emitted lane id must actually join to a real position path", () => {
  /** THE WHOLE POINT. Fails if the accessor ever starts emitting a prefixed id that no longer
   *  collides, or if the resolver's normalizer stops stripping these prefixes. */
  it.each([
    ["CG_VARIANT_MATRIX:CG_WIDE_FAST_LONG"],
    ["CG_LONG_VARIANT_MATRIX:CG_WIDE_FAST_LONG"],
  ])("bare variantId shares a join key with %s", (pathLaneId) => {
    const [signal] = variantMatrixOpenSignals(storeOf([obs()]), { nowMs: NOW });
    expect(signal).toBeDefined();
    expect(normalizeEntryTier1LaneNamespace(signal!.laneId)).toBe(
      normalizeEntryTier1LaneNamespace(pathLaneId),
    );
  });

  it("a DIFFERENT variant does not collide — the key still discriminates", () => {
    const [signal] = variantMatrixOpenSignals(storeOf([obs()]), { nowMs: NOW });
    expect(normalizeEntryTier1LaneNamespace(signal!.laneId)).not.toBe(
      normalizeEntryTier1LaneNamespace("CG_VARIANT_MATRIX:CG_TIGHT_FAST_05"),
    );
  });
});

describe("variantMatrixOpenSignals — shape and safety", () => {
  it("returns only OPEN rows", () => {
    const rows = variantMatrixOpenSignals(
      storeOf([obs(), obs({ observationId: "c", status: "CLOSED_WIN" }), obs({ observationId: "n", status: "NO_FILL" })]),
      { nowMs: NOW },
    );
    expect(rows.map((r) => r.observationId)).toEqual(["OID-1"]);
  });

  it("carries each row's OWN side and symbol, not a lane-level default", () => {
    const rows = variantMatrixOpenSignals(
      storeOf([obs(), obs({ observationId: "s", direction: "SHORT", symbol: "ETHUSDT", variantId: "CG_WIDE_FAST_SHORT" })]),
      { nowMs: NOW },
    );
    expect(rows.find((r) => r.observationId === "s")).toMatchObject({ direction: "SHORT", symbol: "ETHUSDT", laneId: "CG_WIDE_FAST_SHORT" });
  });

  /** Never fabricate geometry — a row without a usable entry/stop is dropped, not defaulted to 0. */
  it.each([
    [{ simulatedEntryPrice: 0 }],
    [{ simulatedStopLoss: 0 }],
    [{ openedAt: "not-a-date" }],
  ])("drops unusable row %#", (bad) => {
    expect(variantMatrixOpenSignals(storeOf([obs(bad)]), { nowMs: NOW })).toHaveLength(0);
  });

  it("excludes rows older than the window and keeps the freshest under the cap", () => {
    const rows = [
      obs({ observationId: "old", openedAt: new Date(NOW - 3 * 3_600_000).toISOString() }),
      obs({ observationId: "new", openedAt: new Date(NOW - 60_000).toISOString() }),
      obs({ observationId: "mid", openedAt: new Date(NOW - 600_000).toISOString() }),
    ];
    const got = variantMatrixOpenSignals(storeOf(rows), { nowMs: NOW });
    expect(got.map((r) => r.observationId)).toEqual(["new", "mid"]);
    expect(variantMatrixOpenSignals(storeOf(rows), { nowMs: NOW, cap: 1 }).map((r) => r.observationId)).toEqual(["new"]);
  });

  /** The store holds ~3,254 OPEN rows against a handful from every sibling accessor; an unbounded
   *  return would change the four-brain's per-tick cost profile. */
  it("is bounded by default", () => {
    const many = Array.from({ length: 1000 }, (_, i) => obs({ observationId: `o${i}`, openedAt: new Date(NOW - i * 1000).toISOString() }));
    expect(variantMatrixOpenSignals(storeOf(many), { nowMs: NOW }).length).toBeLessThanOrEqual(400);
  });
});

describe("app.ts actually feeds it to the four-brain (source-level guard)", () => {
  /** FAILS WITHOUT THE FIX — collectFourBrainOpenSignals listed six lanes, none of which trades. */
  it("collectFourBrainOpenSignals includes the variant matrix", () => {
    const at = APP_SRC.indexOf("const collectFourBrainOpenSignals");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = APP_SRC.slice(at, APP_SRC.indexOf("return out;", at));
    expect(body).toContain("variantMatrixOpenSignals");
    // and the six originals are still there — this is additive, not a replacement
    for (const lane of ["shortFadeOpenSignals", "intradayMomentumOpenSignals", "regimeCompositeOpenSignals", "regimeCompositeShortOpenSignals", "panicWashoutOpenSignals", "compositeEstimatorOpenSignals"]) {
      expect(body).toContain(lane);
    }
  });
});
