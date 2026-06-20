import { describe, expect, it } from "vitest";

import { buildRegimeDirectionControllerReport } from "../src/lib/regime-direction-controller.js";

describe("regime direction controller (Phase 1, REPORT-ONLY)", () => {
  it("maps 'Bullish expansion' to LONG_ONLY with allowsLong=true", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    expect(report.controllerMode).toBe("LONG_ONLY");
    expect(report.directionalBias).toBe("LONG");
    expect(report.allowsLong).toBe(true);
    expect(report.allowsShort).toBe(false);
    expect(report.allowsNewEntries).toBe(true);
    expect(report.requiresRetest).toBe(false);
    expect(report.confidence).toBe("MEDIUM");
    expect(report.reasonCodes).toContain("REGIME_LONG_TREND");
  });

  it("maps 'Bearish expansion' to SHORT_ONLY with allowsShort=true", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bearish expansion" });
    expect(report.controllerMode).toBe("SHORT_ONLY");
    expect(report.directionalBias).toBe("SHORT");
    expect(report.allowsLong).toBe(false);
    expect(report.allowsShort).toBe(true);
    expect(report.allowsNewEntries).toBe(true);
    expect(report.confidence).toBe("MEDIUM");
    expect(report.reasonCodes).toContain("REGIME_SHORT_TREND");
  });

  it("maps 'Mixed rotation' to VALIDATION_ONLY with MIXED bias and mixed warning", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Mixed rotation" });
    expect(report.controllerMode).toBe("VALIDATION_ONLY");
    expect(report.directionalBias).toBe("MIXED");
    expect(report.confidence).toBe("LOW");
    expect(report.allowsNewEntries).toBe(false);
    expect(report.reasonCodes).toContain("REGIME_MIXED_NO_CONVICTION");
    expect(report.warnings).toContain("mixed regime should not force directional conviction");
  });

  it("maps 'Choppy range' to NO_TRADE_CHOP with allowsLong=false and allowsShort=false", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Choppy range" });
    expect(report.controllerMode).toBe("NO_TRADE_CHOP");
    expect(report.directionalBias).toBe("NEUTRAL");
    expect(report.allowsLong).toBe(false);
    expect(report.allowsShort).toBe(false);
    expect(report.allowsNewEntries).toBe(false);
    expect(report.reasonCodes).toContain("REGIME_CHOP_NO_TREND");
  });

  it("maps 'Panic dump' to WAIT_RETEST_AFTER_DUMP with requiresRetest=true", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Panic dump" });
    expect(report.controllerMode).toBe("WAIT_RETEST_AFTER_DUMP");
    expect(report.directionalBias).toBe("SHORT");
    expect(report.requiresRetest).toBe(true);
    expect(report.allowsNewEntries).toBe(false);
    expect(report.allowsShort).toBe(true);
    expect(report.allowsLong).toBe(false);
    expect(report.reasonCodes).toContain("REGIME_DUMP_RETEST_WAIT");
  });

  it("maps 'Panic squeeze' to WAIT_RETEST_AFTER_PUMP with requiresRetest=true", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Panic squeeze" });
    expect(report.controllerMode).toBe("WAIT_RETEST_AFTER_PUMP");
    expect(report.directionalBias).toBe("LONG");
    expect(report.requiresRetest).toBe(true);
    expect(report.allowsNewEntries).toBe(false);
    expect(report.allowsLong).toBe(true);
    expect(report.allowsShort).toBe(false);
    expect(report.reasonCodes).toContain("REGIME_PUMP_RETEST_WAIT");
  });

  it("maps null regime to UNKNOWN with LOW confidence", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: null });
    expect(report.controllerMode).toBe("UNKNOWN");
    expect(report.directionalBias).toBe("UNKNOWN");
    expect(report.confidence).toBe("LOW");
    expect(report.allowsLong).toBe(false);
    expect(report.allowsShort).toBe(false);
    expect(report.allowsNewEntries).toBe(false);
    expect(report.reasonCodes).toContain("REGIME_UNKNOWN");
  });

  it("flags MISMATCH when bullish current regime meets a BEARISH/SHORT primary lane", () => {
    const report = buildRegimeDirectionControllerReport({
      currentRegime: "BULLISH_EXPANSION",
      primaryValidationLane: {
        label: "SHORT BEARISH_EXPANSION exit-tp-tight",
        dominantRegime: "BEARISH_EXPANSION",
        direction: "SHORT",
        microPilotReady: false,
      },
    });
    expect(report.currentValidationPrimaryLane).not.toBeNull();
    expect(report.currentValidationPrimaryLane?.alignment).toBe("MISMATCH");
    expect(report.warnings).toContain(
      "primary validation lane is cross-regime — collection only, not live execution",
    );
  });

  it("flags MATCH when bearish current regime meets a BEARISH/SHORT primary lane", () => {
    const report = buildRegimeDirectionControllerReport({
      currentRegime: "BEARISH_EXPANSION",
      primaryValidationLane: {
        label: "SHORT BEARISH_EXPANSION exit-tp-tight",
        dominantRegime: "BEARISH_EXPANSION",
        direction: "SHORT",
        microPilotReady: false,
      },
    });
    expect(report.currentValidationPrimaryLane?.alignment).toBe("MATCH");
    expect(report.warnings).not.toContain(
      "primary validation lane is cross-regime — collection only, not live execution",
    );
  });

  it("returns null currentValidationPrimaryLane when no primary lane is supplied", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    expect(report.currentValidationPrimaryLane).toBeNull();
  });

  it("always sets reportOnly=true", () => {
    const cases = [
      { currentRegime: "Bullish expansion" },
      { currentRegime: "Bearish expansion" },
      { currentRegime: "Mixed rotation" },
      { currentRegime: "Choppy range" },
      { currentRegime: "Panic dump" },
      { currentRegime: "Panic squeeze" },
      { currentRegime: null },
      {},
    ];
    for (const input of cases) {
      const report = buildRegimeDirectionControllerReport(input);
      expect(report.reportOnly).toBe(true);
    }
  });

  it("always emits the 'controller is report-only; no behavior influence' warning", () => {
    const cases = [
      { currentRegime: "Bullish expansion" },
      { currentRegime: "Bearish expansion" },
      { currentRegime: "Mixed rotation" },
      { currentRegime: "Choppy range" },
      { currentRegime: "Panic dump" },
      { currentRegime: "Panic squeeze" },
      { currentRegime: null },
      {},
    ];
    for (const input of cases) {
      const report = buildRegimeDirectionControllerReport(input);
      expect(report.warnings).toContain("controller is report-only; no behavior influence");
    }
  });

  it("passes lane direction through as-is and does not derive from label", () => {
    const report = buildRegimeDirectionControllerReport({
      currentRegime: "BEARISH_EXPANSION",
      primaryValidationLane: {
        label: "LONG-styled label but direction is SHORT",
        dominantRegime: "BEARISH_EXPANSION",
        direction: "SHORT",
      },
    });
    expect(report.currentValidationPrimaryLane?.direction).toBe("SHORT");
  });

  it("classifies 'panic dump' before generic bearish trend so retest mode wins", () => {
    // "panic dump" should NOT collapse into SHORT_ONLY trend.
    const report = buildRegimeDirectionControllerReport({ currentRegime: "PANIC_DUMP_BEARISH" });
    expect(report.controllerMode).toBe("WAIT_RETEST_AFTER_DUMP");
    expect(report.requiresRetest).toBe(true);
  });

  // ── Normalization coverage (case-insensitive) ──────────────────────────────

  it("'bullish expansion' (lowercase) → LONG_ONLY", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "bullish expansion" });
    expect(report.controllerMode).toBe("LONG_ONLY");
    expect(report.allowsLong).toBe(true);
    expect(report.allowsShort).toBe(false);
  });

  it("'BULLISH_EXPANSION' (uppercase with underscore) → LONG_ONLY", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "BULLISH_EXPANSION" });
    expect(report.controllerMode).toBe("LONG_ONLY");
    expect(report.allowsLong).toBe(true);
  });

  it("'Bearish pressure' → SHORT_ONLY", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bearish pressure" });
    expect(report.controllerMode).toBe("SHORT_ONLY");
    expect(report.allowsShort).toBe(true);
    expect(report.allowsLong).toBe(false);
  });

  it("'Mixed rotation' → VALIDATION_ONLY (non-directional)", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Mixed rotation" });
    expect(report.controllerMode).toBe("VALIDATION_ONLY");
    expect(report.allowsNewEntries).toBe(false);
  });

  it("null → UNKNOWN (not BOTH_ALLOWED)", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: null });
    expect(report.controllerMode).toBe("UNKNOWN");
    expect(report.controllerMode).not.toBe("BOTH_ALLOWED");
    expect(report.allowsLong).toBe(false);
    expect(report.allowsShort).toBe(false);
  });

  it("undefined → UNKNOWN (not BOTH_ALLOWED)", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: undefined });
    expect(report.controllerMode).toBe("UNKNOWN");
    expect(report.controllerMode).not.toBe("BOTH_ALLOWED");
  });

  it("empty string → UNKNOWN (not BOTH_ALLOWED)", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "" });
    expect(report.controllerMode).toBe("UNKNOWN");
    expect(report.controllerMode).not.toBe("BOTH_ALLOWED");
  });
});

