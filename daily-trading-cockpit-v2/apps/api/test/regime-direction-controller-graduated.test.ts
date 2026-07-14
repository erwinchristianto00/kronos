import { describe, it, expect } from "vitest";
import {
  buildRegimeDirectionControllerReport,
  graduateConfidence,
  type DirectionEdgeGate,
} from "../src/lib/regime-direction-controller.js";

const LONG_TREND = "Bullish expansion"; // → LONG_ONLY
const SHORT_TREND = "Bearish pressure"; // → SHORT_ONLY

/** Mock edge gate. allowed:true = proven-positive/insufficient (not vetoed); allowed:false = veto. */
function edgeGate(
  stat: { n: number; avgNetR: number; winRate?: number },
  opts: { allowed?: boolean; positiveLane?: boolean } = {},
): DirectionEdgeGate {
  return {
    verdict: () => ({
      allowed: opts.allowed ?? true,
      reasonCode: (opts.allowed ?? true) ? "EDGE_PROVEN_POSITIVE" : "EDGE_PROVEN_NEGATIVE",
      stat: { n: stat.n, avgNetR: stat.avgNetR, winRate: stat.winRate ?? 55 },
    }),
    hasPositiveLane: () => opts.positiveLane === true,
  };
}

describe("graduated confidence — helper (Compounded-Evidence, Gated HIGH)", () => {
  it("back-compat: no axis, no edge → returns the mapping confidence, conviction 0.50", () => {
    const g = graduateConfidence({ dir: "LONG", axisScore: null, axisSlopePerHour: null, edgeStat: null, mappingConfidence: "MEDIUM" });
    expect(g.confidence).toBe("MEDIUM");
    expect(g.gradedConfidence).toBe("MEDIUM");
    expect(g.convictionScore).toBeCloseTo(0.5, 6);
  });

  it("HIGH via momentum road: strong breadth + agreeing velocity", () => {
    const g = graduateConfidence({ dir: "LONG", axisScore: 0.55, axisSlopePerHour: 0.04, edgeStat: null, mappingConfidence: "MEDIUM" });
    expect(g.gradedConfidence).toBe("HIGH");
    expect(g.confidence).toBe("HIGH");
  });

  it("strong breadth but FLAT velocity cannot buy HIGH (capped MEDIUM)", () => {
    const g = graduateConfidence({ dir: "LONG", axisScore: 0.5, axisSlopePerHour: 0.002, edgeStat: null, mappingConfidence: "MEDIUM" });
    expect(g.gradedConfidence).toBe("MEDIUM");
  });

  it("HIGH via edge road: strong, well-sampled proven edge even with weak breadth", () => {
    const g = graduateConfidence({ dir: "LONG", axisScore: null, axisSlopePerHour: null, edgeStat: { n: 140, avgNetR: 0.22 }, mappingConfidence: "MEDIUM" });
    expect(g.gradedConfidence).toBe("HIGH");
  });

  it("a thin proven slice (n=48) does NOT reach HIGH (sample discount)", () => {
    const g = graduateConfidence({ dir: "LONG", axisScore: null, axisSlopePerHour: null, edgeStat: { n: 48, avgNetR: 0.178 }, mappingConfidence: "MEDIUM" });
    expect(g.gradedConfidence).toBe("MEDIUM");
  });

  it("conflict (breadth up, momentum peeling off) → graded LOW, confidence floored MEDIUM", () => {
    const g = graduateConfidence({ dir: "LONG", axisScore: 0.4, axisSlopePerHour: -0.03, edgeStat: null, mappingConfidence: "MEDIUM" });
    expect(g.gradedConfidence).toBe("LOW");
    expect(g.confidence).toBe("MEDIUM"); // live-safe floor
  });

  it("proven-negative can never read HIGH even with saturated agreeing breadth+velocity", () => {
    const g = graduateConfidence({ dir: "LONG", axisScore: 0.5, axisSlopePerHour: 0.03, edgeStat: { n: 40, avgNetR: -0.1 }, mappingConfidence: "MEDIUM" });
    expect(g.gradedConfidence).not.toBe("HIGH");
    expect(g.confidence).toBe("MEDIUM");
  });

  it("is symmetric: the sign-flipped SHORT of a HIGH long is also HIGH", () => {
    const long = graduateConfidence({ dir: "LONG", axisScore: 0.55, axisSlopePerHour: 0.04, edgeStat: null, mappingConfidence: "MEDIUM" });
    const short = graduateConfidence({ dir: "SHORT", axisScore: -0.55, axisSlopePerHour: -0.04, edgeStat: null, mappingConfidence: "MEDIUM" });
    expect(short.gradedConfidence).toBe(long.gradedConfidence);
    expect(short.convictionScore).toBeCloseTo(long.convictionScore, 6);
  });

  it("is deterministic / pure", () => {
    const args = { dir: "LONG" as const, axisScore: 0.3, axisSlopePerHour: 0.01, edgeStat: { n: 60, avgNetR: 0.06 }, mappingConfidence: "MEDIUM" as const };
    expect(graduateConfidence(args)).toEqual(graduateConfidence(args));
  });
});

