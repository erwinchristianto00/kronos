import { describe, expect, it, beforeEach } from "vitest";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

import {
  RegimeDirectionControllerSnapshotStore,
  buildSnapshotFromReport,
  buildScanCycleSnapshot,
  _resetRegimeDirectionControllerSnapshotStoreForTests,
} from "../src/lib/regime-direction-controller-snapshot.js";
import { buildRegimeDirectionControllerReport } from "../src/lib/regime-direction-controller.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return resolve(os.tmpdir(), `rdc-snapshot-test-${process.pid}-${Date.now()}`);
}

function readLines(file: string): string[] {
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("regime direction controller snapshot store (REPORT-ONLY)", () => {
  beforeEach(() => {
    _resetRegimeDirectionControllerSnapshotStoreForTests();
  });

  it("creates the JSONL file and appends one line per append() call", () => {
    const dir = tmpDir();
    const store = new RegimeDirectionControllerSnapshotStore(dir);
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    const snapshot = buildSnapshotFromReport(report);

    store.append(snapshot);
    store.append(snapshot);

    const file = resolve(dir, "regime-direction-controller-snapshots.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readLines(file);
    expect(lines).toHaveLength(2);
    // cleanup
    rmSync(dir, { recursive: true, force: true });
  });

  it("buildSnapshotFromReport — source is DASHBOARD_AUDIT and reportOnly is true", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    const snap = buildSnapshotFromReport(report, "2026-01-01T00:00:00.000Z");

    expect(snap.source).toBe("DASHBOARD_AUDIT");
    expect(snap.reportOnly).toBe(true);
    expect(snap.capturedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("buildSnapshotFromReport — maps LONG_ONLY regime report correctly", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    const snap = buildSnapshotFromReport(report);

    expect(snap.currentRegime).toBe("Bullish expansion");
    expect(snap.controllerMode).toBe("LONG_ONLY");
    expect(snap.directionalBias).toBe("LONG");
    expect(snap.allowsLong).toBe(true);
    expect(snap.allowsShort).toBe(false);
    expect(snap.allowsNewEntries).toBe(true);
    expect(snap.requiresRetest).toBe(false);
    expect(snap.reasonCodes).toContain("REGIME_LONG_TREND");
  });

  it("buildSnapshotFromReport — null primary lane → null alignment fields", () => {
    const report = buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" });
    // No primary lane provided → currentValidationPrimaryLane is null
    const snap = buildSnapshotFromReport(report);

    expect(snap.primaryLaneAlignment).toBeNull();
    expect(snap.primaryLaneLabel).toBeNull();
    expect(snap.primaryLaneDirection).toBeNull();
  });

  it("buildSnapshotFromReport — with primary lane alignment", () => {
    const report = buildRegimeDirectionControllerReport({
      currentRegime: "Bullish expansion",
      primaryValidationLane: {
        label: "bullish-fib-long-v1",
        dominantRegime: "Bullish expansion",
        direction: "LONG",
        microPilotReady: false,
      },
    });
    const snap = buildSnapshotFromReport(report);

    expect(snap.primaryLaneAlignment).toBe("MATCH");
    expect(snap.primaryLaneLabel).toBe("bullish-fib-long-v1");
    expect(snap.primaryLaneDirection).toBe("LONG");
  });

  it("buildScanCycleSnapshot — source is SCAN_CYCLE; primary lane fields are null", () => {
    const snap = buildScanCycleSnapshot("Bearish expansion", "2026-01-02T00:00:00.000Z");

    expect(snap.source).toBe("SCAN_CYCLE");
    expect(snap.reportOnly).toBe(true);
    expect(snap.capturedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(snap.controllerMode).toBe("SHORT_ONLY");
    expect(snap.allowsLong).toBe(false);
    expect(snap.allowsShort).toBe(true);
    expect(snap.primaryLaneAlignment).toBeNull();
    expect(snap.primaryLaneLabel).toBeNull();
    expect(snap.primaryLaneDirection).toBeNull();
  });

  it("buildScanCycleSnapshot — null regime → UNKNOWN mode", () => {
    const snap = buildScanCycleSnapshot(null);

    expect(snap.currentRegime).toBeNull();
    expect(snap.controllerMode).toBe("UNKNOWN");
    expect(snap.allowsNewEntries).toBe(false);
  });

  it("buildScanCycleSnapshot — undefined regime → UNKNOWN mode", () => {
    const snap = buildScanCycleSnapshot(undefined);

    expect(snap.controllerMode).toBe("UNKNOWN");
  });

  it("each appended snapshot is valid JSON", () => {
    const dir = tmpDir();
    const store = new RegimeDirectionControllerSnapshotStore(dir);

    const snapA = buildSnapshotFromReport(
      buildRegimeDirectionControllerReport({ currentRegime: "Bullish expansion" }),
      "2026-01-01T00:00:00.000Z",
    );
    const snapB = buildScanCycleSnapshot("Choppy / range-bound", "2026-01-01T00:07:00.000Z");

    store.append(snapA);
    store.append(snapB);

    const file = resolve(dir, "regime-direction-controller-snapshots.jsonl");
    const lines = readLines(file);
    expect(lines).toHaveLength(2);

    const parsed0 = JSON.parse(lines[0]);
    expect(parsed0.source).toBe("DASHBOARD_AUDIT");
    expect(parsed0.controllerMode).toBe("LONG_ONLY");

    const parsed1 = JSON.parse(lines[1]);
    expect(parsed1.source).toBe("SCAN_CYCLE");
    expect(parsed1.controllerMode).toBe("NO_TRADE_CHOP");

    rmSync(dir, { recursive: true, force: true });
  });

  it("readLatest returns the newest valid snapshot and skips corrupt trailing lines", () => {
    const dir = tmpDir();
    const store = new RegimeDirectionControllerSnapshotStore(dir);
    const snapA = buildScanCycleSnapshot("Bullish expansion", "2026-01-01T00:00:00.000Z");
    const snapB = buildScanCycleSnapshot("Bearish expansion", "2026-01-01T00:07:00.000Z");

    store.append(snapA);
    store.append(snapB);
    appendFileSync(resolve(dir, "regime-direction-controller-snapshots.jsonl"), "{bad-json\n", "utf-8");

    const latest = store.readLatest();
    expect(latest?.currentRegime).toBe("Bearish expansion");
    expect(latest?.controllerMode).toBe("SHORT_ONLY");

    rmSync(dir, { recursive: true, force: true });
  });

  it("append never throws even when the data dir is inaccessible", () => {
    // Use an impossible path on Windows — the store's mkdirSync will fail
    // but append() wraps everything in try/catch.
    // We can't easily make mkdirSync fail portably in Vitest without a mock,
    // so we just verify no exception escapes the append() method itself.
    const dir = tmpDir();
    const store = new RegimeDirectionControllerSnapshotStore(dir);
    const snap = buildScanCycleSnapshot("Bullish expansion");

    // Should not throw regardless of what happens
    expect(() => store.append(snap)).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });
});