describe("regime direction controller — honest-edge gate", () => {
  // A fake gate returning a fixed verdict per direction.
  const gateOf = (verdicts: Partial<Record<"LONG" | "SHORT", boolean>>) => ({
    verdict(_regime: string | null | undefined, direction: "LONG" | "SHORT") {
      const allowed = verdicts[direction] ?? true;
      return {
        allowed,
        reasonCode: allowed ? "EDGE_PROVEN_POSITIVE" : "EDGE_PROVEN_NEGATIVE",
        stat: { n: 400, avgNetR: allowed ? 0.2 : -0.1, winRate: 50 },
      };
    },
  });

  it("vetoes a proven-negative LONG in Bullish expansion → NO_TRADE_NEGATIVE_EDGE, no new entries", () => {
    const report = buildRegimeDirectionControllerReport({
      currentRegime: "Bullish expansion",
      edgeGate: gateOf({ LONG: false }),
    });
    expect(report.controllerMode).toBe("NO_TRADE_NEGATIVE_EDGE");
    expect(report.allowsLong).toBe(false);
    expect(report.allowsNewEntries).toBe(false);
    expect(report.directionalBias).toBe("NEUTRAL");
    expect(report.edgeGated).toBe(true);
    expect(report.reasonCodes).toContain("EDGE_PROVEN_NEGATIVE_LONG");
  });

  it("keeps LONG_ONLY when the gate allows the proven-positive LONG", () => {
    const report = buildRegimeDirectionControllerReport({
      currentRegime: "Bullish expansion",
      edgeGate: gateOf({ LONG: true }),
    });
    expect(report.controllerMode).toBe("LONG_ONLY");
    expect(report.allowsLong).toBe(true);
    expect(report.allowsNewEntries).toBe(true);
    expect(report.edgeGated).toBe(false);
    expect(report.reasonCodes).toContain("EDGE_PROVEN_POSITIVE_LONG");
  });

  it("vetoes a proven-negative SHORT in Bearish expansion → NO_TRADE_NEGATIVE_EDGE", () => {
    const report = buildRegimeDirectionControllerReport({
      currentRegime: "Bearish expansion",
      edgeGate: gateOf({ SHORT: false }),
    });
    expect(report.controllerMode).toBe("NO_TRADE_NEGATIVE_EDGE");
    expect(report.allowsShort).toBe(false);
    expect(report.allowsNewEntries).toBe(false);
  });

  it("no edge gate → pure naive mapping unchanged (back-compat)", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    expect(report.controllerMode).toBe("LONG_ONLY");
    expect(report.edgeGated).toBe(false);
  });

  it("lane rescue: negative SHORT aggregate is NOT vetoed when a positive lane exists", () => {
    const gate = {
      verdict(_r: string | null | undefined, _d: "LONG" | "SHORT") {
        return { allowed: false, reasonCode: "EDGE_PROVEN_NEGATIVE", stat: { n: 2000, avgNetR: -0.2, winRate: 35 } };
      },
      hasPositiveLane(_r: string | null | undefined, d: "LONG" | "SHORT") {
        return d === "SHORT"; // a positive SHORT lane exists
      },
    };
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bearish expansion", edgeGate: gate });
    expect(report.controllerMode).toBe("SHORT_ONLY"); // not NO_TRADE — rescued by the lane
    expect(report.allowsShort).toBe(true);
    expect(report.allowsNewEntries).toBe(true);
    expect(report.reasonCodes).toContain("EDGE_LANE_RESCUE_SHORT");
  });
});
