import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  ProfitRouteMode,
  ProfitRouteReasonCode,
  ReflectionCode,
  VariantSelectionSnapshot,
} from "@dtc/shared";

import { rotateJsonlIfNeeded } from "./jsonl-rotation.js";

export type DecisionLedgerEventType =
  | "PLAN_SELECTED"
  | "ROUTE_ASSIGNED"
  | "ENTRY_PENDING"
  | "ENTRY_FILLED"
  | "EXIT_CLOSED"
  | "ROUTE_DUPLICATE_SUPPRESSED"
  | "REFLECTION_ADDED";

export interface DecisionLedgerBase {
  timestamp: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  candidateId?: string | null;
  ideaId?: string | null;
  selectedExecutionPlan?: VariantSelectionSnapshot | null;
  routeMode?: ProfitRouteMode | null;
  routeReasonCodes?: ProfitRouteReasonCode[];
  expectedNetR?: number | null;
  expectedGrossR?: number | null;
  costR?: number | null;
  stopDistanceBps?: number | null;
  kronosBias?: string | null;
  kronosHorizonConflict?: boolean | null;
  /** Exact live scanner source-conflict flag (scan.ts::hasSourceConflict). Kronos LONG+Whale BEARISH or Kronos SHORT+Whale BULLISH. Distinct from analytics proxy. */
  liveSourceConflict?: boolean | null;
  whaleAgreement?: "AGREES" | "DISAGREES" | "UNAVAILABLE" | null;
  shadowStatus?: string | null;
}

export interface DecisionLedgerEntry extends DecisionLedgerBase {
  event: DecisionLedgerEventType;
  reflectionCodes?: ReflectionCode[];
  details?: Record<string, unknown>;
}

export class DecisionLedger {
  private readonly file: string;
  private readonly recentRouteKeys = new Map<string, number>();
  private readonly duplicateWindowMs: number;

  constructor(file: string, options?: { duplicateWindowMs?: number }) {
    this.file = resolve(file);
    this.duplicateWindowMs = options?.duplicateWindowMs ?? 60 * 60 * 1000;
    mkdirSync(dirname(this.file), { recursive: true });
  }

  get path(): string {
    return this.file;
  }

  append(entry: DecisionLedgerEntry): void {
    appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf-8");
    this.maybeRotate();
  }

  /** Append-only JSONL with no prior cap; reuses the rotation helper already applied to other unbounded logs this session. */
  private maybeRotate(): void {
    if (process.env.DECISION_LEDGER_ROTATION_DISABLED === "1") return;
    try {
      const thresholdBytes = Number(process.env.DECISION_LEDGER_ROTATION_THRESHOLD_BYTES) || 25 * 1024 * 1024;
      const tailLines = Number(process.env.DECISION_LEDGER_ROTATION_TAIL_LINES) || 10_000;
      const tailBytes = Number(process.env.DECISION_LEDGER_ROTATION_TAIL_BYTES) || 8 * 1024 * 1024;
      const result = rotateJsonlIfNeeded(this.file, { thresholdBytes, tailLines, tailBytes });
      if (result.rotated) {
        console.warn(
          `[decision-ledger] rotated ${this.file}: archived ${result.fromSize ?? "?"} bytes → ${result.archivePath ?? "?"}; kept ${result.linesKept ?? 0} lines`,
        );
      }
    } catch {
      // rotation failure must never block persistence
    }
  }

  recordRouteAssigned(base: DecisionLedgerBase): { logged: boolean; duplicate: boolean } {
    const key = `${base.symbol}|${base.direction}|${base.routeMode ?? ""}|${base.selectedExecutionPlan?.selectedEntryVariant ?? ""}|${base.selectedExecutionPlan?.selectedExitVariant ?? ""}`;
    const now = Date.parse(base.timestamp);
    const previous = this.recentRouteKeys.get(key);
    if (previous && Number.isFinite(now) && now - previous < this.duplicateWindowMs) {
      this.append({ ...base, event: "ROUTE_DUPLICATE_SUPPRESSED" });
      return { logged: false, duplicate: true };
    }
    this.recentRouteKeys.set(key, Number.isFinite(now) ? now : Date.now());
    this.append({ ...base, event: "ROUTE_ASSIGNED" });
    return { logged: true, duplicate: false };
  }

  recordPlanSelected(base: DecisionLedgerBase): void {
    this.append({ ...base, event: "PLAN_SELECTED" });
  }

  recordEntryPending(base: DecisionLedgerBase): void {
    this.append({ ...base, event: "ENTRY_PENDING" });
  }

  recordEntryFilled(base: DecisionLedgerBase): void {
    this.append({ ...base, event: "ENTRY_FILLED" });
  }

  recordExitClosed(base: DecisionLedgerBase, details?: Record<string, unknown>): void {
    this.append({ ...base, event: "EXIT_CLOSED", details });
  }

  recordReflection(base: DecisionLedgerBase, codes: ReflectionCode[], details?: Record<string, unknown>): void {
    this.append({ ...base, event: "REFLECTION_ADDED", reflectionCodes: codes, details });
  }
}

let singleton: DecisionLedger | null = null;
export function getDecisionLedger(file = "data/decision-log.jsonl"): DecisionLedger {
  if (!singleton || singleton.path !== resolve(file)) {
    singleton = new DecisionLedger(file);
  }
  return singleton;
}

export function _resetDecisionLedgerForTests(): void {
  singleton = null;
}
