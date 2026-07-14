/**
 * Historical backfill — per-source adapters (bridges the heterogeneous real schemas → normalized records).
 * Field names come straight from the inventory audit. Each adapter is DEFENSIVE: a row missing a required
 * field returns null (counted as a parse-drop upstream), never a fabricated value. Feature observedAt is set
 * to the value's genuine as-of instant (a snapshot's capthuredAt, a position's openedAt) so the as-of gate is
 * meaningful. Pure.
 */
import {
  finiteOrNull,
  toMs,
  toSide,
  type AsOfFeature,
  type HistoricalDecision,
  type HistoricalOutcome,
  type SourceAdapter,
} from "./backfill-schema.js";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function get(raw: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), raw);
}

/** Encode a direction string to a signed feature: LONG +1, SHORT −1, FLAT/NEUTRAL 0. */
export function encodeDirection(v: unknown): number | null {
  const s = toSide(v);
  return s === "LONG" ? 1 : s === "SHORT" ? -1 : s === "FLAT" ? 0 : null;
}

/** Encode the market directional bias INCLUDING the real MIXED state (→0, a genuine neutral posture, distinct
 *  from a leak). UNKNOWN → null (genuinely unknown ⇒ the row is honestly MISSING_FEATURES, not fabricated). */
export function encodeBias(v: unknown): number | null {
  const s = (str(v) ?? "").toUpperCase();
  if (s === "LONG") return 1;
  if (s === "SHORT") return -1;
  if (s === "MIXED" || s === "NEUTRAL" || s === "FLAT") return 0;
  return null; // UNKNOWN / unrecognized
}

/** Encode the ordinal confidence label (the store records LOW/MEDIUM/HIGH, not a number). */
export function encodeConfidence(v: unknown): number | null {
  const s = (str(v) ?? "").toUpperCase();
  if (s === "LOW") return 0.33;
  if (s === "MEDIUM" || s === "MED") return 0.66;
  if (s === "HIGH") return 1.0;
  return finiteOrNull(v); // already numeric in some sources
}

/** XSEC basket frozen risk-at-open: mirrors the live `riskDistanceAtOpen ?? stopLossReturn ?? BASKET_STOP`
 *  chain (cross-sectional-edge.ts). The basket ALWAYS risks a fixed stop; that constant IS the real frozen
 *  denominator, not a fabricated one. Default 30 bps (the live default); env-overridable for fidelity. */
export const XSEC_BASKET_STOP_FRACTION = (Number(process.env.CROSS_SECTIONAL_BASKET_STOP_LOSS_BPS) || 30) / 10_000;

/** Map a raw regime string to a coarse family the CORTEX archetype logic uses. */
export function regimeFamily(raw: unknown): string {
  const s = (str(raw) ?? "").toUpperCase();
  if (/BULL|EXPANSION|TREND.*UP|RISK.?ON/.test(s)) return "TREND";
  if (/BEAR|BREAK.?DOWN|RISK.?OFF|CAPITULAT/.test(s)) return "BREADTH";
  if (/NEUTRAL|CHOP|RANGE|MIXED|RECOVERY/.test(s)) return "NEUTRAL";
  return s || "UNKNOWN";
}

const BPS_TO_FRACTION = 1 / 10_000;

// ── paper-execution-router.json → OUTCOME (native-R) ──────────────────────────────────────────────
export const paperExecutionAdapter: SourceAdapter = {
  sourceId: "paper-execution-router",
  schemaVersion: 1,
  toOutcome(raw): HistoricalOutcome | null {
    const outcomeId = str(raw.paperOrderId) ?? str(raw.dedupeKey);
    const openedAtMs = toMs(raw.openedAt) ?? toMs(raw.createdAt);
    const resolvedAtMs = toMs(raw.closedAt) ?? toMs(raw.updatedAt);
    const netR = finiteOrNull(raw.netR);
    // Only RESOLVED positions are outcomes; an open row has no label yet.
    if (!outcomeId || openedAtMs == null || resolvedAtMs == null || netR == null) return null;
    const stopBps = finiteOrNull(raw.plannedStopDistanceBps) ?? finiteOrNull(get(raw, "provenance.stopDistanceBpsFromPlan"));
    return {
      sourceId: this.sourceId,
      schemaVersion: this.schemaVersion,
      outcomeId,
      laneId: str(raw.laneId) ?? str(raw.variant) ?? str(raw.strategy) ?? "PAPER",
      symbolOrBasket: str(raw.symbol),
      side: toSide(raw.direction),
      openedAtMs,
      resolvedAtMs,
      netR,
      grossR: finiteOrNull(raw.grossR),
      costR: finiteOrNull(raw.costR) ?? finiteOrNull(get(raw, "provenance.costR")),
      riskDistanceAtOpen: stopBps != null && stopBps > 0 ? stopBps * BPS_TO_FRACTION : null,
      riskDenominatorSource: stopBps != null && stopBps > 0 ? "RECORDED_AT_OPEN" : null, // native-R anyway
      exitReason: str(raw.closeReason) ?? str(raw.paperStatus),
    };
  },
};

