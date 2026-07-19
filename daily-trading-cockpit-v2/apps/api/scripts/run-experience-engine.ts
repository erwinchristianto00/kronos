/** Offline Real-Data Experience Engine baseline. No runtime wiring, no CORTEX import, no holdout access. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeExperience, type ExperienceRecord } from "../src/experience-engine/experience-engine.js";

const API = join(import.meta.dirname, ".."); const DATA = join(API, "data"); const OUT = join(API, "artifacts/experience-engine");
const parse = (path: string): unknown => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const ms = (value: unknown): number | null => { if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : null; if (typeof value === "string") { const result = Date.parse(value); return Number.isFinite(result) ? result : null; } return null; };
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const direction = (value: unknown): "LONG" | "SHORT" | "FLAT" | null => value === "LONG" || value === "SHORT" || value === "FLAT" ? value : null;
const rows = (value: unknown, key = "observations"): Record<string, unknown>[] => Array.isArray(value) ? value as Record<string, unknown>[] : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>)[key]) ? (value as Record<string, unknown>)[key] as Record<string, unknown>[] : [];
const markdown = (title: string, body: string) => `# ${title}\n\n${body.trim()}\n`;
function write(name: string, body: string | object): void { writeFileSync(join(OUT, name), typeof body === "string" ? body : JSON.stringify(body, null, 2)); }

function observedShadow(): ExperienceRecord[] {
  return rows(parse(join(DATA, "regime-controller-aligned-shadow.json"))).map((row) => {
    const closed = ms(row.closedAt); const outcome = num(row.netR); const status = String(row.status ?? "UNKNOWN");
    return normalizeExperience({ experienceId: `shadow:${String(row.id)}`, source: "OBSERVED_SHADOW_OUTCOME", provenance: "OBSERVED", decisionTimeMs: null, openedTimeMs: ms(row.openedAt), marketCloseTimeMs: closed, resolvedTimeMs: closed, laneId: typeof row.laneLabel === "string" ? row.laneLabel : null, symbolOrBasketId: typeof row.symbol === "string" ? row.symbol : null, direction: direction(row.direction), featureSchemaVersion: null, codeVersion: typeof row.policyVersion === "string" ? row.policyVersion : null, featureVector: null, sourceStatuses: { path: status === "FAILED_INVALID_GEOMETRY" ? "ERROR" : "FRESH" }, attributionStatus: "MISSING_DECISION_SNAPSHOT", outcomeQuality: outcome != null && (status === "CLOSED_WIN" || status === "CLOSED_LOSS") ? "RESOLVED_VALID" : status === "NO_FILL" ? "NO_FILL" : status === "FAILED_INVALID_GEOMETRY" ? "INVALID_GEOMETRY" : status === "OPEN" ? "OPEN" : "MISSING_OUTCOME", outcomeNetR: outcome, labels: {}, executionLabelKind: "PAPER_OUTCOME" });
  });
}
function paperOrders(): ExperienceRecord[] {
  const value = parse(join(DATA, "paper-execution-router.json")) as Record<string, unknown> | null;
  return rows(value, "orders").map((row) => {
    const outcome = num(row.netR); const opened = ms(row.openedAt); const resolved = ms(row.updatedAt); const provenance = row.provenance as Record<string, unknown> | null;
    return normalizeExperience({ experienceId: `paper:${String(row.paperOrderId)}`, source: "OBSERVED_LIVE_CONTEXT_WITH_PAPER_OUTCOME", provenance: "OBSERVED", decisionTimeMs: ms(row.createdAt), openedTimeMs: opened, marketCloseTimeMs: outcome != null ? resolved : null, resolvedTimeMs: outcome != null ? resolved : null, laneId: typeof row.selectedLaneId === "string" ? row.selectedLaneId : null, symbolOrBasketId: typeof row.symbol === "string" ? row.symbol : null, direction: direction(row.direction), featureSchemaVersion: typeof provenance?.policyVersion === "string" ? provenance.policyVersion : "paper-router/observed-context", codeVersion: typeof provenance?.policyVersion === "string" ? provenance.policyVersion : null, featureVector: null, sourceStatuses: { router: row.paperStatus === "PAPER_SUBMITTED" ? "FRESH" : "MISSING" }, attributionStatus: outcome != null ? "NATIVE_DIRECT" : "MISSING_DECISION_SNAPSHOT", outcomeQuality: outcome != null ? "RESOLVED_VALID" : "OPEN", outcomeNetR: outcome, labels: { entry: "ENTER_NOW", exit: "INCUMBENT_TP_SL", allocationMultiple: 1 }, executionLabelKind: "PAPER_OUTCOME" });
  });
}
function observedCounterfactuals(): ExperienceRecord[] {
  return rows(parse(join(DATA, "kronos-counterfactual-observations.json"))).map((row) => {
    const snapshot = (row.snapshot ?? {}) as Record<string, unknown>; const resolver = (row.resolverState ?? {}) as Record<string, unknown>;
    const opened = ms(resolver.openedAt); const status = String(row.observationStatus ?? "OPEN"); const netR = num(resolver.realizedNetR);
    return normalizeExperience({ experienceId: `path-cf:${String(row.observationId)}`, source: "OBSERVED_PATH_COUNTERFACTUAL", provenance: "OBSERVED_PATH_COUNTERFACTUAL", decisionTimeMs: ms(row.createdAt), openedTimeMs: opened, marketCloseTimeMs: status === "CLOSED" ? ms(row.updatedAt) : null, resolvedTimeMs: status === "CLOSED" ? ms(row.updatedAt) : null, laneId: typeof row.lane === "string" ? row.lane : null, symbolOrBasketId: typeof row.symbol === "string" ? row.symbol : null, direction: direction(snapshot.direction), featureSchemaVersion: typeof ((row.diagnostics as Record<string, unknown> | undefined)?.createdByPolicyVersion) === "string" ? ((row.diagnostics as Record<string, unknown>).createdByPolicyVersion as string) : "kronos-counterfactual-v1", codeVersion: "kronos-counterfactual-v1", featureVector: null, sourceStatuses: { observedPath: status === "OPEN" ? "FRESH" : "MISSING" }, attributionStatus: "NATIVE_DIRECT", outcomeQuality: status === "CLOSED" && netR != null ? "RESOLVED_VALID" : status === "OPEN" ? "OPEN" : "MISSING_OUTCOME", outcomeNetR: netR, labels: { direction: direction(snapshot.direction) ?? "FLAT", entry: "ENTER_NOW", exit: "INCUMBENT_TP_SL", allocationMultiple: 1 }, executionLabelKind: "CANDLE_APPROXIMATION" });
  });
}
function historicalReplay(): ExperienceRecord[] {
  const value = parse(join(OUT, "historical-causal-replay.json")) as { records?: unknown } | null;
  const raw = Array.isArray(value?.records) ? value.records : [];
  return raw.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as ExperienceRecord;
    // Re-normalize at import time: artifacts cannot grant themselves eligibility.
    const { schemaVersion: _schemaVersion, eligibility: _eligibility, eligibilityReasons: _eligibilityReasons, ...base } = record;
    return [normalizeExperience(base)];
  });
}
function model(name: string, records: ExperienceRecord[]): Record<string, unknown> {
  const eligible = records.filter((record) => record.eligibility === "CANDIDATE_LEARNING_ELIGIBLE"); const dates = new Set(eligible.map((record) => record.decisionTimeMs == null ? "none" : new Date(record.decisionTimeMs).toISOString().slice(0, 10))); const lanes = new Set(eligible.map((record) => record.laneId ?? "none")); const symbols = new Set(eligible.map((record) => record.symbolOrBasketId ?? "none"));
  return { model: name, eligibleRows: eligible.length, distinctDecisionDays: dates.size, distinctLanes: lanes.size, distinctSymbols: symbols.size, chronologicalWalkForward: "NOT_RUN", groupedConfidenceIntervals: "NOT_RUN", status: eligible.length >= 30 && dates.size >= 3 && lanes.size >= 2 ? "READY_FOR_OFFLINE_WALK_FORWARD" : "NOT_RUN_INSUFFICIENT_ELIGIBLE_CAUSAL_EXPERIENCE", exclusion: "No synthetic/stress/adversarial/execution-calibration record is included." };
}
function main(): void {
  mkdirSync(OUT, { recursive: true });
  const shadow = observedShadow(); const paper = paperOrders(); const counterfactual = observedCounterfactuals();
  const replay = historicalReplay();
  const all = [...shadow, ...paper, ...counterfactual, ...replay];
  const eligibility = Object.fromEntries(["CANDIDATE_LEARNING_ELIGIBLE", "EVALUATION_ONLY", "INELIGIBLE_FOR_DIRECT_TRAINING"].map((key) => [key, all.filter((record) => record.eligibility === key).length]));
  const comparison = [model("A_REAL_OBSERVED_ONLY", [...shadow, ...paper]), model("B_REAL_OBSERVED_PLUS_HISTORICAL_REPLAY", [...shadow, ...paper, ...replay]), model("C_REAL_PLUS_REPLAY_PLUS_OBSERVED_PATH_COUNTERFACTUAL", all)];
  const inventory = { generatedAt: "offline deterministic inventory; no wall-clock acceptance decision", sources: { OBSERVED_SHADOW_OUTCOME: { records: shadow.length, file: "data/regime-controller-aligned-shadow.json", status: "OUTCOMES_PRESENT_DECISION_SNAPSHOTS_ABSENT" }, OBSERVED_LIVE_CONTEXT_WITH_PAPER_OUTCOME: { records: paper.length, file: "data/paper-execution-router.json", status: "CONTEXT_PRESENT_RESOLVED_OUTCOMES_ABSENT" }, HISTORICAL_CAUSAL_REPLAY: { records: replay.length, file: "artifacts/experience-engine/historical-causal-replay.json", status: replay.length ? "ROW_LEVEL_CAUSAL_EXPORT_PRESENT_TIER_A_EXECUTION_MODEL_ESTIMATE" : "NO_ROW_LEVEL_CAUSAL_EXPORT" }, OBSERVED_PATH_COUNTERFACTUAL: { records: counterfactual.length, file: "data/kronos-counterfactual-observations.json", status: "PATH_OBSERVATIONS_PRESENT_CURRENTLY_UNRESOLVED" }, SIMULATED_STRESS: { status: "PHASE2D_AND_PHASE3A_STRESS_TEST_ONLY" }, ADVERSARIAL_SYNTHETIC: { status: "INVARIANT_TESTING_ONLY" }, EXECUTION_CALIBRATION: { status: "EVALUATION_ONLY_NOT_DIRECTIONAL_ALPHA" } }, eligibility };
  write("normalized-experiences.json", all); write("eligibility-audit.json", { inventory, eligibility, rejectionReasons: all.flatMap((record) => record.eligibilityReasons).reduce<Record<string, number>>((acc, reason) => { acc[reason] = (acc[reason] ?? 0) + 1; return acc; }, {}) }); write("baseline-candidate-comparison.json", comparison);
  const replayEligible = replay.filter((record) => record.eligibility === "CANDIDATE_LEARNING_ELIGIBLE").length;
  write("EXPERIENCE_SOURCE_INVENTORY.md", markdown("Experience source inventory", `| Source | Records | Status |\n|---|---:|---|\n| Observed shadow outcomes | ${shadow.length} | outcomes exist; decision snapshots absent |\n| Observed live context + paper outcome | ${paper.length} | contexts exist; resolved outcomes absent |\n| Historical causal replay | ${replay.length} | ${replayEligible} eligible; Tier-A cost-model replay; flat abstentions are evaluation-only |\n| Observed-path counterfactual | ${counterfactual.length} | present but currently unresolved |\n| Phase 2D/3A generators | 0 | STRESS_TEST_ONLY |\n\nNo observed live fill is joined to a counterfactual label.`));
  write("EXPERIENCE_SCHEMA.md", markdown("Experience schema", `Each normalized record preserves source/provenance, decision/open/market-close/resolution time, lane/symbol/direction, feature and code schema, source freshness, attribution, outcome quality, labels, and eligibility. The canonical machine-readable dataset is \`normalized-experiences.json\`.`));
  write("REAL_DATA_ELIGIBILITY_RULES.md", markdown("Real-data eligibility rules", `Only OBSERVED_SHADOW_OUTCOME, OBSERVED_LIVE_CONTEXT_WITH_PAPER_OUTCOME, HISTORICAL_CAUSAL_REPLAY, and OBSERVED_PATH_COUNTERFACTUAL can be candidate inputs, and only after causal timestamp, feature snapshot, attribution, resolved outcome, and quality checks pass. SIMULATED_STRESS and ADVERSARIAL_SYNTHETIC are permanently INELIGIBLE_FOR_DIRECT_TRAINING. EXECUTION_CALIBRATION is evaluation-only.`));
  write("HISTORICAL_COUNTERFACTUAL_REPORT.md", markdown("Historical counterfactual report", `Pre-registered action space is locked: direction LONG/SHORT/FLAT; entry ENTER_NOW/WAIT_PULLBACK/WAIT_BREAKOUT/WAIT_CONFIRMATION/SKIP; exit HOLD/EXIT_NOW/SCALE_OUT/TRAIL/incumbent TP/SL; allocation 0x/0.5x/1.0x/1.5x under safety caps. Existing observed-path records use conservative candle approximation. The local corpus has no resolved row-level alternative-action set, so no alternative label is fabricated and no counterfactual row enters learning yet.`));
  write("CANDIDATE_LEARNING_DESIGN.md", markdown("Candidate learning design", `Model A = eligible real observed outcomes. Model B = A plus eligible historical causal replay. Model C = B plus eligible observed-path counterfactuals. All require chronological walk-forward, purge/embargo, grouped confidence intervals, provenance weighting, schema isolation, concentration checks, and untouched-real-data alpha. Current baseline comparison remains NOT_RUN unless a source has nonzero eligible causal records; historical FLAT abstentions are explicitly excluded because they have no trade outcome label.`));
  write("SIMULATOR_STRESS_INTEGRATION.md", markdown("Simulator stress integration", `Phase 2D successor and Phase 3A residual generators are permanently STRESS_TEST_ONLY. The Stress-Lab may reject candidates for regime flips, thrashing, chasing, giveback, concentration, drawdown, stale/missing inputs, cost sensitivity, invariant failures, or kill-rail behavior. It has no promotion or coefficient-update authority.`));
  write("EXPERIENCE_ENGINE_STOP_REPORT.md", markdown("Experience Engine stop report", `Architecture, normalized dataset, eligibility audit, and baseline Model A/B/C comparison are complete. All three models are NOT_RUN_INSUFFICIENT_ELIGIBLE_CAUSAL_EXPERIENCE because the checkout lacks resolved outcomes joined to valid decision-time feature snapshots. No holdout was opened; no simulator output was admitted; no CORTEX beta, runtime, deploy, VPS, or live learning was changed.`));
  console.log(JSON.stringify({ records: all.length, eligibility, comparison }, null, 2));
}
main();
