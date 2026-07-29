import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { CortexDecisionJournal } from "../src/lib/cortex-brain-store.js";
import { buildExecutiveDecision } from "../src/lib/executive-decision.js";
import { buildExecutiveDecisionRecord, readExecutiveDecisionRows } from "../src/lib/four-brain-journal.js";
import { decideMarketState } from "../src/lib/market-state-brain.js";
import { decideDirection } from "../src/lib/direction-brain.js";
import { decideEntry } from "../src/lib/entry-brain.js";
import { marketInput, directionInput, entryInput, src, NOW } from "./four-brain-fixtures.js";
import { CORTEX_ALLOW_FOUR_BRAIN_FEATURES, staticAllocationContext, unavailableMarketContext } from "../src/lib/authority-contract.js";

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib");
const FOUR_BRAIN_FILES = [
  "four-brain-types.ts",
  "four-brain-invariants.ts",
  "four-brain-journal.ts",
  "market-state-brain.ts",
  "direction-brain.ts",
  "entry-brain.ts",
  "exit-brain.ts",
  "executive-decision.ts",
  // Phase 2 — the impure gather is DI (takes live data as deps, imports no executor); the tick + gather
  // core import only pure brains + the report journal. Same boundary applies.
  "four-brain-live-gather.ts",
  "four-brain-live-gather-bindings.ts",
  "four-brain-shadow-tick.ts",
  "four-brain-lane-support.ts",
  "four-brain-metrics.ts",
  "four-brain-replay-harness.ts",
  "four-brain-live-wiring.ts",
  "authority-contract.ts",
  "executive-review-store.ts",
  "four-brain-economic-experience.ts",
  "four-brain-shadow-learning-report.ts",
];

// Modules that place orders / mutate positions / mutate stops / set allocations. NO brain may import these.
const FORBIDDEN_IMPORT_SUBSTRINGS = [
  "live-execution-engine",
  "binance-futures-private",
  "cross-sectional-executor",
  "single-symbol-lane-executor",
  "paper-execution-router",
  "live-executor-wiring",
  "realtime-short-mirror",
  "./binance.js",
  "/binance.js",
];
// Call-sites that would mutate live state — must not appear in any brain source.
const FORBIDDEN_CALL_SUBSTRINGS = ["setAllocations(", "placeOrder(", "placeAlgoOrder(", "closePosition(", "submitOrder(", "cancelOrder(", "engageKillSwitch("];
const CORTEX_AUTHORITY_FILES = ["cortex-brain.ts", "cortex-brain-store.ts", "cortex-decision-snapshot.ts"];

