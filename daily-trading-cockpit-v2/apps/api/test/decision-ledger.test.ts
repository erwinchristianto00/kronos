import { describe, expect, it } from "vitest";
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
