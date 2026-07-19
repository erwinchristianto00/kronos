/**
 * Regression test for the 2026-07-19 manual-entry-decision bug: refreshManualEntryDecision (extracted
 * from routes/scan.ts) must call setManualEntryDecision whenever manual selector mode is on, entirely
 * independent of REALTIME_SHORT_MIRROR_ENABLED (an unrelated, SHORT-only, testnet-only diagnostic
 * flag that used to be the ONLY call site for this setter). Before the fix, with that flag off/unset
 * (its default), the setter was never called, so LiveExecutionEngine.canOpenNewEntries() stayed
 * permanently false for every single-symbol lane whenever manual mode + a directional allocation
 * were both configured — regardless of what the operator actually allocated.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refreshManualEntryDecision, type ManualEntryDecisionLiveEngine } from "../src/routes/scan.js";
import { RegimeEngineStore, _resetRegimeEngineStoreForTests } from "../src/lib/regime-engine-service.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "regime-engine-store-"));
  dirs.push(d);
  return d;
}

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  _resetRegimeEngineStoreForTests(null);
});

function fakeLiveEngine(manualSelectorMode: boolean): ManualEntryDecisionLiveEngine & { setManualEntryDecision: ReturnType<typeof vi.fn> } {
  return {
    isManualSelectorMode: () => manualSelectorMode,
    setManualEntryDecision: vi.fn(),
  };
}

describe("refreshManualEntryDecision", () => {
  it("calls setManualEntryDecision(null) when manual selector mode is off", () => {
    _resetRegimeEngineStoreForTests(new RegimeEngineStore(tmp()));
    const engine = fakeLiveEngine(false);
    const result = refreshManualEntryDecision(engine);
    expect(result.manualSelectorMode).toBe(false);
    expect(result.manualEntryDecision).toBeNull();
    expect(engine.setManualEntryDecision).toHaveBeenCalledWith(null);
  });

  it("never throws and returns a safe default when the live engine is null", () => {
    _resetRegimeEngineStoreForTests(new RegimeEngineStore(tmp()));
    expect(() => refreshManualEntryDecision(null)).not.toThrow();
    const result = refreshManualEntryDecision(null);
    expect(result).toEqual({ manualSelectorMode: false, manualEntryDecision: null });
  });

  it("REGRESSION: calls setManualEntryDecision with a real (non-null) decision when manual mode is on, with REALTIME_SHORT_MIRROR_ENABLED unset (its default/off state)", () => {
    delete process.env.REALTIME_SHORT_MIRROR_ENABLED;
    _resetRegimeEngineStoreForTests(new RegimeEngineStore(tmp()));
    const engine = fakeLiveEngine(true);
    const result = refreshManualEntryDecision(engine);
    expect(result.manualSelectorMode).toBe(true);
    // buildRegimeAxisTimeline always returns a concrete entryDecision object (action defaults to
    // NO_TRADE on empty history, but the OBJECT itself is never null) — the setter must receive it.
    expect(result.manualEntryDecision).not.toBeNull();
    expect(engine.setManualEntryDecision).toHaveBeenCalledTimes(1);
    const [passed] = engine.setManualEntryDecision.mock.calls[0]!;
    expect(passed).not.toBeNull();
    expect(passed).toMatchObject({ action: expect.any(String) });
    expect(["LONG", "SHORT", null]).toContain(passed.directionalBias);
    expect(typeof passed.observedAt).toBe("string");
  });

  it("REGRESSION: still calls setManualEntryDecision with a real decision when manual mode is on and REALTIME_SHORT_MIRROR_ENABLED is explicitly \"0\" (confirms independence from that flag)", () => {
    process.env.REALTIME_SHORT_MIRROR_ENABLED = "0";
    _resetRegimeEngineStoreForTests(new RegimeEngineStore(tmp()));
    const engine = fakeLiveEngine(true);
    refreshManualEntryDecision(engine);
    expect(engine.setManualEntryDecision).toHaveBeenCalledTimes(1);
    expect(engine.setManualEntryDecision.mock.calls[0]![0]).not.toBeNull();
  });
});
