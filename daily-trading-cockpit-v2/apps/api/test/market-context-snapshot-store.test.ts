import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MarketContextSnapshotStore } from "../src/lib/market-context-snapshot-store.js";

describe("MarketContextSnapshotStore", () => {
  it("persists a deterministic snapshot before review creation and rejects future source data", () => {
    const dir = mkdtempSync(join(tmpdir(), "market-context-"));
    try {
      const first = new MarketContextSnapshotStore(dir);
      const snapshot = first.capture({ instanceId: "3101", asOfMs: 1_000, sourceCutoffMs: 900, decisionPipelinePolicyVersion: "decision/1" });
      expect(snapshot?.marketContextSnapshotId).toBe("market-context:3101:900:decision/1");
      expect(first.capture({ instanceId: "3101", asOfMs: 1_000, sourceCutoffMs: 1_001, decisionPipelinePolicyVersion: "decision/1" })).toBeNull();
      const restored = new MarketContextSnapshotStore(dir);
      expect(restored.get().records).toHaveLength(1);
      expect(restored.capture({ instanceId: "3101", asOfMs: 1_500, sourceCutoffMs: 900, decisionPipelinePolicyVersion: "decision/1" })?.marketContextSnapshotId).toBe(snapshot?.marketContextSnapshotId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