// ── cross-sectional-edge.json (XSEC) → OUTCOME (return-based, frozen riskDistanceAtOpen) ───────────
export const xsecAdapter: SourceAdapter = {
  sourceId: "cross-sectional-edge",
  schemaVersion: 1,
  toOutcome(raw): HistoricalOutcome | null {
    const outcomeId = str(raw.observationId);
    const openedAtMs = finiteOrNull(raw.openedAtMs) ?? toMs(raw.openedAt);
    const resolvedAtMs = toMs(raw.resolvedAt);
    if (!outcomeId || openedAtMs == null || resolvedAtMs == null) return null;
    // XSEC stores per-basket RETURNS (grossReturn/costReturn). The frozen riskDistanceAtOpen is often absent on
    // closed rows; the live code falls back to the fixed basket stop, which IS the real frozen denominator.
    // Route the return components through the outcome module so netR = (gross−cost) ÷ risk under the strict
    // denominator guard — never treat a raw return as R.
    const recordedRisk = finiteOrNull(raw.riskDistanceAtOpen) ?? finiteOrNull(raw.stopLossReturn);
    const risk = recordedRisk ?? XSEC_BASKET_STOP_FRACTION;
    return {
      sourceId: this.sourceId,
      schemaVersion: this.schemaVersion,
      outcomeId,
      laneId: str(raw.variant) ?? str(raw.signal) ?? str(get(raw, "signal.variant")) ?? "XSEC_BASKET",
      symbolOrBasket: str(raw.basketId) ?? null,
      side: null, // market-neutral basket
      openedAtMs,
      resolvedAtMs,
      netR: null,
      grossR: finiteOrNull(raw.grossReturn) ?? finiteOrNull(raw.netReturn),
      costR: finiteOrNull(raw.grossReturn) != null ? finiteOrNull(raw.costReturn) : 0, // netReturn already nets cost
      riskDistanceAtOpen: risk != null && risk > 0 ? risk : null,
      // A recorded per-row risk ⇒ RECORDED_AT_OPEN; the basket-stop fallback ⇒ GLOBAL_CONSTANT_ASSUMED (we could
      // not prove 30bps was the trade's stop at open — replay/sensitivity-valid, not auto training-gold).
      riskDenominatorSource: recordedRisk != null ? "RECORDED_AT_OPEN" : "GLOBAL_CONSTANT_ASSUMED",
      exitReason: str(raw.exitReason) ?? str(raw.status),
    };
  },
};

