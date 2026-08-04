import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isNewExecutorLaneAllowed, newExecutorLaneGate } from "../src/lib/live-executor-wiring.js";

/**
 * REGIME_COMPOSITE_CONFIRMATION_LONG — the only lane on the mainnet account with a positive
 * real-money record (9 closes, +$7.79) — stopped opening on 2026-07-14 while its own signal store
 * kept producing candidates through 2026-07-26. Twelve days, and its status panel reported
 * `entryBlockReason: null` the entire time, because the executor's only reason function was
 * `() => edgeVeto(dir).reason` — the LAST of five conditions. A null reason never meant "not
 * blocked"; it meant "not blocked by the one condition I can see", which looks exactly like healthy.
 *
 * These tests pin two things: every condition names itself, and .allowed is bit-for-bit what it was
 * before the split (a diagnostic change that silently altered admission would be far worse than the
 * missing diagnostic).
 */
type Engine = Parameters<typeof newExecutorLaneGate>[2];

function engine(o: Partial<Record<"armed" | "canOpen" | "explicit" | "allows", boolean>> = {}): Engine {
  return {
    isArmed: () => o.armed ?? true,
    canOpenNewEntries: () => o.canOpen ?? true,
    laneSelectionExplicitlyIncludesLane: () => o.explicit ?? true,
    laneSelectionAllowsLane: () => o.allows ?? true,
  } as Engine;
}

const LANE = "REGIME_COMPOSITE_CONFIRMATION_LONG";

describe("newExecutorLaneGate — every condition names itself", () => {
  it("passes cleanly with a null reason when nothing binds", () => {
    const g = newExecutorLaneGate(LANE, "mainnet", engine(), { mainnetEntryEligible: true });
    expect(g).toEqual({ allowed: true, reason: null });
  });

  it("a null engine is not silently 'allowed'", () => {
    const g = newExecutorLaneGate(LANE, "mainnet", null, { mainnetEntryEligible: true });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/ARMED/i);
  });

  it.each([
    [{ armed: false }, /ARMED/i, "not armed"],
    [{ canOpen: false }, /drain/i, "new-entry drain"],
    [{ explicit: false }, /allocation table/i, "not named in the allocation table"],
    [{ allows: false }, /0% weight/i, "allocated at zero"],
  ])("%#: reports %s", (flags, pattern) => {
    const g = newExecutorLaneGate(LANE, "mainnet", engine(flags), { mainnetEntryEligible: true });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(pattern);
  });

  /** THE CASE THAT WAS ACTUALLY BINDING for SHORT_FADE / PANIC_WASHOUT / INTRADAY_MOMENTUM. */
  it("reports mainnet ineligibility, and only on mainnet", () => {
    const blocked = newExecutorLaneGate(LANE, "mainnet", engine(), { mainnetEntryEligible: false });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/mainnet-entry-eligible/i);
    // The same lane on testnet is unaffected by that condition.
    expect(newExecutorLaneGate(LANE, "testnet", engine(), { mainnetEntryEligible: false }).allowed).toBe(true);
  });

  it("reports the FIRST binding condition, so the operator gets the actionable one", () => {
    // Not armed AND not allocated: 'armed' is the one to fix first and the one reported.
    const g = newExecutorLaneGate(LANE, "mainnet", engine({ armed: false, explicit: false }), { mainnetEntryEligible: true });
    expect(g.reason).toMatch(/ARMED/i);
  });
});

