export type CortexInstanceDiagnosisCode =
  | "STATE_PRESENT"
  | "MODE_OFF"
  | "BLOCKED_BY_LIVE_ENGINE_WIRING"
  | "STATE_MISSING_FOR_UNKNOWN_REASON";

export interface CortexInstanceDiagnosis {
  code: CortexInstanceDiagnosisCode;
  rootCause: string;
  evidence: string[];
  reportOnly: true;
}

/**
 * Explain missing CORTEX state without changing any mode, beta, or wiring. The current app constructs
 * the CORTEX store/tick/refit inside the live-engine block, so a research instance configured for
 * shadow learning but with LIVE_EXECUTION_ENABLED=0 cannot create cortex-brain.json.
 */
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
    return {
      code: "BLOCKED_BY_LIVE_ENGINE_WIRING",
      rootCause:
        "CORTEX lifecycle construction is nested under LIVE_EXECUTION_ENABLED, so this shadow instance collects lineage but cannot create or refit brain state.",
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
