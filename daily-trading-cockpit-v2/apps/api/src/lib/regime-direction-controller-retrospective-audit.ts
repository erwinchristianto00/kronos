/**
 * REGIME DIRECTION CONTROLLER — RETROSPECTIVE DRY-RUN AUDIT (REPORT-ONLY)
 *
 * Replays the regime direction controller against historical closed positions to
 * measure whether controller-allowed trades outperform controller-blocked trades
 * in retrospect. This is purely informational — it does NOT influence live
 * behavior, route selection, readiness thresholds, or any other system.
 *
 * Pure module: no I/O, no side effects, deterministic for any given input.
 */

import type { ShadowPosition } from "@dtc/shared";

import {
  buildRegimeDirectionControllerReport,
  type RegimeDirectionMode,
} from "./regime-direction-controller.js";

// ─── Output interfaces ────────────────────────────────────────────────────────

export interface RetroAuditModeRow {
  controllerMode: string;
  n: number;
  allowedN: number;
  blockedN: number;
  unknownN: number;
  allowedNetAvgR: number | null;
  blockedNetAvgR: number | null;
  allowedPF: number | null;
  blockedPF: number | null;
  allowedWR: number | null;
  blockedWR: number | null;
}

export interface RetroAuditDirectionRow {
  controllerMode: string;
  direction: "LONG" | "SHORT";
  n: number;
  netAvgR: number | null;
  PF: number | null;
  WR: number | null;
}

export interface RetroAuditDecisionRow {
  decision: "ALLOWED" | "BLOCKED" | "UNKNOWN";
  n: number;
  netAvgR: number | null;
  PF: number | null;
  WR: number | null;
}

export interface RetroAuditReport {
  reportOnly: true;
  label: "RETROSPECTIVE — not prospective validation";
  totalClosed: number;
  withRegime: number;
  noRegime: number;
  byMode: RetroAuditModeRow[];
  byModeAndDirection: RetroAuditDirectionRow[];
  byDecision: RetroAuditDecisionRow[];
}

// ─── Internal types ───────────────────────────────────────────────────────────

type ControllerDecision = "ALLOWED" | "BLOCKED" | "UNKNOWN";

