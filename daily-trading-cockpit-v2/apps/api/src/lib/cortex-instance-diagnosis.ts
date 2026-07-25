import { fourBrainInstanceAllowed } from "./four-brain-live-gather-bindings.js";

export type CortexInstanceDiagnosisCode =
  | "STATE_PRESENT"
  | "MODE_OFF"
  | "STANDALONE_SHADOW_READY"
  | "STATE_MISSING_FOR_UNKNOWN_REASON";

export interface CortexInstanceDiagnosis {
  code: CortexInstanceDiagnosisCode;
  rootCause: string;
  evidence: string[];
  reportOnly: true;
}

/** A standalone lifecycle is allowed only in shadow mode, without a live engine, and on the same hard
 * research/testnet allowlist used by Four-Brain. This excludes 3103 even if its env is changed. */
export function standaloneCortexShadowAllowed(args: {
  env: NodeJS.ProcessEnv;
  liveEnginePresent: boolean;
}): boolean {
  const mode = (args.env.CENTRAL_BRAIN_MODE ?? "").trim().toLowerCase();
  return mode === "shadow" && !args.liveEnginePresent && fourBrainInstanceAllowed(args.env);
}

/** Explain missing CORTEX state without changing mode, beta, or execution wiring. */
export function diagnoseCortexInstance(args: {
  env: NodeJS.ProcessEnv;
  brainPresent: boolean;
  refitPresent: boolean;
  collectionPresent: boolean;
}): CortexInstanceDiagnosis {
  const mode = (args.env.CENTRAL_BRAIN_MODE ?? "").trim().toLowerCase();
  const liveExecutionEnabled = args.env.LIVE_EXECUTION_ENABLED === "1";
  const evidence = [
    `CENTRAL_BRAIN_MODE=${mode || "(unset)"}`,
    `LIVE_EXECUTION_ENABLED=${liveExecutionEnabled ? "1" : "0"}`,
    `cortex-brain=${args.brainPresent ? "present" : "missing"}`,
    `refit=${args.refitPresent ? "present" : "missing"}`,
    `collection=${args.collectionPresent ? "present" : "missing"}`,
  ];

  if (args.brainPresent) {
    return {
      code: "STATE_PRESENT",
      rootCause: "CORTEX brain state exists on this instance.",
      evidence,
      reportOnly: true,
    };
  }
  if (mode !== "shadow" && mode !== "live") {
    return {
      code: "MODE_OFF",
      rootCause: "CORTEX state is absent because CENTRAL_BRAIN_MODE is not active.",
      evidence,
      reportOnly: true,
    };
  }
  if (!liveExecutionEnabled) {
    if (standaloneCortexShadowAllowed({ env: args.env, liveEnginePresent: false })) {
      return {
        code: "STANDALONE_SHADOW_READY",
        rootCause:
          "CORTEX standalone shadow lifecycle is allowed on this research/testnet instance; missing state means boot/tick verification is still pending.",
        evidence,
        reportOnly: true,
      };
    }
    return {
      code: "STATE_MISSING_FOR_UNKNOWN_REASON",
      rootCause: "CORTEX state is missing and this instance is not allowlisted for standalone shadow lifecycle.",
      evidence,
      reportOnly: true,
    };
  }
  return {
    code: "STATE_MISSING_FOR_UNKNOWN_REASON",
    rootCause: "CORTEX is enabled and live execution is active, but its brain state is still missing.",
    evidence,
    reportOnly: true,
  };
}
