import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DecisionLedger } from "../src/lib/decision-ledger.js";
import { classifyReflection } from "../src/lib/reflection-agent.js";

function tempLedgerFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtc-ledger-"));
  return join(dir, "decision-log.jsonl");
}

describe("DecisionLedger", () => {
  it("writes append-only events", () => {
    const file = tempLedgerFile();
    const ledger = new DecisionLedger(file);
    const ts = new Date().toISOString();
    ledger.recordPlanSelected({
      timestamp: ts,
      symbol: "BTCUSDT",
      direction: "LONG",
      routeMode: "PROFIT_CANDIDATE",
      routeReasonCodes: ["POSITIVE_NET_EVIDENCE"],
      expectedNetR: 0.2,
    });
    ledger.recordRouteAssigned({
      timestamp: ts,
      symbol: "BTCUSDT",
      direction: "LONG",
      routeMode: "PROFIT_CANDIDATE",
    });
    ledger.recordExitClosed({ timestamp: ts, symbol: "BTCUSDT", direction: "LONG" }, { realizedNetR: 0.4 });

    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const events = lines.map((line) => JSON.parse(line));
    expect(events.map((e) => e.event)).toEqual(["PLAN_SELECTED", "ROUTE_ASSIGNED", "EXIT_CLOSED"]);
    expect(existsSync(file)).toBe(true);
  });

  it("emits ROUTE_DUPLICATE_SUPPRESSED for repeats within the window without mutating prior entries", () => {
    const file = tempLedgerFile();
    const ledger = new DecisionLedger(file, { duplicateWindowMs: 60_000 });
    const base = {
      timestamp: "2026-05-11T12:00:00.000Z",
      symbol: "ETHUSDT",
      direction: "LONG" as const,
      routeMode: "PROFIT_CANDIDATE" as const,
      selectedExecutionPlan: { selectedEntryVariant: "base_current_entry", selectedExitVariant: "tp1_full_exit" } as any,
    };
    const first = ledger.recordRouteAssigned(base);
    const second = ledger.recordRouteAssigned({
      ...base,
      timestamp: "2026-05-11T12:00:30.000Z",
    });
    expect(first.logged).toBe(true);
    expect(second.duplicate).toBe(true);
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(["ROUTE_ASSIGNED", "ROUTE_DUPLICATE_SUPPRESSED"]);
  });

  it("does not poison the dedup cache when the durable append throws (fail-without/pass-with)", () => {
    const file = tempLedgerFile();
    const ledger = new DecisionLedger(file, { duplicateWindowMs: 60_000 });
    const base = {
      timestamp: "2026-05-11T12:00:00.000Z",
      symbol: "SOLUSDT",
      direction: "LONG" as const,
      routeMode: "PROFIT_CANDIDATE" as const,
    };

    const appendSpy = vi.spyOn(ledger, "append").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => ledger.recordRouteAssigned(base)).toThrow("disk full");
    appendSpy.mockRestore();

    // The first call's write failed, so the retry 30s later (well within the 60s window) is the
    // FIRST successful record of this decision, not a duplicate of a decision that was never persisted.
    const retry = ledger.recordRouteAssigned({ ...base, timestamp: "2026-05-11T12:00:30.000Z" });
    expect(retry.logged).toBe(true);
    expect(retry.duplicate).toBe(false);

    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event).toBe("ROUTE_ASSIGNED");
  });

  it("does not permanently misclassify calls as duplicates after a backward system-clock jump (fail-without/pass-with)", () => {
    const file = tempLedgerFile();
    const ledger = new DecisionLedger(file, { duplicateWindowMs: 3_600_000 });
    const base = {
      timestamp: "2026-05-11T12:00:00.000Z",
      symbol: "ADAUSDT",
      direction: "LONG" as const,
      routeMode: "PROFIT_CANDIDATE" as const,
    };

    const first = ledger.recordRouteAssigned(base);
    expect(first.logged).toBe(true);

    // Clock jumps backward by an hour (e.g. NTP correction) before the next genuine call.
    const afterClockJump = ledger.recordRouteAssigned({ ...base, timestamp: "2026-05-11T11:00:00.000Z" });
    expect(afterClockJump.duplicate).toBe(false);
    expect(afterClockJump.logged).toBe(true);

    // A further genuine call 90 minutes after the (corrected) backward-jump call — outside the 1h
    // window from that call, but only 30 minutes after the ORIGINAL pre-jump timestamp. A buggy
    // implementation that never updated "previous" on the backward-jump call would still compare
    // against the stale pre-jump timestamp and wrongly flag this as a duplicate.
    const followUp = ledger.recordRouteAssigned({ ...base, timestamp: "2026-05-11T12:30:00.000Z" });
    expect(followUp.duplicate).toBe(false);
    expect(followUp.logged).toBe(true);

    const events = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l).event);
    expect(events).toEqual(["ROUTE_ASSIGNED", "ROUTE_ASSIGNED", "ROUTE_ASSIGNED"]);
  });

  it("prunes route-dedup keys older than the duplicate window instead of growing unboundedly", () => {
    const file = tempLedgerFile();
    const duplicateWindowMs = 1_000;
    const ledger = new DecisionLedger(file, { duplicateWindowMs });
    const startMs = Date.parse("2026-05-11T12:00:00.000Z");

    // Each call uses a distinct symbol (distinct dedup key) and advances well past the 1s window,
    // so nothing should ever legitimately be treated as a duplicate, and old keys should be evicted.
    const SYMBOL_COUNT = 500;
    for (let i = 0; i < SYMBOL_COUNT; i += 1) {
      const ts = new Date(startMs + i * (duplicateWindowMs * 5)).toISOString();
      ledger.recordRouteAssigned({
        timestamp: ts,
        symbol: `SYM${i}USDT`,
        direction: "LONG",
        routeMode: "PROFIT_CANDIDATE",
      });
    }

    expect(ledger._getRouteKeyCacheSizeForTests()).toBeLessThan(SYMBOL_COUNT);
  });

  it("records reflection codes", () => {
    const file = tempLedgerFile();
    const ledger = new DecisionLedger(file);
    const codes = classifyReflection({
      symbol: "BTCUSDT",
      direction: "LONG",
      closeReason: "TP1_FULL",
      realizedNetR: 0.3,
      realizedGrossR: 0.5,
      filled: true,
      plan: null,
    });
    expect(codes).toContain("GOOD_TP1_CAPTURE");
    expect(codes).toContain("PROFITABLE_AFTER_COST");
    ledger.recordReflection(
      { timestamp: new Date().toISOString(), symbol: "BTCUSDT", direction: "LONG" },
      codes,
    );
    const last = readFileSync(file, "utf-8").trim().split("\n").pop()!;
    const event = JSON.parse(last);
    expect(event.event).toBe("REFLECTION_ADDED");
    expect(event.reflectionCodes).toEqual(codes);
  });

  it("classifies NO_FILL_RESEARCH when trade was not filled", () => {
    const codes = classifyReflection({
      symbol: "BTCUSDT",
      direction: "LONG",
      closeReason: "NO_FILL",
      realizedNetR: 0,
      realizedGrossR: 0,
      filled: false,
      plan: null,
    });
    expect(codes).toEqual(["NO_FILL_RESEARCH"]);
  });
});
