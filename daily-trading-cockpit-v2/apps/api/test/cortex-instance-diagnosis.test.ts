import { describe, expect, it } from "vitest";

import { diagnoseCortexInstance } from "../src/lib/cortex-instance-diagnosis.js";

describe("diagnoseCortexInstance", () => {
  it("identifies the 3101 shadow/live-engine wiring gap", () => {
    const result = diagnoseCortexInstance({
      env: { CENTRAL_BRAIN_MODE: "shadow", LIVE_EXECUTION_ENABLED: "0" },
      brainPresent: false,
      refitPresent: false,
      collectionPresent: true,
    });
    expect(result.code).toBe("BLOCKED_BY_LIVE_ENGINE_WIRING");
    expect(result.evidence).toContain("collection=present");
  });

  it("does not report a blocker when brain state exists", () => {
    const result = diagnoseCortexInstance({
      env: { CENTRAL_BRAIN_MODE: "shadow", LIVE_EXECUTION_ENABLED: "0" },
      brainPresent: true,
      refitPresent: true,
      collectionPresent: true,
    });
    expect(result.code).toBe("STATE_PRESENT");
  });
});