interface AuditEntry {
  mode: string;
  decision: ControllerDecision;
  direction: "LONG" | "SHORT";
  netR: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeNetAvgR(values: Array<number | null>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

/**
 * Profit Factor = sum(positive netR) / |sum(negative netR)|.
 * Returns null if no negative or no positive R entries.
 */
function computePF(values: Array<number | null>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const positiveSum = finite.filter((v) => v > 0).reduce((sum, v) => sum + v, 0);
  const negativeSum = finite.filter((v) => v < 0).reduce((sum, v) => sum + v, 0);
  if (negativeSum === 0 || positiveSum === 0) return null;
  return positiveSum / Math.abs(negativeSum);
}

/**
 * Win Rate = count(netR > 0) / total.
 * Returns null if n === 0.
 */
function computeWR(values: Array<number | null>): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.filter((v) => v > 0).length / finite.length;
}

/**
 * Determine whether the controller allows or blocks a given direction for the
 * given controller mode.
 *
 * Rules:
 * - LONG_ONLY  → allowed only if LONG
 * - SHORT_ONLY → allowed only if SHORT
 * - BOTH_ALLOWED → always allowed
 * - VALIDATION_ONLY → allowed (collection is permitted)
 * - NO_TRADE_CHOP / WAIT_RETEST_AFTER_DUMP / WAIT_RETEST_AFTER_PUMP → blocked
 * - UNKNOWN → unknown
 */
function decideControllerAllowed(
  mode: RegimeDirectionMode,
  direction: "LONG" | "SHORT",
): ControllerDecision {
  switch (mode) {
    case "LONG_ONLY":
      return direction === "LONG" ? "ALLOWED" : "BLOCKED";
    case "SHORT_ONLY":
      return direction === "SHORT" ? "ALLOWED" : "BLOCKED";
    case "BOTH_ALLOWED":
      return "ALLOWED";
    case "VALIDATION_ONLY":
      return "ALLOWED";
    case "NO_TRADE_CHOP":
    case "WAIT_RETEST_AFTER_DUMP":
    case "WAIT_RETEST_AFTER_PUMP":
      return "BLOCKED";
    case "UNKNOWN":
    default:
      return "UNKNOWN";
  }
}

function buildDecisionRows(entries: AuditEntry[]): RetroAuditDecisionRow[] {
  const decisions: ControllerDecision[] = ["ALLOWED", "BLOCKED", "UNKNOWN"];
  return decisions.map((decision) => {
    const subset = entries.filter((e) => e.decision === decision);
    const netRs = subset.map((e) => e.netR);
    return {
      decision,
      n: subset.length,
      netAvgR: computeNetAvgR(netRs),
      PF: computePF(netRs),
      WR: computeWR(netRs),
    };
  });
}

function buildModeRows(entries: AuditEntry[]): RetroAuditModeRow[] {
  const modeSet = new Set(entries.map((e) => e.mode));
  const rows: RetroAuditModeRow[] = [];

  for (const mode of modeSet) {
    const modeEntries = entries.filter((e) => e.mode === mode);
    const allowed = modeEntries.filter((e) => e.decision === "ALLOWED");
    const blocked = modeEntries.filter((e) => e.decision === "BLOCKED");
    const unknown = modeEntries.filter((e) => e.decision === "UNKNOWN");
    rows.push({
      controllerMode: mode,
      n: modeEntries.length,
      allowedN: allowed.length,
      blockedN: blocked.length,
      unknownN: unknown.length,
      allowedNetAvgR: computeNetAvgR(allowed.map((e) => e.netR)),
      blockedNetAvgR: computeNetAvgR(blocked.map((e) => e.netR)),
      allowedPF: computePF(allowed.map((e) => e.netR)),
      blockedPF: computePF(blocked.map((e) => e.netR)),
      allowedWR: computeWR(allowed.map((e) => e.netR)),
      blockedWR: computeWR(blocked.map((e) => e.netR)),
    });
  }

  // Sort deterministically
  rows.sort((a, b) => a.controllerMode.localeCompare(b.controllerMode));
  return rows;
}

function buildModeAndDirectionRows(entries: AuditEntry[]): RetroAuditDirectionRow[] {
  const keys = new Set(entries.map((e) => `${e.mode}|||${e.direction}`));
  const rows: RetroAuditDirectionRow[] = [];

  for (const key of keys) {
    const [mode, direction] = key.split("|||") as [string, "LONG" | "SHORT"];
    const subset = entries.filter((e) => e.mode === mode && e.direction === direction);
    const netRs = subset.map((e) => e.netR);
    rows.push({
      controllerMode: mode,
      direction,
      n: subset.length,
      netAvgR: computeNetAvgR(netRs),
      PF: computePF(netRs),
      WR: computeWR(netRs),
    });
  }

  rows.sort((a, b) =>
    a.controllerMode.localeCompare(b.controllerMode) ||
    a.direction.localeCompare(b.direction),
  );
  return rows;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Builds a retrospective audit report by replaying the regime direction
 * controller against all closed shadow positions.
 *
 * REPORT-ONLY: no I/O, no side effects, deterministic.
 */
export function buildRegimeDirectionControllerRetroAudit(
  positions: ShadowPosition[],
): RetroAuditReport {
  // Step 1: filter to closed positions only
  const closedStatuses = new Set(["CLOSED_WIN", "CLOSED_LOSS", "CLOSED_BREAKEVEN"]);
  const closedPositions = positions.filter((p) => closedStatuses.has(p.variants[0]?.closeReason === "NO_FILL" ? "NO_FILL" : (p.variants.every((v) => v.closeReason === "NO_FILL") ? "NO_FILL" : (p.variants.some((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL") ? "CLOSED" : "OPEN"))));

  // Cleaner approach: a position is "resolved" if at least one non-NO_FILL variant
  // is CLOSED. This mirrors CLOSED_WIN / CLOSED_LOSS / CLOSED_BREAKEVEN semantics.
  // We use a simple heuristic: if the position has any variant in CLOSED state
  // (not NO_FILL), it has a resolved outcome.
  const resolvedPositions = positions.filter((p) => {
    if (!Array.isArray(p.variants) || p.variants.length === 0) return false;
    return p.variants.some((v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL");
  });

  let withRegime = 0;
  let noRegime = 0;

  const entries: AuditEntry[] = [];

  for (const position of resolvedPositions) {
    // Use marketRegimeAtOpen, falling back to marketRegime for legacy positions
    const regime = (position.marketRegimeAtOpen ?? position.marketRegime) ?? null;

    if (regime == null || typeof regime !== "string" || regime.trim().length === 0) {
      noRegime += 1;
    } else {
      withRegime += 1;
    }

    // Always process (even null regime — controller handles it as UNKNOWN)
    const report = buildRegimeDirectionControllerReport({ currentRegime: regime });
    const mode = report.controllerMode;

    // Direction must be LONG or SHORT
    const direction: "LONG" | "SHORT" | null =
      position.direction === "LONG" ? "LONG"
      : position.direction === "SHORT" ? "SHORT"
      : null;
    if (direction === null) continue;

    const decision = decideControllerAllowed(mode, direction);

    // netR: use the best realized netR from variants or null
    // Prefer the primary variant (first non-NO_FILL CLOSED variant)
    const resolvedVariant = position.variants.find(
      (v) => v.state === "CLOSED" && v.closeReason !== "NO_FILL",
    );
    const netR =
      typeof resolvedVariant?.realizedNetR === "number" && Number.isFinite(resolvedVariant.realizedNetR)
        ? resolvedVariant.realizedNetR
        : null;

    entries.push({ mode, decision, direction, netR });
  }

  return {
    reportOnly: true,
    label: "RETROSPECTIVE — not prospective validation",
    totalClosed: resolvedPositions.length,
    withRegime,
    noRegime,
    byMode: buildModeRows(entries),
    byModeAndDirection: buildModeAndDirectionRows(entries),
    byDecision: buildDecisionRows(entries),
  };
}