describe("the predicate and its explanation cannot drift apart", () => {
  /** isNewExecutorLaneAllowed is now a thin wrapper. Exhaustive over the 4 booleans x 2 envs x 2
   *  eligibility values: .allowed must equal the wrapper on every combination, and a reason must be
   *  present exactly when it is false. FAILS if anyone re-implements either half independently. */
  it("agrees on all 64 combinations, and reason is non-null exactly when blocked", () => {
    const bools = [true, false];
    let checked = 0;
    for (const armed of bools) for (const canOpen of bools) for (const explicit of bools) for (const allows of bools) {
      for (const env of ["mainnet", "testnet"] as const) for (const eligible of bools) {
        const e = engine({ armed, canOpen, explicit, allows });
        const gate = newExecutorLaneGate(LANE, env, e, { mainnetEntryEligible: eligible });
        expect(gate.allowed).toBe(isNewExecutorLaneAllowed(LANE, env, e, { mainnetEntryEligible: eligible }));
        expect(gate.reason === null).toBe(gate.allowed);
        checked += 1;
      }
    }
    expect(checked).toBe(64);
  });
});

describe("no executor is left reporting only the edge veto (source-level guard)", () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/app.ts"), "utf-8");

  /** FAILS WITHOUT THE FIX — all six executors used to be wired exactly this way. */
  it("no isAllowedReason is wired straight to edgeVeto", () => {
    // Skip comment lines — the doc block above legacyEntryBlockReason quotes the old wiring
    // verbatim to record what went wrong, and that quote must not read as a live call site.
    const wired = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .filter((l) => /isAllowedReason:\s*\(\)\s*=>\s*edgeVeto\(/.test(l));
    expect(wired, `still reporting only the edge veto:\n${wired.join("\n")}`).toHaveLength(0);
  });

  it("every LEGACY (mainnet-eligible) executor routes its reason through legacyEntryBlockReason", () => {
    // 2026-08-04 (fail-closed innovation campaign control): the 10 innovation-testnet
    // single-symbol executors gained their OWN isAllowedReason (see innovationCampaignAdmissionForLane
    // below) — a genuinely different admission chain (isInnovationTestnetExecutionEnabled +
    // the fail-closed campaign gate; testnet-only, never armed/drain/allocation-table/edge-veto)
    // from the one legacyEntryBlockReason composes. Routing an innovation lane's reason through
    // legacyEntryBlockReason would call newExecutorLaneGate for a lane id that was never meant to
    // be in the mainnet allocation table at all, producing an actively MISLEADING reason (e.g.
    // "not named in the allocation table") instead of the real one ("no active innovation
    // campaign") — so this guard now scopes itself to the legacy lines this test was written to
    // protect, and the sibling test below pins the innovation lines to their own, correct wiring.
    const reasons = src
      .split("\n")
      .filter((l) => /isAllowedReason:/.test(l) && !l.trim().startsWith("*"))
      .filter((l) => !l.includes("innovationCampaignAdmissionForLane"));
    expect(reasons.length).toBeGreaterThanOrEqual(6);
    for (const line of reasons) expect(line).toContain("legacyEntryBlockReason");
  });

  it("the innovation testnet lanes report the campaign's own reason instead — never legacyEntryBlockReason (a different admission chain entirely)", () => {
    const innovationReasonLines = src
      .split("\n")
      .filter((l) => /isAllowedReason:/.test(l) && !l.trim().startsWith("*"))
      .filter((l) => l.includes("innovationCampaignAdmissionForLane"));
    expect(innovationReasonLines.length).toBeGreaterThanOrEqual(1);
    for (const line of innovationReasonLines) {
      expect(line).not.toContain("legacyEntryBlockReason");
      expect(line).toContain("innovationCampaignAdmissionForLane");
    }
  });

  /** The orchestrator branch is the one condition that lives outside newExecutorLaneGate — if the
   *  reason helper forgets it, an orchestrator-denied lane reports null again. */
  it("the reason helper covers the unified-orchestrator branch too", () => {
    const at = src.indexOf("const legacyEntryBlockReason");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = src.slice(at, at + 1400);
    expect(body).toContain("unifiedOrchestrator?.isEnabled()");
    expect(body).toContain("allowsLegacySingleSymbolEntry");
    expect(body).toContain("newExecutorLaneGate");
    expect(body).toContain("edgeVeto(direction).reason");
  });
});

