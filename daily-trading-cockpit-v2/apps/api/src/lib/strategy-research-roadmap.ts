/**
 * STRATEGIC PROFIT ROADMAP (REPORT-ONLY)
 *
 * Pure module: no I/O. Static report builder summarising the current branch
 * verdict (NOT_LIVE_READY for intraday TP1 scalping), killed workstreams,
 * keep-testing lanes, next strategy families (Slower Portfolio Trend,
 * Intraday Microstructure, Multi-Venue Arbitrage), readiness gates, and a
 * 30/90 day plan.
 *
 * Lane label: STRATEGY_RESEARCH_ROADMAP_V1
 *
 * STRICTLY REPORT-ONLY:
 *  - No I/O; no file writes; no side effects
 *  - No influence on live behavior, scoring, ranking, route selection,
 *    Kronos / Whale / Fingerprint / adaptive policy / readiness gates
 *  - reportOnly: true always set
 */

export type WorkstreamStatus =
  | "KILLED"
  | "KEEP_TESTING"
  | "PROMOTION_CANDIDATE"
  | "NOT_STARTED";

export type Verdict = "NOT_LIVE_READY" | "WATCHABLE" | "LIVE_READY" | "BLOCKED";

export interface WorkstreamSummary {
  name: string;
  laneId: string | null;
  status: WorkstreamStatus;
  reason: string;
  evidence: string;
}

export interface StrategyFamily {
  name: string;
  priority: 1 | 2 | 3;
  rationale: string;
  expectedTimeToEvidence: string;
  dataNeeded: string[];
}

export interface ReadinessGate {
  name: string;
  required: string;
  current: string;
  status: "PASS" | "FAIL" | "NOT_MEASURABLE";
}

export interface RoadmapMilestone {
  day: number;
  action: string;
  owner: string;
  blockedBy?: string;
}

export interface StrategyResearchRoadmapReport {
  reportOnly: true;
  computedAt: string;
  currentBranchVerdict: {
    verdict: Verdict;
    summary: string;
    keyEvidence: string[];
  };
  killedWorkstreams: WorkstreamSummary[];
  keepTestingWorkstreams: WorkstreamSummary[];
  nextStrategyFamilies: StrategyFamily[];
  readinessGates: ReadinessGate[];
  microPilotBlockers: string[];
  thirtyDayPlan: RoadmapMilestone[];
  ninetyDayPlan: RoadmapMilestone[];
}

