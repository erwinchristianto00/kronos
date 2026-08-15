import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExitBrainShadowStore,
  exitBrainShadowDataDirForCohort,
  runExitBrainShadowCycle,
  type ExitBrainResolvedTrade,
} from "../src/lib/exit-brain-shadow.js";
import { resolveFourBrainTestnetCohort } from "../src/lib/four-brain-testnet-cohort.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-exit-cohort-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const cohort = resolveFourBrainTestnetCohort({
  FOUR_BRAIN_TESTNET_FOCUS: "1",
  LIVE_BINANCE_ENV: "testnet",
  FOUR_BRAIN_TESTNET_FOCUS_SINCE: "2026-08-13T07:42:59Z",
} as NodeJS.ProcessEnv)!;

function trade(overrides: Partial<ExitBrainResolvedTrade>): ExitBrainResolvedTrade {
  const closeMs = Date.parse(overrides.closedAtIso ?? "2026-08-13T08:00:00Z");
  return {
    tradeId: overrides.tradeId ?? "t",
    laneId: overrides.laneId ?? "CROSS_SECTIONAL_DIRECTIONAL_SHORT",
    symbol: overrides.symbol ?? "XRPUSDT",
    direction: overrides.direction ?? "SHORT",
    closedAtIso: overrides.closedAtIso ?? "2026-08-13T08:00:00Z",
    actualExitR: overrides.actualExitR ?? 0.1,
    ticks: overrides.ticks ?? Array.from({ length: 9 }, (_, i) => ({ tsMs: closeMs - (8 - i) * 60_000, currentR: i === 8 ? 0.1 : 0 })),
    tier: overrides.tier,
  };
}

describe("Exit Brain focused-testnet scope", () => {
  it("uses a dedicated store directory instead of the historical global ledger", () => {
    const root = tmp();
    expect(exitBrainShadowDataDirForCohort(root, cohort)).toBe(join(root, "four-brain-testnet-focus"));
    expect(exitBrainShadowDataDirForCohort(root, null)).toBe(root);
  });

  it("admits only post-cutoff cohort trades and canonicalizes raw MFE Giveback", async () => {
    const store = new ExitBrainShadowStore(exitBrainShadowDataDirForCohort(tmp(), cohort), cohort);
    const result = await runExitBrainShadowCycle({
      store,
      cohort,
      readResolvedTrades: () => [
        trade({ tradeId: "directional", laneId: "CROSS_SECTIONAL_DIRECTIONAL_SHORT" }),
        trade({ tradeId: "mfe", laneId: "CG_VARIANT_MATRIX:CG_MFE_GIVEBACK", direction: "LONG" }),
        trade({ tradeId: "legacy-lane", laneId: "CG_VARIANT_MATRIX:CG_WIDE_STOP_TP_WIDE" }),
        trade({ tradeId: "before-cutoff", closedAtIso: "2026-08-13T07:42:58Z" }),
      ],
    });

    expect(result.processed).toBe(2);
    const report = store.buildReport();
    expect(report.scope).toEqual({
      mode: "FOUR_BRAIN_TESTNET_COHORT",
      label: "3 lane testnet cohort",
      sinceIso: "2026-08-13T07:42:59.000Z",
      laneIds: [
        "CROSS_SECTIONAL_MARKET_NEUTRAL",
        "CROSS_SECTIONAL_DIRECTIONAL_LONG",
        "CROSS_SECTIONAL_DIRECTIONAL_SHORT",
        "CG_MFE_GIVEBACK_LONG",
        "CG_MFE_GIVEBACK_SHORT",
      ],
    });
    expect(report.recent.map((row) => row.laneId).sort()).toEqual([
      "CG_MFE_GIVEBACK_LONG",
      "CROSS_SECTIONAL_DIRECTIONAL_SHORT",
    ]);
  });
});
