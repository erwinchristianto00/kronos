import { describe, expect, it } from "vitest";

import {
  diagnoseCortexInstance,
  standaloneCortexShadowAllowed,
} from "../src/lib/cortex-instance-diagnosis.js";

describe("diagnoseCortexInstance", () => {
  it("reports the standalone lifecycle as ready on 3101 without live execution", () => {
    const result = diagnoseCortexInstance({
      env: { CENTRAL_BRAIN_MODE: "shadow", LIVE_EXECUTION_ENABLED: "0", PORT: "3101" },
      brainPresent: false,
      refitPresent: false,
      collectionPresent: true,
    });
    expect(result.code).toBe("STANDALONE_SHADOW_READY");
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

  it("hard-blocks standalone lifecycle on 3103 and whenever a live engine exists", () => {
    expect(
      standaloneCortexShadowAllowed({
        env: { CENTRAL_BRAIN_MODE: "shadow", LIVE_EXECUTION_ENABLED: "0", PORT: "3103" },
        liveEnginePresent: false,
      }),
    ).toBe(false);
    expect(
      standaloneCortexShadowAllowed({
        env: { CENTRAL_BRAIN_MODE: "shadow", LIVE_EXECUTION_ENABLED: "1", PORT: "3102" },
        liveEnginePresent: true,
      }),
    ).toBe(false);
  });
});
