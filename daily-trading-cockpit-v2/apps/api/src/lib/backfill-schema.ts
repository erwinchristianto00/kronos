/**
 * Historical backfill — normalized schema (Phase 2 foundation). Every stored source has a DIFFERENT field
 * layout (costR↔costReturn↔feeSlippageR; stopDistanceBps↔riskDistanceAtOpen; openedAt/resolvedAt↔createdAt/
 * closedAt↔timestamp — see the inventory audit). A per-source adapter maps a RAW row into ONE of these
 * normalized records so the rest of the pipeline (as-of reconstruction, attribution, outcome, classification,
 * datasets) is schema-agnostic. NOTHING here fabricates a missing field — an absent value is `null`, and the
 * source it came from is always tagged so `SCHEMA_MISMATCH` / `MISSING_FEATURES` can be reported honestly.
 *
 * This whole pipeline is OFFLINE + report-only: it never imports an executor, never mutates live state, and
 * its outputs are datasets + candidate artifacts, not decisions.
 */

export type Side = "LONG" | "SHORT" | "FLAT";

/** Where the risk denominator came from. A GLOBAL_CONSTANT_ASSUMED value is a config default we could not
 *  prove was in effect at the trade's open — replay/sensitivity-valid, NOT automatically a gold training label. */
export type RiskDenominatorSource = "RECORDED_AT_OPEN" | "VERSIONED_CONFIG_AT_OPEN" | "GLOBAL_CONSTANT_ASSUMED";

/** One feature value with the time it FIRST became knowable — the anti-look-ahead primitive. A feature whose
 *  observedAt/firstSeenAt is after the decision instant must be rejected (never used to explain that decision). */
export interface AsOfFeature {
  key: string;
  value: number | null;
  /** The earliest instant this value was knowable. null ⇒ unknown provenance ⇒ treated as UNSAFE (rejected). */
  observedAtMs: number | null;
}

/** A normalized decision tick (what some engine decided at a point in time), reduced to what learning needs. */
export interface HistoricalDecision {
  sourceId: string;
  schemaVersion: number;
  decisionId: string;
  atMs: number;
  laneId: string;
  symbolOrBasket: string | null;
  side: Side | null;
  regimeFamily: string;
  eligible: boolean;
  /** Raw as-of features (each carrying its own observedAt); reconstruction filters these against atMs. */
  features: AsOfFeature[];
  /** Optional brain-native decision labels this tick recorded (used only for the decision-side datasets). */
  directionAction?: "LONG" | "SHORT" | "FLAT" | null;
  entryAction?: "ENTER_NOW" | "WAIT" | "SKIP" | null;
}

/** A normalized resolved outcome (a counterfactual/paper close — NEVER a live fill). netR may be given
 *  directly OR derived from grossR/costR ÷ riskDistanceAtOpen downstream. */
export interface HistoricalOutcome {
  sourceId: string;
  schemaVersion: number;
  outcomeId: string;
  laneId: string;
  symbolOrBasket: string | null;
  side: Side | null;
  openedAtMs: number;
  resolvedAtMs: number;
  /** netR after cost if the source stores it natively (XSEC etc.); else null → compute from the raw fields. */
  netR: number | null;
  grossR: number | null;
  /** Cost in R (fee+slippage) if present; null ⇒ unknown (cannot compute netR from grossR). */
  costR: number | null;
  /** Frozen risk denominator at open (canonical: XSEC riskDistanceAtOpen). Non-finite/≤0 ⇒ reject. */
  riskDistanceAtOpen: number | null;
  /** Provenance of the risk denominator — so an ASSUMED global constant is never silently treated as a
   *  recorded-at-open value. GLOBAL_CONSTANT_ASSUMED rows are replay/sensitivity-valid, NOT training-gold. */
  riskDenominatorSource?: RiskDenominatorSource | null;
  /** Exit-path facts if the source recorded them (kronos/aligned-shadow resolver state). null ⇒ unavailable. */
  tp1Hit?: boolean | null;
  tp2Hit?: boolean | null;
  slToBreakeven?: boolean | null;
  /** MFE/MAE in R — historically almost always UNAVAILABLE (see audit); null ⇒ unsupported, never fabricated. */
  mfeR?: number | null;
  maeR?: number | null;
  exitReason?: string | null;
}

/** The training-eligibility verdict for one historical observation (requirement #5). */
export type TrainingClass =
  | "VALID_FOR_TRAINING"
  | "VALID_FOR_REPLAY_ONLY"
  | "MISSING_FEATURES"
  | "LABEL_UNSAFE"
  | "SCHEMA_MISMATCH";

/** A source adapter: turns raw rows from ONE store into normalized decisions and/or outcomes. Pure. */
export interface SourceAdapter {
  sourceId: string;
  schemaVersion: number;
  toDecision?(raw: Record<string, unknown>): HistoricalDecision | null;
  toOutcome?(raw: Record<string, unknown>): HistoricalOutcome | null;
}

/** Coerce anything into a finite number or null (no fabrication of 0). */
export function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parse an ISO string or epoch (s/ms) into epoch-ms, or null. No Date.now — pure. */
export function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Normalize a raw side/direction string. */
export function toSide(v: unknown): Side | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  if (s === "LONG" || s === "BUY") return "LONG";
  if (s === "SHORT" || s === "SELL") return "SHORT";
  if (s === "FLAT" || s === "NEUTRAL" || s === "NONE") return "FLAT";
  return null;
}