/**
 * 2026-08-04 validation finding (fail-closed innovation campaign control): mutating app.ts so the
 * campaign check gates the OUTER innovation-executor construction block (line ~2141's
 * `if (liveEngine && isInnovationTestnetExecutionEnabled(liveConfig.env))`) instead of living only
 * inside the per-tick isAllowed/entryHealthGate/isAllowedReason closures left the ENTIRE `npm test`
 * suite green — every SingleSymbolLaneExecutor/CrossSectionalExecutor unit test constructs its
 * executor directly, bypassing app.ts's construction gate entirely, and app.ts itself has no other
 * test file. That is exactly the restart hazard innovation-campaign.ts's own module doc comment
 * warns about: a restart while no campaign is active would then never construct the 13 innovation
 * executor instances at all, so monitorOpenPositions()/closeBasketsHittingProfitTarget()/
 * closeDueBaskets()/retryOrphanedLegFlattens()/ensureOpenBasketLeverage() would never run for
 * whatever positions/baskets those instances' store files record as OPEN — silently orphaning them
 * across the restart. These two source-level guards close that coverage gap: they fail the moment
 * anyone folds a campaign (or any other) condition into the outer gate or the tick-scheduling block,
 * which a full app.ts-construction integration test cannot do today (no test in this repo builds
 * buildApp() with a live engine + innovation execution enabled — confirmed by grep).
 */
describe("[FAIL-CLOSED CAMPAIGN — restart hazard] the outer innovation-executor construction gate and its tick-scheduling stay unconditional (source-level guard)", () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/app.ts"), "utf-8");

  it("the outer construction gate condition is exactly liveEngine + isInnovationTestnetExecutionEnabled — no campaign reference", () => {
    const gateLine = "if (liveEngine && isInnovationTestnetExecutionEnabled(liveConfig.env)) {";
    expect(src).toContain(gateLine);
    expect(gateLine.toLowerCase()).not.toContain("campaign");
  });

  it("the 13-executor tick-scheduling block is unconditional on `!isTest` alone — no campaign reference anywhere in it", () => {
    const tickBlock = [
      "      if (!isTest) {",
      "        const tickInnovations = async () => {",
      "          for (const executor of innovationBasketExecutors) await executor.tick();",
      "          for (const executor of innovationSingleSymbolExecutors) await executor.tick();",
      "        };",
      "        startInnovationTestnetExecutorSchedule(tickInnovations);",
      "      }",
    ].join("\n");
    expect(src).toContain(tickBlock);
    expect(tickBlock.toLowerCase()).not.toContain("campaign");
  });

  it("the campaign check lives ONLY inside innovationAllowed (AND-composed with the engine's own gate, never replacing it)", () => {
    // Uses this file's own established indexOf+slice+toContain technique (see "the reason helper
    // covers the unified-orchestrator branch too" above) rather than pinning exact line breaks —
    // innovationTestnetAdmissionAllowed's own call-site argument list is legitimately, independently
    // extended by a separate, concurrently-evolving workstream (canonical-market-regime-execution-
    // policy), and this guard must not spuriously break every time that unrelated call reflows. It
    // pins only the boundary THIS workstream owns: innovationAllowed's signature, with the campaign
    // check AND-ed in as the FIRST condition, immediately followed by the engine's own gate call.
    const at = src.indexOf("const innovationAllowed = (laneId: string): boolean =>");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = src.slice(at, at + 300);
    expect(body).toContain("innovationCampaignAdmissionForLane(laneId).allowed &&");
    expect(body).toContain("innovationTestnetAdmissionAllowed(");
    // The campaign check must come BEFORE the engine gate in this same expression — confirms AND,
    // in-order, not a disjoint pair of unrelated conditions elsewhere in the closure.
    expect(body.indexOf("innovationCampaignAdmissionForLane")).toBeLessThan(
      body.indexOf("innovationTestnetAdmissionAllowed"),
    );
  });
});