describe("graduated confidence — integration in buildRegimeDirectionControllerReport", () => {
  it("back-compat: a string-only caller (no axis, no edge) is unchanged — MEDIUM / 0.50", () => {
    for (const regime of [LONG_TREND, SHORT_TREND]) {
      const r = buildRegimeDirectionControllerReport({ currentRegime: regime });
      expect(r.confidence).toBe("MEDIUM");
      expect(r.gradedConfidence).toBe("MEDIUM");
      expect(r.convictionScore).toBeCloseTo(0.5, 6);
    }
  });

  it("LIVE-SAFETY INVARIANT: a directional trend NEVER emits confidence LOW (fuzz)", () => {
    for (const regime of [LONG_TREND, SHORT_TREND]) {
      for (const axisScore of [-1, -0.5, -0.1, 0, 0.1, 0.5, 1]) {
        for (const axisSlopePerHour of [-0.1, -0.02, 0, 0.02, 0.1]) {
          for (const stat of [null, { n: 12, avgNetR: 0.05 }, { n: 40, avgNetR: -0.2 }, { n: 140, avgNetR: 0.25 }]) {
            const r = buildRegimeDirectionControllerReport({
              currentRegime: regime,
              edgeGate: stat ? edgeGate(stat, { allowed: !(stat.n >= 30 && stat.avgNetR <= 0), positiveLane: true }) : null,
              axisScore,
              axisSlopePerHour,
            });
            // Only assert on modes that STAYED a directional trend (a veto can collapse to NO_TRADE).
            if (r.controllerMode === "LONG_ONLY" || r.controllerMode === "SHORT_ONLY") {
              expect(r.confidence).not.toBe("LOW");
            }
          }
        }
      }
    }
  });

  it("upgrades a strong strengthening trend to HIGH at the live call site", () => {
    const r = buildRegimeDirectionControllerReport({
      currentRegime: LONG_TREND,
      edgeGate: edgeGate({ n: 12, avgNetR: 0.05 }),
      axisScore: 0.55,
      axisSlopePerHour: 0.04,
    });
    expect(r.confidence).toBe("HIGH");
    expect(r.gradedConfidence).toBe("HIGH");
    expect(r.convictionScore).toBeGreaterThan(0.75);
  });

  it("non-directional modes (chop/mixed) keep their hardcoded confidence + fixed conviction", () => {
    const chop = buildRegimeDirectionControllerReport({ currentRegime: "Choppy range", axisScore: 0.9, axisSlopePerHour: 0.1 });
    expect(chop.confidence).toBe("MEDIUM"); // NO_TRADE_CHOP is hardcoded MEDIUM, not graduated
    expect(chop.gradedConfidence).toBe("MEDIUM");
    const mixed = buildRegimeDirectionControllerReport({ currentRegime: "Mixed rotation", axisScore: 0.9, axisSlopePerHour: 0.1 });
    expect(mixed.confidence).toBe("LOW"); // VALIDATION_ONLY hardcoded LOW, untouched by graduation
  });
});
