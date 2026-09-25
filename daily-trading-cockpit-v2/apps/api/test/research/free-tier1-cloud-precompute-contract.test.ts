import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const configPath = fileURLToPath(new URL("../../../../cloudbuild/precompute-free-tier1-prelifecycle.yaml", import.meta.url));

describe("free Tier-1 cloud Foundry precompute contract", () => {
  it("requires the complete eight-object daily repair manifest", () => {
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain('len(repair_manifest.get("objects", [])) != 8');
    expect(config).not.toContain('len(repair_manifest.get("objects", [])) != 6');
  });

  it("persists and reloads Foundry artifacts without an implicit empirical tournament", () => {
    const config = readFileSync(configPath, "utf8");
    const stepIds = [...config.matchAll(/^\s+id: ([^\n]+)$/gm)].map((match) => match[1]);
    expect(stepIds).toEqual([
      "stage-generation-pinned-raw",
      "build-prelifecycle-artifacts",
      "persist-and-reload-artifacts",
      "verify-gcs-reload",
      "persist-final-report",
    ]);
    expect(config).not.toMatch(/run-oos-walk-forward|run-sealed-holdout|run-predeclared-robustness/);
  });
});
