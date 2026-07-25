import { describe, it, expect } from "vitest";
import {
  evaluateCrisisMode,
  DEFAULT_CRISIS_MODE_PARAMS,
  CRISIS_MODE_CONTROLLER_DISABLED_FLAG,
  CRISIS_MODE_ACTION_ENABLED_FLAG,
  isCrisisModeActionEnabled,
  type CrisisModeParams,
  type CrisisModeMarketShockSignals,
} from "../src/lib/crisis-mode-controller.js";
import { DEFAULT_EXIT_BRAIN_PARAMS } from "../src/lib/exit-brain-policy.js";
import type { EscalationClassification } from "../src/lib/geopolitical-escalation-classifier.js";

function classification(overrides: Partial<EscalationClassification> = {}): EscalationClassification {
  return {
    quantitativeScore: 0,
    llmSeverity: null,
    llmAvailable: false,
    llmConfidence: null,
    finalScore: 0,
    reasoning: ["stub reasoning line"],
    ...overrides,
  };
}

function noMarketConfirmation(): CrisisModeMarketShockSignals {
  return { btcShock: null, regimeAxisScore: null };
}

function confirmedBtcShock(zScore = 5): CrisisModeMarketShockSignals {
  return { btcShock: { isShock: true, zScore, direction: "SHORT" }, regimeAxisScore: null };
}

function confirmedAxis(score = -0.8): CrisisModeMarketShockSignals {
  return { btcShock: null, regimeAxisScore: score };
}