export function buildStrategyResearchRoadmapReport(
  capturedAt?: string,
): StrategyResearchRoadmapReport {
  return {
    reportOnly: true,
    computedAt: capturedAt ?? new Date().toISOString(),

    currentBranchVerdict: {
      verdict: "NOT_LIVE_READY",
      summary:
        "Current intraday TP1 scalping stack has no demonstrated tradable edge after cost. Exact exit extension (TP2/TP3/runner variants) failed validation. Pivot to slower portfolio trend + microstructure data collection.",
      keyEvidence: [
        "Controller-Aligned Shadow V1 (W**): n=~46, netAvgR≈-0.11, PF≈0.40, WR≈45%",
        "All exact path exit counterfactuals NEGATIVE (TP1_FULL, TP2_FULL, TP1_50_TP2_50, TP1_50_RUNNER_TP3)",
        "Filtered Edge V1 (W***): TOO_EARLY for all profiles; chronology integrity FAIL on legacy data",
        "Edge isolation: only watchable cohort = costR ≤ 0.10 (n=8, netAvgR=+0.024)",
      ],
    },

    killedWorkstreams: [
      {
        name: "TP2/TP3 Runner Exit Extensions",
        laneId: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1 exit variants",
        status: "KILLED",
        reason:
          "Exact path counterfactuals all negative; runner variants did not survive validation",
        evidence:
          "TP1_FULL, TP2_FULL, TP1_50_TP2_50, TP1_50_RUNNER_TP3 all negative net expectancy",
      },
      {
        name: "Best-Exit Lane V1",
        laneId: "REGIME_CONTROLLER_ALIGNED_BEST_EXIT_SHADOW_V1",
        status: "KILLED",
        reason: "Promotion gate never opened; deferred indefinitely",
        evidence:
          "evaluateBestExitLanePromotion never returned eligible; no observations created",
      },
    ],

    keepTestingWorkstreams: [
      {
        name: "Base Route Stop175 Current-Guard Tape",
        laneId: "BASE_ROUTE_STOP175_CURRENT_GUARD",
        status: "KEEP_TESTING",
        reason:
          "F*. Risk Hygiene Monitor reports positive netAvgR with low cost; requires deeper stability + sample-size checks before promotion consideration",
        evidence:
          "closed=~62, netAvgR≈+0.085, avgCostR≈0.12, verdict=RISK_HYGIENE_IMPROVING",
      },
      {
        name: "Filtered Edge STRICT_COST10",
        laneId: "REGIME_CONTROLLER_ALIGNED_FILTERED_EDGE_SHADOW_V1:STRICT_COST10",
        status: "KEEP_TESTING",
        reason: "n=22, still TOO_EARLY; needs ≥20 fresh-valid resolved before verdict",
        evidence: "STRICT_COST10 freshValid<20",
      },
      {
        name: "Filtered Edge BROAD_COST20_STOP150",
        laneId: "REGIME_CONTROLLER_ALIGNED_FILTERED_EDGE_SHADOW_V1:BROAD_COST20_STOP150",
        status: "KEEP_TESTING",
        reason: "n=13, slow collection",
        evidence: "BROAD_COST20_STOP150 freshValid<20",
      },
      {
        name: "Controller-Aligned costR≤0.10 sub-cohort",
        laneId: "REGIME_CONTROLLER_ALIGNED_SHADOW_V1:costR<=0.10",
        status: "KEEP_TESTING",
        reason: "Only watchable cohort identified; need n≥20",
        evidence: "n=8, netAvgR=+0.024",
      },
    ],

    nextStrategyFamilies: [
      {
        name: "Slower Portfolio Trend / Cross-Sectional",
        priority: 1,
        rationale:
          "Reuses existing OHLCV/regime infrastructure; lower turnover reduces cost drag; broader holding times allow trend exploitation",
        expectedTimeToEvidence: "30-60 days to first evidence",
        dataNeeded: [
          "30m/1h/4h OHLCV",
          "regime label",
          "volatility-adjusted momentum",
          "liquidity tier",
        ],
      },
      {
        name: "Intraday Microstructure",
        priority: 2,
        rationale:
          "Order book / trade flow / funding give execution-grade signals current stack lacks",
        expectedTimeToEvidence: "90+ days to first evidence (data collection phase)",
        dataNeeded: [
          "book ticker",
          "spread",
          "depth",
          "agg trades",
          "taker delta",
          "funding rate",
          "open interest",
          "force orders",
        ],
      },
      {
        name: "Multi-Venue Arbitrage",
        priority: 3,
        rationale: "Capital-intensive but execution-edge oriented",
        expectedTimeToEvidence: "120+ days",
        dataNeeded: ["multi-exchange depth", "transfer latency", "fee schedule"],
      },
    ],

    readinessGates: [
      {
        name: "≥200 fresh-valid trades on frozen lane",
        required: "≥200 fresh-valid resolved on at least one frozen lane",
        current: "max fresh-valid count = 1",
        status: "FAIL",
      },
      {
        name: "Positive net expectancy in 3 OOS segments",
        required: "Positive netAvgR in three independent OOS segments",
        current: "insufficient sample",
        status: "NOT_MEASURABLE",
      },
      {
        name: "PF > 1.20",
        required: "Profit factor strictly greater than 1.20",
        current: "all lanes PF < 0.6",
        status: "FAIL",
      },
      {
        name: "No single symbol >40% PnL",
        required: "No single symbol contributes more than 40% of total PnL",
        current: "insufficient sample",
        status: "NOT_MEASURABLE",
      },
      {
        name: "Max drawdown within limit",
        required: "Max drawdown ≤ 25% of total PnL",
        current: "insufficient sample",
        status: "NOT_MEASURABLE",
      },
      {
        name: "Kill switch exists",
        required: "Live trading kill switch implemented",
        current: "no live trading code",
        status: "FAIL",
      },
      {
        name: "Order reconciliation exists",
        required: "Order reconciliation infrastructure exists",
        current: "paper-only",
        status: "FAIL",
      },
      {
        name: "Funding/slippage modeled",
        required: "Funding rate and slippage modeled in cost calculation",
        current: "not in current cost model",
        status: "FAIL",
      },
    ],

    microPilotBlockers: [
      "No lane has ≥200 fresh-valid resolved",
      "No positive net expectancy demonstrated",
      "No real order execution code path",
      "No kill switch / reconciliation infrastructure",
      "Cost model assumes 28bps round-trip without funding/slippage",
    ],

    thirtyDayPlan: [
      {
        day: 1,
        action:
          "Pivot infrastructure: roadmap, scoreboard, scan-history rotation, portfolio lane scaffolding, microstructure collector",
        owner: "engineering",
      },
      {
        day: 7,
        action:
          "Portfolio Trend Shadow V1 first 20 admissions; verify cost/turnover profile",
        owner: "engineering",
        blockedBy: "day 1 scaffolding live",
      },
      {
        day: 14,
        action: "Microstructure Collector V1 daily snapshot for ≥10 symbols",
        owner: "engineering",
        blockedBy: "day 1 scaffolding live",
      },
      {
        day: 21,
        action: "Portfolio Trend Shadow V1 first 5 fresh-valid resolutions",
        owner: "analysis",
        blockedBy: "day 7 admissions",
      },
      {
        day: 30,
        action:
          "Decide KILL/CONTINUE on Portfolio Trend; ≥30 collector snapshots/symbol for spread distribution analysis",
        owner: "analysis",
        blockedBy: "day 21 resolutions and day 14 collector cadence",
      },
    ],

    ninetyDayPlan: [
      {
        day: 30,
        action: "Portfolio Trend Shadow V1: target n≥50 fresh-valid",
        owner: "analysis",
      },
      {
        day: 45,
        action:
          "If Portfolio Trend shows positive net, extend to second profile (e.g. stop multiplier variant)",
        owner: "engineering",
        blockedBy: "day 30 sample reached and net positive",
      },
      {
        day: 60,
        action:
          "Microstructure: derive basic alpha signals from collected snapshots (advisory only)",
        owner: "analysis",
        blockedBy: "collector volume ≥30 snapshots/symbol",
      },
      {
        day: 75,
        action: "Portfolio Trend: target n≥100 fresh-valid; check OOS stability",
        owner: "analysis",
      },
      {
        day: 90,
        action:
          "First decision point on whether any lane qualifies for micro-pilot consideration",
        owner: "leadership",
        blockedBy: "day 75 OOS stability check",
      },
    ],
  };
}