// ── kronos-counterfactual-observations.json → OUTCOME (Exit-side resolver state) ──────────────────
export const kronosCounterfactualAdapter: SourceAdapter = {
  sourceId: "kronos-counterfactual-observations",
  schemaVersion: 1,
  toOutcome(raw): HistoricalOutcome | null {
    const outcomeId = str(raw.observationId);
    const openedAtMs = toMs(get(raw, "resolverState.openedAt")) ?? toMs(get(raw, "outcome.openedAt"));
    const resolvedAtMs = toMs(get(raw, "outcome.closedAt")) ?? toMs(get(raw, "resolverState.lastEvaluatedAt"));
    if (!outcomeId || openedAtMs == null || resolvedAtMs == null) return null;
    const stopBps = finiteOrNull(get(raw, "snapshot.stopDistanceBps"));
    // realizedGrossR and snapshot.costR are ALREADY in R-units (kronos-counterfactual-lane.ts:
    // realizedNetR = gross − costR, all in R). So emit netR NATIVELY (gross − cost) — do NOT route R values
    // through the return-based ÷riskDistanceAtOpen division (that inflated netR ~333×, poisoning every label).
    const grossRR = finiteOrNull(get(raw, "resolverState.realizedGrossR"));
    const costRR = finiteOrNull(get(raw, "snapshot.costR"));
    const netRR = grossRR != null ? grossRR - (costRR ?? 0) : null;
    return {
      sourceId: this.sourceId,
      schemaVersion: this.schemaVersion,
      outcomeId,
      laneId: str(raw.lane) ?? "KRONOS_CF",
      symbolOrBasket: str(get(raw, "snapshot.symbol")),
      side: toSide(get(raw, "snapshot.direction")),
      openedAtMs,
      resolvedAtMs,
      netR: netRR, // NATIVE R (gross − cost), already risk-normalized upstream
      grossR: grossRR,
      costR: costRR,
      riskDistanceAtOpen: stopBps != null && stopBps > 0 ? stopBps * BPS_TO_FRACTION : null,
      riskDenominatorSource: stopBps != null && stopBps > 0 ? "RECORDED_AT_OPEN" : null,
      tp1Hit: typeof get(raw, "resolverState.tp1Hit") === "boolean" ? (get(raw, "resolverState.tp1Hit") as boolean) : null,
      tp2Hit: typeof get(raw, "resolverState.tp2Hit") === "boolean" ? (get(raw, "resolverState.tp2Hit") as boolean) : null,
      slToBreakeven: typeof get(raw, "resolverState.slMovedToBreakeven") === "boolean" ? (get(raw, "resolverState.slMovedToBreakeven") as boolean) : null,
      exitReason: str(get(raw, "snapshot.finalStatusObserved")) ?? str(raw.observationStatus),
    };
  },
};

// ── regime-direction-controller-snapshots.jsonl → DECISION (market-state / direction) ─────────────
export const regimeSnapshotAdapter: SourceAdapter = {
  sourceId: "regime-direction-controller-snapshots",
  schemaVersion: 1,
  toDecision(raw): HistoricalDecision | null {
    const atMs = toMs(raw.capturedAt);
    if (atMs == null) return null;
    const bias = toSide(raw.directionalBias);
    const feat = (key: string, value: number | null): AsOfFeature => ({ key, value, observedAtMs: atMs });
    const cu = (str(raw.confidence) ?? "").toUpperCase();
    const isMed = cu === "MEDIUM" || cu === "MED";
    return {
      sourceId: this.sourceId,
      schemaVersion: this.schemaVersion,
      decisionId: `regime:${atMs}`,
      atMs,
      laneId: "MARKET", // market-wide direction decision stream
      symbolOrBasket: null,
      side: bias,
      regimeFamily: regimeFamily(raw.currentRegime),
      eligible: raw.allowsNewEntries !== false,
      // Confidence is emitted BOTH as ONE-HOT (the default — no ordinal-spacing assumption) AND ordinal
      // (`confidence_ord`, for the sensitivity comparison). One-hot columns are always 0/1 (never null), so an
      // unknown level is its OWN column rather than a forced number.
      features: [
        feat("directionalBias", encodeBias(raw.directionalBias)),
        feat("allowsLong", raw.allowsLong === true ? 1 : raw.allowsLong === false ? 0 : null),
        feat("allowsShort", raw.allowsShort === true ? 1 : raw.allowsShort === false ? 0 : null),
        feat("confidence_ord", encodeConfidence(raw.confidence)),
        feat("confidence_LOW", cu === "LOW" ? 1 : 0),
        feat("confidence_MEDIUM", isMed ? 1 : 0),
        feat("confidence_HIGH", cu === "HIGH" ? 1 : 0),
        feat("confidence_UNKNOWN", cu === "LOW" || isMed || cu === "HIGH" ? 0 : 1),
      ],
      directionAction: bias === "LONG" ? "LONG" : bias === "SHORT" ? "SHORT" : "FLAT",
      entryAction: raw.allowsNewEntries === false ? "SKIP" : raw.requiresRetest === true ? "WAIT" : "ENTER_NOW",
    };
  },
};

export const BACKFILL_OUTCOME_ADAPTERS: SourceAdapter[] = [paperExecutionAdapter, xsecAdapter, kronosCounterfactualAdapter];
export const BACKFILL_DECISION_ADAPTERS: SourceAdapter[] = [regimeSnapshotAdapter];