describe("evaluateCrisisMode", () => {
  describe("SAFETY INVARIANT 1: escalation alone is never sufficient", () => {
    it("returns active:false when escalation is maxed out (100) but there is NO market confirmation", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), noMarketConfirmation());
      expect(result.active).toBe(false);
      expect(result.allocationTiltPct).toBe(0);
      expect(result.exitToleranceOverride).toBeNull();
      expect(result.reason).toContain("INACTIVE_NO_MARKET_CONFIRMATION");
      expect(result.evidence.escalationGatePassed).toBe(true);
      expect(result.evidence.marketConfirmationPassed).toBe(false);
    });

    it("still returns active:false at finalScore=100 when btcShock exists but is not actually a shock", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), {
        btcShock: { isShock: false, zScore: 0.4, direction: null },
        regimeAxisScore: null,
      });
      expect(result.active).toBe(false);
    });

    it("still returns active:false when btcShock is a LONG-direction shock (crisis mode is bearish-only)", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), {
        btcShock: { isShock: true, zScore: 10, direction: "LONG" },
        regimeAxisScore: null,
      });
      expect(result.active).toBe(false);
    });

    it("still returns active:false when btcShock z-score is below the confirmation threshold", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), {
        btcShock: { isShock: true, zScore: 1, direction: "SHORT" },
        regimeAxisScore: null,
      });
      expect(result.active).toBe(false);
    });

    it("still returns active:false when regimeAxisScore is bearish but not past the ceiling", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), {
        btcShock: null,
        regimeAxisScore: -0.1,
      });
      expect(result.active).toBe(false);
    });

    it("still returns active:false when market signals are non-finite garbage (fail-open direction)", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), {
        btcShock: { isShock: true, zScore: Number.POSITIVE_INFINITY, direction: "SHORT" },
        regimeAxisScore: Number.NEGATIVE_INFINITY,
      });
      expect(result.active).toBe(false);
    });

    it("goes active once a real market confirmation is added on top of the same high escalation score", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), confirmedBtcShock(6));
      expect(result.active).toBe(true);
    });

    it("also goes active via the independent RCS axis leg alone", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), confirmedAxis(-0.9));
      expect(result.active).toBe(true);
    });

    it("stays inactive below the escalation threshold even WITH full market confirmation", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 10 }), confirmedBtcShock(10));
      expect(result.active).toBe(false);
      expect(result.reason).toContain("INACTIVE_ESCALATION_BELOW_THRESHOLD");
    });
  });

  describe("SAFETY INVARIANT 2: allocationTiltPct is always capped", () => {
    it("caps tilt at the default maxTiltPct (15) even at a maxed escalation score with confirmation", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), confirmedBtcShock(8));
      expect(result.active).toBe(true);
      expect(result.allocationTiltPct).toBeLessThanOrEqual(DEFAULT_CRISIS_MODE_PARAMS.maxTiltPct);
      expect(result.allocationTiltPct).toBe(DEFAULT_CRISIS_MODE_PARAMS.maxTiltPct);
    });

    it("caps tilt even with a deliberately extreme finalScore far outside [0,100]", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 1e12 }), confirmedAxis());
      expect(result.active).toBe(true);
      expect(result.allocationTiltPct).toBe(DEFAULT_CRISIS_MODE_PARAMS.maxTiltPct);
      expect(Number.isFinite(result.allocationTiltPct)).toBe(true);
    });

    it("caps tilt even with a deliberately extreme/garbage tiltPctPerScorePoint param", () => {
      const params: CrisisModeParams = { ...DEFAULT_CRISIS_MODE_PARAMS, tiltPctPerScorePoint: 1e9 };
      const result = evaluateCrisisMode(classification({ finalScore: 76 }), confirmedBtcShock(4), params);
      expect(result.active).toBe(true);
      expect(result.allocationTiltPct).toBe(params.maxTiltPct);
    });

    it("respects a custom (smaller) maxTiltPct override", () => {
      const params: CrisisModeParams = { ...DEFAULT_CRISIS_MODE_PARAMS, maxTiltPct: 3, tiltPctPerScorePoint: 1e9 };
      const result = evaluateCrisisMode(classification({ finalScore: 90 }), confirmedBtcShock(4), params);
      expect(result.active).toBe(true);
      expect(result.allocationTiltPct).toBe(3);
    });

    it("is exactly 0 whenever inactive, regardless of inputs", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 1e12 }), noMarketConfirmation());
      expect(result.active).toBe(false);
      expect(result.allocationTiltPct).toBe(0);
    });
  });

  describe("exitToleranceOverride", () => {
    it("is null when inactive", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), noMarketConfirmation());
      expect(result.exitToleranceOverride).toBeNull();
    });

    it("widens (never narrows) the retrace tolerance and lowers roundTripGuardR when active", () => {
      const result = evaluateCrisisMode(classification({ finalScore: 90 }), confirmedBtcShock(5));
      expect(result.active).toBe(true);
      const override = result.exitToleranceOverride!;
      expect(override.baseRetraceFrac).toBeGreaterThan(DEFAULT_EXIT_BRAIN_PARAMS.baseRetraceFrac);
      expect(override.minRetraceFrac).toBeGreaterThan(DEFAULT_EXIT_BRAIN_PARAMS.minRetraceFrac);
      expect(override.roundTripGuardR).toBeLessThan(DEFAULT_EXIT_BRAIN_PARAMS.roundTripGuardR);
    });

    it("clamps the override fields to the documented safe range even with extreme widen params", () => {
      const params: CrisisModeParams = {
        ...DEFAULT_CRISIS_MODE_PARAMS,
        baseRetraceFracWidenBy: 1e6,
        minRetraceFracWidenBy: 1e6,
        roundTripGuardRLowerBy: 1e6,
      };
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), confirmedAxis(), params);
      expect(result.active).toBe(true);
      const override = result.exitToleranceOverride!;
      expect(override.baseRetraceFrac).toBe(params.maxBaseRetraceFrac);
      expect(override.minRetraceFrac).toBe(params.maxMinRetraceFrac);
      expect(override.roundTripGuardR).toBe(params.minRoundTripGuardR);
    });
  });

  describe("kill switch (CRISIS_MODE_CONTROLLER_DISABLED)", () => {
    it("forces INACTIVE even with a maxed escalation score and full market confirmation", () => {
      const env = { [CRISIS_MODE_CONTROLLER_DISABLED_FLAG]: "1" } as NodeJS.ProcessEnv;
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), confirmedBtcShock(10), DEFAULT_CRISIS_MODE_PARAMS, env);
      expect(result.active).toBe(false);
      expect(result.reason).toContain("INACTIVE_KILL_SWITCH");
    });

    it("does not affect evaluation when unset", () => {
      const env = {} as NodeJS.ProcessEnv;
      const result = evaluateCrisisMode(classification({ finalScore: 100 }), confirmedBtcShock(10), DEFAULT_CRISIS_MODE_PARAMS, env);
      expect(result.active).toBe(true);
    });
  });

  describe("action gate (wiring-layer flag, not read internally)", () => {
    it("defaults to disabled", () => {
      expect(isCrisisModeActionEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    });

    it("is enabled only when explicitly set to '1'", () => {
      expect(isCrisisModeActionEnabled({ [CRISIS_MODE_ACTION_ENABLED_FLAG]: "1" } as NodeJS.ProcessEnv)).toBe(true);
      expect(isCrisisModeActionEnabled({ [CRISIS_MODE_ACTION_ENABLED_FLAG]: "true" } as NodeJS.ProcessEnv)).toBe(false);
    });

    it("evaluateCrisisMode's active output is unaffected by the action-enabled flag (that flag only gates the wiring layer)", () => {
      const withoutFlag = evaluateCrisisMode(classification({ finalScore: 100 }), confirmedBtcShock(6));
      expect(withoutFlag.active).toBe(true); // the flag was never consulted, and never needs to be
    });
  });

  describe("audit trail / evidence", () => {
    it("prepends the escalation classification's own reasoning[] verbatim", () => {
      const result = evaluateCrisisMode(
        classification({ finalScore: 100, reasoning: ["custom escalation line A", "custom escalation line B"] }),
        confirmedBtcShock(6),
      );
      expect(result.reasoning[0]).toBe("custom escalation line A");
      expect(result.reasoning[1]).toBe("custom escalation line B");
    });

    it("always carries full typed evidence, active or not", () => {
      const inactive = evaluateCrisisMode(classification({ finalScore: 10 }), noMarketConfirmation());
      expect(inactive.evidence.escalationFinalScore).toBe(10);
      expect(inactive.evidence.btcShockConfirmed).toBe(false);
      expect(inactive.evidence.regimeAxisConfirmed).toBe(false);

      const active = evaluateCrisisMode(classification({ finalScore: 100 }), confirmedAxis(-0.9));
      expect(active.evidence.regimeAxisConfirmed).toBe(true);
      expect(active.evidence.marketConfirmationPassed).toBe(true);
    });

    it("reasoning ends with a decision line describing the outcome", () => {
      const active = evaluateCrisisMode(classification({ finalScore: 90 }), confirmedBtcShock(5));
      expect(active.reasoning.at(-1)).toContain("ACTIVE:");

      const inactive = evaluateCrisisMode(classification({ finalScore: 90 }), noMarketConfirmation());
      expect(inactive.reasoning.at(-1)).toContain("INACTIVE_NO_MARKET_CONFIRMATION");
    });
  });

  describe("fail-open on invalid escalation input", () => {
    it("treats a non-finite finalScore as gate-failed (never treated as maximal escalation)", () => {
      const result = evaluateCrisisMode(classification({ finalScore: Number.NaN }), confirmedBtcShock(10));
      expect(result.active).toBe(false);
      expect(result.evidence.escalationGatePassed).toBe(false);
    });
  });
});
