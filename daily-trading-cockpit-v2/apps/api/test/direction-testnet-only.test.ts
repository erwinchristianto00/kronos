import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Direction panel must never quietly show research's numbers.
 *
 * Measured 2026-07-28: research's edge memory holds THREE samples in total
 * (BULLISH_EXPANSION::LONG n=2, MIXED_ROTATION::SHORT n=1) against testnet's nineteen, and none of
 * research's are in the regime family the market is actually in — so research's longEdge/shortEdge
 * can never resolve and its readiness verdict is noise dressed as evidence. Falling back to it when
 * testnet blinks does not degrade gracefully; it swaps the answer for a different one and says
 * nothing. That silent swap is also what made the panel appear to flip datasets on its own.
 */
const web = (f: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../web/src", f), "utf-8");
const HOOK = web("InnovationLanesCard.tsx");
const CARD = web("FourBrainDashboardCard.tsx");

describe("the Direction/Entry panel is pinned to testnet", () => {
  /** FAILS WITHOUT THE FIX — the hook always fell through to the local instance. */
  it("the hook can refuse the local fallback", () => {
    expect(HOOK).toContain("testnetOnly?: boolean");
    expect(HOOK).toContain("if (data == null && opts?.testnetOnly !== true) {");
  });

  it("the four-brain card asks for it on direction-entry-outcomes", () => {
    const at = CARD.indexOf("useShadowReport<DirectionEntryOutcomesResponse>('direction-entry-outcomes'");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(CARD.slice(at, at + 160)).toContain("DIRECTION_TESTNET_ONLY");
    expect(CARD).toContain("const DIRECTION_TESTNET_ONLY = { testnetOnly: true } as const;");
  });

  /** A fresh object literal at the call site would be a new effect dependency on every render,
   *  re-firing the fetch in a loop. THE GUARD. */
  it("passes a module-level constant, not an inline literal", () => {
    expect(CARD).not.toMatch(/useShadowReport<DirectionEntryOutcomesResponse>\([^)]*\{\s*testnetOnly/);
  });

  it("the hook re-subscribes when the mode changes", () => {
    expect(HOOK).toContain("}, [endpoint, opts?.testnetOnly]);");
  });

  /** The other panels keep the fallback — only Direction/Entry has a dataset that cannot answer. */
  it("does not pin every other report to testnet", () => {
    expect(CARD).toContain("useShadowReport<FourBrainReport>('four-brain')");
  });

  it("the badge stops claiming a dataset swap that can no longer happen", () => {
    expect(CARD).toContain("sengaja TIDAK jatuh ke research/3101");
    expect(CARD).not.toContain("jadi angka ini dari instance LOKAL (research/3101)");
  });
});
