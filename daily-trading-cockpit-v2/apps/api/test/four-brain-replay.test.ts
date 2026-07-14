import { describe, it, expect } from "vitest";
import {
  replayEntryNotBlocked,
  replayOpenPositionExit,
  replayKillLatchedAllBlocked,
} from "../src/lib/four-brain-replay-harness.js";

describe("Four-Brain replay harness — semantic entry/exit validation (kill-latch-independent)", () => {
  it("clean proven-edge signal, kill NOT latched ⇒ an Entry candidate that is NOT risk-blocked (VALID)", () => {
    const r = replayEntryNotBlocked();
    const entryDecisions = r.executiveDecisions.filter((d) => d.entry !== null);
    expect(entryDecisions.length).toBeGreaterThan(0);
    const notBlocked = entryDecisions.filter((d) => d.candidateStatus !== "BLOCKED_BY_RISK");
    expect(notBlocked.length).toBeGreaterThan(0);
    // the strongest outcome for a clean fresh proven-edge signal is a VALID candidate (ENTER_NOW upstream)
    expect(notBlocked.some((d) => d.candidateStatus === "VALID")).toBe(true);
    expect(r.executiveDecisions.every((d) => d.reportOnly === true)).toBe(true);
  });

  it("an open position with a fresh mark ⇒ an ExitDecision is produced", () => {
    const r = replayOpenPositionExit();
    const exitDecisions = r.executiveDecisions.filter((d) => d.exit !== null);
    expect(exitDecisions.length).toBeGreaterThan(0);
    expect(exitDecisions[0]!.exit!.action).toBeTruthy();
  });

  it("kill LATCHED ⇒ EVERY candidate is BLOCKED_BY_RISK (reproduces the live-latched invariant)", () => {
    const r = replayKillLatchedAllBlocked();
    expect(r.executiveDecisions.length).toBeGreaterThan(0);
    expect(r.executiveDecisions.every((d) => d.candidateStatus === "BLOCKED_BY_RISK")).toBe(true);
  });

  it("replays are deterministic (same fixture ⇒ same executive candidateStatus sequence)", () => {
    const a = replayEntryNotBlocked();
    const b = replayEntryNotBlocked();
    expect(a.executiveDecisions.map((d) => d.candidateStatus)).toEqual(b.executiveDecisions.map((d) => d.candidateStatus));
  });
});
