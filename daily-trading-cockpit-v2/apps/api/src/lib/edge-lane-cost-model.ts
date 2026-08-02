/**
 * EDGE-LANE COST-MODEL GENERATION (2026-08-02) — pure, no imports.
 *
 * The six self-contained edge-lane modules (RC, RCS, SF, IM, PWR, CE — regime-composite-edge.ts,
 * regime-composite-short-edge.ts, short-fade-edge.ts, intraday-momentum-edge.ts,
 * panic-washout-reclaim-edge.ts, composite-estimator-edge.ts) each compute their own netR with a
 * fixed, locally-defined cost formula (a constant taker-roundtrip-bps + stop-slippage-bps baked
 * into that module's own `netOf()`) — this is a SEPARATE cost model from
 * paper-execution-router.ts's PAPER_COST_MODEL_VERSION/PAPER_COST_MODEL_V2_ENABLED (these six
 * lanes are report-only measurement modules with their own store/cycle/resolver, never routed
 * through the paper router), so grafting the router's version constant onto them would be
 * pretending a shared cost model exists when it doesn't.
 *
 * This is THEIR OWN generation counter, stamped on every observation each module creates, read via
 * paper-cost-cohort.ts's selectNewestCostCohort() exactly as-is (same "never pool two generations"
 * rule, same LEGACY_COST_MODEL_GENERATION=1 default for older unstamped rows). Today there is only
 * ever generation 1 — none of these six formulas has ever changed — so costValid trivially holds
 * whenever a lane's resolved observations are homogeneous, which they always are right now. This
 * stops being trivial, and starts doing real work, the moment any of the six modules' cost
 * constants (TAKER_ROUNDTRIP_BPS, STOP_OUT_SLIPPAGE_BPS, or their per-module equivalents) changes:
 * bump this constant at the same time, and old/new observations stop pooling silently.
 */
export const EDGE_LANE_COST_MODEL_VERSION = 1;