function importLines(src: string): string[] {
  return src.split("\n").filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+["']/.test(l));
}

describe("Four-Brain architecture boundary (report-only proof)", () => {
  it("all four-brain source files exist", () => {
    for (const f of FOUR_BRAIN_FILES) expect(existsSync(join(LIB, f)), `${f} missing`).toBe(true);
  });

  it("no brain imports an execution / order-placement / position-mutation module", () => {
    for (const f of FOUR_BRAIN_FILES) {
      const text = readFileSync(join(LIB, f), "utf-8");
      const imports = importLines(text).join("\n");
      for (const bad of FORBIDDEN_IMPORT_SUBSTRINGS) {
        expect(imports.includes(bad), `${f} imports forbidden module "${bad}"`).toBe(false);
      }
    }
  });

  it("no brain source contains a live-mutation call site (setAllocations / order placement / kill)", () => {
    for (const f of FOUR_BRAIN_FILES) {
      const text = readFileSync(join(LIB, f), "utf-8");
      for (const bad of FORBIDDEN_CALL_SUBSTRINGS) {
        expect(text.includes(bad), `${f} contains forbidden call "${bad}"`).toBe(false);
      }
    }
  });

  it("the journal only reuses the append-only CortexDecisionJournal (a store), never an executor", () => {
    const text = readFileSync(join(LIB, "four-brain-journal.ts"), "utf-8");
    expect(text.includes("cortex-brain-store")).toBe(true); // reuse, not re-implement
    for (const bad of FORBIDDEN_IMPORT_SUBSTRINGS) expect(text.includes(bad)).toBe(false);
  });

  it("keeps Four-Brain outside CORTEX features and removes synthetic CORTEX lineage", () => {
    const cortex = readFileSync(join(LIB, "cortex-brain.ts"), "utf-8");
    const fourBrainSources = FOUR_BRAIN_FILES.map((f) => readFileSync(join(LIB, f), "utf-8")).join("\n");
    expect(CORTEX_ALLOW_FOUR_BRAIN_FEATURES).toBe(false);
    expect(cortex).not.toContain("fourBrain");
    expect(fourBrainSources).not.toContain("four-brain:${");
  });

  it("keeps CORTEX as an allocator without exchange or order authority", () => {
    for (const file of CORTEX_AUTHORITY_FILES) {
      const text = readFileSync(join(LIB, file), "utf-8");
      const imports = importLines(text).join("\n");
      for (const bad of FORBIDDEN_IMPORT_SUBSTRINGS) expect(imports.includes(bad), `${file} imports ${bad}`).toBe(false);
      for (const bad of FORBIDDEN_CALL_SUBSTRINGS) expect(text.includes(bad), `${file} contains ${bad}`).toBe(false);
    }
  });

  it("makes allocation context read-only telemetry, never a review approval gate", () => {
    const shared = {
      nowMs: NOW, marketState: decideMarketState(marketInput()), direction: decideDirection(directionInput({ longEdge: src(0.1) })),
      entry: decideEntry(entryInput()), exit: null, laneId: "RC", symbolOrBasketId: "BTCUSDT", laneEligibleIncumbent: true,
      marketContext: unavailableMarketContext(NOW),
    } as const;
    expect(buildExecutiveDecision({ ...shared, allocationContext: staticAllocationContext(40) }).candidateStatus).toBe("VALID");
    const unavailable = buildExecutiveDecision({ ...shared, allocationContext: staticAllocationContext(null) });
    expect(unavailable.candidateStatus).toBe("VALID");
    expect(unavailable.advisoryOnly).toBe(true);
  });
});

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "four-brain-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Four-Brain journal — append-only, malformed-tolerant, deduped", () => {
  it("round-trips an executive record; tolerates a malformed line; dedupes by decisionId", () => {
    const file = join(tmp(), "exec.jsonl");
    const j = new CortexDecisionJournal(file);
    const exec = buildExecutiveDecision({
      nowMs: NOW, marketState: decideMarketState(marketInput()), direction: decideDirection(directionInput({ longEdge: src(0.1) })),
      entry: decideEntry(entryInput()), exit: null, laneId: "RC", symbolOrBasketId: "BTCUSDT", laneEligibleIncumbent: true,
      allocationContext: staticAllocationContext(40), marketContext: unavailableMarketContext(NOW),
    });
    const rec = buildExecutiveDecisionRecord(exec, {
      horizon: "INTRADAY",
      signalId: "signal-1",
      incumbent: { note: "incumbent baseline" },
    });
    j.append(rec);
    j.append(rec); // duplicate id — must dedupe on read
    appendFileSync(file, '{"kind":"EXECUTIVE_DECISION","decisionIds":{bad json\n', "utf-8"); // malformed line
    const { rows, badLines } = readExecutiveDecisionRows([file]);
    expect(rows).toHaveLength(1); // deduped
    expect(badLines).toBe(1); // malformed line counted, not fatal
    expect(rows[0]!.candidateStatus).toBe("VALID");
    expect(rows[0]!.wouldAct).toBe(true);
    expect(rows[0]!.raw.reportOnly).toBe(true);
    expect(rows[0]!.raw.signalId).toBe("signal-1");
  });
});
