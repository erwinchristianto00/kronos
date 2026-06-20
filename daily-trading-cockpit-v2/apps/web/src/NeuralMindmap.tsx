import { useEffect, useMemo, useState } from 'react';
import './neural-mindmap.css';

type NeuralHealth = 'HEALTHY' | 'ACTIVE' | 'WARNING' | 'CRITICAL' | 'IDLE' | 'COLLECTING' | 'QUARANTINE' | 'DIAGNOSTIC';
type NeuralDiagnosisCategory =
  | 'HEALTHY_FLOW'
  | 'COLLECTING_EVIDENCE'
  | 'IDLE'
  | 'LATENCY'
  | 'DEGRADED_INPUT'
  | 'CAPACITY_PRESSURE'
  | 'QUARANTINE'
  | 'HARD_FAIL'
  | 'DESTRUCTIVE_ECONOMICS'
  | 'BLOCKING_CONDITION';

interface NeuralNode {
  id: string;
  label: string;
  kind: string;
  health: NeuralHealth;
  active: boolean;
  metric: string;
  diagnosisCategory: NeuralDiagnosisCategory;
  diagnosisSummary: string;
  diagnosisFacts: string[];
  detail: string[];
}

interface TpAssessment {
  activeTpPct: number;
  roundTripCostPct: number;
  netTpAfterCostPct: number;
  verdict: 'TOO_TIGHT_AFTER_COST' | 'LOW_EDGE_AFTER_COST' | 'OK' | 'STRETCHED' | 'TOO_FAR_VS_MFE';
  reason: string;
}

interface NeuralLane {
  id: string;
  label: string;
  health: NeuralHealth;
  evidenceHealth: NeuralHealth;
  active: boolean;
  open: number;
  closed: number;
  oosFreshValid: number | null;
  oosThreshold: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  statsSource: 'VM_SIM' | 'PAPER_BOOK';
  payoffRatio: number | null;
  plus10bpsStillPositive: boolean | null;
  allThreeOosPositive: boolean | null;
  approxMaxDrawdownR: number | null;
  topSymbolPnlShare: number | null;
  calendarDays: number | null;
  distinctRegimes: number | null;
  infraReady: boolean | null;
  blockers: string[];
  cautions: string[];
  headlinePnl: number;
  diagnosticPnl: number;
  totalPnl: number;
  openUnrealizedPnl: number | null;
  openUnrealizedR: number | null;
  diagnosticUnrealizedPnl: number | null;
  diagnosticUnrealizedR: number | null;
  headlineUnrealizedPnl: number | null;
  headlineUnrealizedR: number | null;
  openMaxFavorablePnl: number | null;
  openMaxFavorableR: number | null;
  openAvgDistanceToTpPct: number | null;
  openNearestDistanceToTpPct: number | null;
  openAvgEntryPrice: number | null;
  openAvgMarkPrice: number | null;
  openAvgTakeProfitPrice: number | null;
  openAvgMfePct: number | null;
  openP75MfePct: number | null;
  openP90MfePct: number | null;
  openAvgConfiguredTpPct: number | null;
  openTpAssessment: TpAssessment | null;
  openMarkedSymbolCount: number;
  startingEquity: number;
  totalPnlPct: number | null;
  headlinePnlPct: number | null;
  pnlIsDiagnosticOnly: boolean;
  status: string;
  reason: string;
}

interface NeuralTelemetry {
  version: string;
  generatedAt: string;
  staleAfterSec: number;
  controller: {
    regime: string | null;
    mode: string;
    bias: string;
    confidence: string;
    allowsLong: boolean;
    allowsShort: boolean;
    allowsNewEntries: boolean;
    reasons: string[];
  };
  safety: { liveBlocked: true; microPilotAllowed: false; paperOnly: true };
  scan: {
    status: string;
    running: boolean;
    lastFinishedAt: string | null;
    totalMs: number | null;
    slowestStage: string | null;
    slowestStageMs: number | null;
    timeoutSymbols: number;
    degradedProviders: string[];
    backgroundLagSec: number | null;
  };
  paper: {
    total: number;
    open: number;
    closed: number;
    wins: number;
    losses: number;
    headlinePnl: number;
    diagnosticPnl: number;
    totalPnl: number;
    openUnrealizedPnl: number | null;
    openUnrealizedR: number | null;
    diagnosticUnrealizedPnl: number | null;
    diagnosticUnrealizedR: number | null;
    headlineUnrealizedPnl: number | null;
    headlineUnrealizedR: number | null;
    openMaxFavorablePnl: number | null;
    openMaxFavorableR: number | null;
    openAvgDistanceToTpPct: number | null;
    openNearestDistanceToTpPct: number | null;
    openAvgMfePct: number | null;
    openP75MfePct: number | null;
    openP90MfePct: number | null;
    openAvgConfiguredTpPct: number | null;
    openTpAssessment: TpAssessment | null;
    unrealizedMarkCount: number;
    unrealizedMissingPriceCount: number;
    unrealizedPriceSource: string | null;
    todayPnl: number;
    headlineNetAvgR: number | null;
    headlinePF: number | null;
    headlineWR: number | null;
  };
  mixed: {
    activeLane: string | null;
    activeLanes: string[];
    tradingMode: string;
    admission: string;
    occupancyMode: string;
    stalePassHealth: string;
    budgetProfile: string;
    guardrailStatus: string;
    recommendedAction: string;
    waitForCapacity: number;
    oosCount: number;
    oosThreshold: number;
  };
  nodes: NeuralNode[];
  lanes: NeuralLane[];
  alerts: Array<{ severity: 'WARNING' | 'CRITICAL'; source: string; message: string }>;
}

interface PaperControls {
  controls: { cgWideTpPct: number | null; updatedAt: string | null };
  cgWideTp: {
    activeTpPct: number;
    defaultTpPct: number;
    roundTripCostPct: number;
    assessment: TpAssessment | null;
  };
}

interface Point {
  x: number;
  y: number;
}

interface ProcessGuide {
  purpose: string;
  steps: string[];
  healthyMeans: string;
  inspectWhenBad: string[];
}

type MilestoneStage =
  | 'COLLECTING'
  | 'PAPER_EVIDENCE'
  | 'HEADLINE_READY'
  | 'HEADLINE_ACTIVE'
  | 'STABLE_CANDIDATE'
  | 'PROMOTION_CANDIDATE';

interface StageProgress {
  nextStage: string;
  progressPct: number;
  blockers: string[];
  checklist: string[];
}

const NODE_POSITIONS: Record<string, Point> = {
  binance: { x: 110, y: 160 },
  kronos: { x: 110, y: 300 },
  external: { x: 110, y: 440 },
  scan: { x: 330, y: 300 },
  scoring: { x: 520, y: 300 },
  controller: { x: 700, y: 230 },
  'lane-router': { x: 700, y: 390 },
  occupancy: { x: 880, y: 390 },
  paper: { x: 1245, y: 300 },
  outcomes: { x: 1245, y: 470 },
  guardrail: { x: 880, y: 600 },
  'live-lock': { x: 700, y: 650 },
};

const CORE_EDGES: Array<[string, string]> = [
  ['binance', 'scan'],
  ['kronos', 'scan'],
  ['external', 'scan'],
  ['scan', 'scoring'],
  ['scoring', 'controller'],
  ['controller', 'lane-router'],
  ['lane-router', 'occupancy'],
  ['occupancy', 'guardrail'],
  ['guardrail', 'lane-router'],
  ['paper', 'outcomes'],
  ['outcomes', 'controller'],
  ['live-lock', 'controller'],
  ['live-lock', 'paper'],
];

const HEALTH_LABELS: Record<NeuralHealth, string> = {
  HEALTHY: 'Healthy',
  ACTIVE: 'Active flow',
  WARNING: 'Degraded',
  CRITICAL: 'Failing (real loss)',
  IDLE: 'Idle',
  COLLECTING: 'Collecting evidence',
  QUARANTINE: 'Blocked / benched (intentional)',
  DIAGNOSTIC: 'Diagnostic probe (not real trades)',
};

const PROCESS_GUIDES: Record<string, ProcessGuide> = {
  binance: {
    purpose: 'Supplies candles and market state for every symbol entering the scan.',
    steps: ['Request symbol candles', 'Apply timeout and retry policy', 'Validate latest candle', 'Forward usable symbols to the scan'],
    healthyMeans: 'All required symbols returned valid, recent candles inside the timeout budget.',
    inspectWhenBad: ['Check timeout symbol count', 'Inspect candle failure reasons', 'Check Binance retry and provider wait time'],
  },
  kronos: {
    purpose: 'Adds forecast direction, probability, horizon agreement, and forecast risk.',
    steps: ['Build forecast input window', 'Call Kronos sidecar', 'Validate prediction shape', 'Attach forecast evidence to candidate'],
    healthyMeans: 'Forecasts return within budget and valid horizon evidence is available.',
    inspectWhenBad: ['Check Kronos forecast duration', 'Check sidecar reachability', 'Inspect prediction failure or model-busy counts'],
  },
  external: {
    purpose: 'Collects external signal overlays without blocking the whole scan when a provider degrades.',
    steps: ['Request configured providers', 'Apply per-provider timeout', 'Use safe fallback when available', 'Attach missing-data markers'],
    healthyMeans: 'Providers respond inside their timeout and no circuit breaker is active.',
    inspectWhenBad: ['Inspect degraded provider names', 'Check external fetch duration', 'Check circuit-breaker skip cycles'],
  },
  scan: {
    purpose: 'Coordinates symbol fetches and produces the latest ranked market candidate batch.',
    steps: ['Fan out symbol fetches', 'Accept healthy partial results', 'Build candidate inputs', 'Publish scan batch and timing diagnostics'],
    healthyMeans: 'The scan completes inside its normal latency band without hang markers or excessive symbol failures.',
    inspectWhenBad: ['Inspect slowest stage', 'Inspect failed symbols', 'Check hang markers and provider degradation'],
  },
  scoring: {
    purpose: 'Scores direction, opportunity, danger, confidence, liquidity, and volatility.',
    steps: ['Normalize candidate inputs', 'Compute directional scores', 'Apply evidence and conflict diagnostics', 'Rank candidate set'],
    healthyMeans: 'Scoring completes quickly and every candidate has valid decision metadata.',
    inspectWhenBad: ['Check missing candidate metadata', 'Inspect source conflicts', 'Check candidate scoring duration'],
  },
  controller: {
    purpose: 'Converts the current regime into directional posture and entry permissions.',
    steps: ['Classify market regime', 'Choose directional bias', 'Set controller mode', 'Publish allowed directions and confidence'],
    healthyMeans: 'Regime classification is known and the posture is internally consistent.',
    inspectWhenBad: ['Inspect regime reason codes', 'Check whether mode and bias agree', 'Check whether entry permission is intentionally restricted'],
  },
  'lane-router': {
    purpose: 'Maps qualified candidates into strategy lanes appropriate for the current regime.',
    steps: ['Read controller posture', 'Evaluate lane qualification', 'Apply mixed-router rescue rules', 'Select active paper lane set'],
    healthyMeans: 'Qualified candidates map to an eligible lane with an explicit route reason.',
    inspectWhenBad: ['Check active lane list', 'Inspect qualification and route decision', 'Check whether a lane is quarantined'],
  },
  occupancy: {
    purpose: 'Prevents an otherwise good signal from overcrowding the paper book.',
    steps: ['Count open and stale positions', 'Check symbol and direction concentration', 'Compare against active budget', 'Allow, reduce risk, or wait'],
    healthyMeans: 'The book is inside budget and qualified signals retain capacity.',
    inspectWhenBad: ['Check open versus stale counts', 'Check WAIT_FOR_CAPACITY reason', 'Inspect per-symbol and directional pressure'],
  },
  paper: {
    purpose: 'Creates and tracks paper-only orders after routing and admission.',
    steps: ['Validate paper opportunity', 'Apply paper risk multiplier', 'Create deduplicated paper order', 'Track open and closed lifecycle'],
    healthyMeans: 'Orders are created only from eligible admissions and resolve without data failures.',
    inspectWhenBad: ['Check paper data failures', 'Inspect no-order reason', 'Check order provenance and dedupe'],
  },
  outcomes: {
    purpose: 'Resolves open paper orders against candle paths and records their outcomes.',
    steps: ['Queue open orders', 'Fetch resolution candles', 'Walk fill and exit path', 'Persist paper outcome metrics'],
    healthyMeans: 'The background queue completes with low lag and no resolution errors.',
    inspectWhenBad: ['Check queue lag', 'Inspect outcome-checker status', 'Inspect last background error'],
  },
  guardrail: {
    purpose: 'Monitors the paper-only mixed budget experiment and recommends keep, review, or rollback.',
    steps: ['Count profile decisions', 'Aggregate closed OOS results', 'Evaluate PF, net R, WR, and capacity pressure', 'Publish recommended action'],
    healthyMeans: 'Enough OOS exists and profile economics remain positive with acceptable capacity pressure.',
    inspectWhenBad: ['Read guardrail reasons', 'Check OOS sample size', 'Check PF, net average R, and capacity spike'],
  },
  'live-lock': {
    purpose: 'Keeps every experiment isolated from live trading and exchange execution.',
    steps: ['Force paper-only scope', 'Block live execution', 'Disable micro-pilot', 'Expose lock state to operators'],
    healthyMeans: 'liveBlocked remains true and microPilotAllowed remains false.',
    inspectWhenBad: ['Stop the process immediately', 'Verify environment safety flags', 'Audit exchange call paths'],
  },
};

function compactLaneLabel(label: string): string {
  return label.slice(0, 24);
}

function fmtNumber(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  if (value === Infinity) return 'inf';
  return value.toFixed(digits);
}

function fmtR(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}R`;
}

function fmtMoney(value: number): string {
  return `NT$ ${Math.round(value).toLocaleString('id-ID')}`;
}

function fmtUsdt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} USDT`;
}

function fmtPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) >= 100) return value.toFixed(2);
  if (Math.abs(value) >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function fmtPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function fmtGapPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  if (value <= 0) return `${value.toFixed(2)}% hit`;
  return `${value.toFixed(2)}%`;
}

function fmtPlainPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(2)}%`;
}

function tpVerdictLabel(assessment: TpAssessment | null | undefined): string {
  if (!assessment) return 'n/a';
  if (assessment.verdict === 'TOO_FAR_VS_MFE') return 'Too far vs MFE';
  if (assessment.verdict === 'STRETCHED') return 'Stretched';
  if (assessment.verdict === 'TOO_TIGHT_AFTER_COST') return 'Too tight';
  if (assessment.verdict === 'LOW_EDGE_AFTER_COST') return 'Thin after cost';
  return 'OK after cost';
}

function fmtMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s` : `${Math.round(value)}ms`;
}

function laneDiagnosis(lane: NeuralLane): string {
  if (lane.diagnosticUnrealizedPnl !== null && lane.diagnosticUnrealizedPnl !== 0) {
    return `Open diagnostic mark-to-market is ${fmtUsdt(lane.diagnosticUnrealizedPnl)} (${fmtR(lane.diagnosticUnrealizedR)}). Closed evidence remains separate.`;
  }
  if (lane.totalPnl > 0) return 'This lane is profitable on paper, so the lane field renders it green.';
  if (lane.totalPnl < 0) return 'This lane is losing money on paper, so the lane field renders it red.';
  if (lane.closed > 0 || lane.open > 0) return 'This lane has activity, but realized paper profit is still flat.';
  return 'This lane has not built realized paper performance yet.';
}

function laneMetricLabel(
  lane: NeuralLane,
  liveLane: LiveLaneExposure | undefined,
  accountEquity: number | null | undefined,
): string {
  if (liveLane) {
    const growth = accountEquity && accountEquity > 0 ? (liveLane.unrealizedPnl / accountEquity) * 100 : null;
    return `${fmtPct(growth)} / ${liveLane.sourceOrderCount} live`;
  }
  if (lane.diagnosticUnrealizedPnl !== null && lane.open > 0) {
    // Measurement, not a real position — label it so the open mark-to-market on
    // diagnostic probes does not read as a real loss.
    return `meas ${fmtUsdt(lane.diagnosticUnrealizedPnl)} / open`;
  }
  if (lane.totalPnl > 0 && lane.totalPnlPct !== null) {
    return `${fmtPct(lane.totalPnlPct)} / n=${lane.closed}`;
  }
  return `${fmtMoney(lane.totalPnl)} / n=${lane.closed}`;
}

function edgePath(from: Point, to: Point): string {
  const bend = Math.max(45, Math.abs(to.x - from.x) * 0.42);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

function healthRank(health: NeuralHealth): number {
  // QUARANTINE is a benched/neutral state, not a fault — ranks below WARNING so it never inflates
  // the critical/warning counts.
  return health === 'CRITICAL' ? 5 : health === 'WARNING' ? 4 : health === 'ACTIVE' ? 3 : health === 'HEALTHY' ? 2 : 1;
}

function healthDiagnosis(health: NeuralHealth): string {
  if (health === 'CRITICAL') return 'FAILING — losing real money on HEADLINE trades (genuinely bad, needs attention).';
  if (health === 'DIAGNOSTIC') return 'Diagnostic probes only — these are reject-sampler measurements on candidates the gate ALREADY rejected, NOT real trades. Red/loss here is expected and harmless; it is how the system measures what it correctly avoids.';
  if (health === 'WARNING') return 'The component is operating with degraded input, latency, or capacity pressure.';
  if (health === 'COLLECTING') return 'The component is functioning, but evidence is not mature enough for a stable verdict.';
  if (health === 'QUARANTINE') return 'BLOCKED / benched on purpose (no new admissions) — gated by the edge memory or safety policy, not a failure. Still measured via the VM simulation; it graduates back if its evidence turns healthy.';
  if (health === 'IDLE') return 'The component is intentionally inactive under the current regime or workflow.';
  if (health === 'ACTIVE') return 'The component is healthy and currently carrying decision flow.';
  return 'The component is healthy and no material fault is currently reported.';
}

const DIAGNOSIS_LABELS: Record<NeuralDiagnosisCategory, string> = {
  HEALTHY_FLOW: 'Healthy flow',
  COLLECTING_EVIDENCE: 'Collecting evidence',
  IDLE: 'Idle',
  LATENCY: 'Latency',
  DEGRADED_INPUT: 'Degraded input',
  CAPACITY_PRESSURE: 'Capacity pressure',
  QUARANTINE: 'Quarantine',
  HARD_FAIL: 'Hard fail',
  DESTRUCTIVE_ECONOMICS: 'Destructive economics',
  BLOCKING_CONDITION: 'Blocking condition',
};

const STABLE_MIN_FRESH = 100;
const PROMOTION_MIN_FRESH = 200;
const HEADLINE_PF_FLOOR = 1.2;

function stageLabel(stage: MilestoneStage): string {
  if (stage === 'PROMOTION_CANDIDATE') return 'Promotion candidate';
  if (stage === 'STABLE_CANDIDATE') return 'Stable candidate';
  if (stage === 'HEADLINE_ACTIVE') return 'Headline active';
  if (stage === 'HEADLINE_READY') return 'Headline ready';
  if (stage === 'PAPER_EVIDENCE') return 'Paper evidence';
  return 'Collecting';
}

function laneMilestone(lane: NeuralLane): { stage: MilestoneStage; reason: string } {
  const watchableMin = lane.oosThreshold > 0 ? lane.oosThreshold : 10;
  const freshValid = lane.oosFreshValid ?? lane.closed;
  const status = lane.status.toUpperCase();
  if (status.includes('PROMOTION_CANDIDATE')) {
    return {
      stage: 'PROMOTION_CANDIDATE',
      reason: `Telemetry status is PROMOTION_CANDIDATE: fresh-valid ${freshValid} is already in the promotable tier, pending manual live approval and infra gates.`,
    };
  }
  if (status.includes('STABLE_CANDIDATE')) {
    return {
      stage: 'STABLE_CANDIDATE',
      reason: `Telemetry status is STABLE_CANDIDATE: fresh-valid ${freshValid} is stable, but promotion gates are not complete yet.`,
    };
  }
  if (status.includes('WATCHABLE')) {
    if (lane.active) {
      return {
        stage: 'HEADLINE_ACTIVE',
        reason: `Telemetry status is WATCHABLE and this lane is currently active, so it is the live headline paper lane now.`,
      };
    }
    return {
      stage: 'HEADLINE_READY',
      reason: `Telemetry status is WATCHABLE: fresh-valid ${freshValid}/${watchableMin}, net ${fmtR(lane.netAvgR)}, PF ${fmtNumber(lane.pf)}. Eligible for headline paper, but not the active lane right now.`,
    };
  }
  if (status.includes('REJECT')) {
    return {
      stage: lane.closed > 0 || lane.open > 0 ? 'PAPER_EVIDENCE' : 'COLLECTING',
      reason: `Telemetry status is REJECT: there may be evidence on tape, but current fresh-valid economics still fail the watchable/headline gate.`,
    };
  }
  if (lane.closed > 0 || lane.open > 0) {
    return {
      stage: 'PAPER_EVIDENCE',
      reason: `Telemetry still says COLLECTING, but paper evidence already exists. It has not reached WATCHABLE yet: fresh-valid ${freshValid}/${watchableMin}, net ${fmtR(lane.netAvgR)}, PF ${fmtNumber(lane.pf)}.`,
    };
  }
  return {
    stage: 'COLLECTING',
    reason: `No real paper evidence yet. Telemetry is still COLLECTING and needs fresh-valid ${watchableMin}+ before it can become WATCHABLE.`,
  };
}

function ratioProgress(value: number | null, target: number): number {
  if (value === null || !Number.isFinite(value) || target <= 0) return 0;
  return Math.max(0, Math.min(1, value / target));
}

function booleanProgress(value: boolean | null): number {
  return value ? 1 : 0;
}

function thresholdProgress(value: number | null, target: number, comparator: 'gte' | 'gt'): number {
  if (value === null || !Number.isFinite(value)) return 0;
  if (comparator === 'gte') return Math.max(0, Math.min(1, value / target));
  if (value > target) return 1;
  if (target === 0) return value > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, value / target));
}

function inverseThresholdProgress(value: number | null, limit: number): number {
  if (value === null || !Number.isFinite(value)) return 0;
  if (value <= limit) return 1;
  if (value <= 0) return 1;
  return Math.max(0, Math.min(1, limit / value));
}

function pctShare(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function stageProgress(lane: NeuralLane): StageProgress {
  const freshValid = lane.oosFreshValid ?? lane.closed;
  const telemetryStatus = lane.status.toUpperCase();
  const blockers = lane.blockers ?? [];

  if (telemetryStatus.includes('PROMOTION_CANDIDATE')) {
    const liveBlockers = [
      lane.infraReady === false ? 'live infra gates not ready' : null,
      'still report-only until explicit manual approval',
    ].filter((item): item is string => Boolean(item));
    return {
      nextStage: 'Live approval',
      progressPct: liveBlockers.length > 1 ? 50 : 100,
      blockers: liveBlockers,
      checklist: [
        `fresh-valid ${freshValid}/${PROMOTION_MIN_FRESH}`,
        `calendar ${fmtNumber(lane.calendarDays, 1)}/${fmtNumber(5, 1)} days`,
        `regimes ${lane.distinctRegimes ?? 0}/2`,
      ],
    };
  }

  if (telemetryStatus.includes('STABLE_CANDIDATE')) {
    const requirements = [
      { label: `fresh-valid ${freshValid}/${PROMOTION_MIN_FRESH}`, met: freshValid >= PROMOTION_MIN_FRESH, progress: ratioProgress(freshValid, PROMOTION_MIN_FRESH) },
      { label: `all OOS thirds positive`, met: lane.allThreeOosPositive === true, progress: booleanProgress(lane.allThreeOosPositive) },
      { label: `netAvgR > 0.05`, met: (lane.netAvgR ?? Number.NEGATIVE_INFINITY) > 0.05, progress: thresholdProgress(lane.netAvgR, 0.05, 'gt') },
      { label: `PF > ${HEADLINE_PF_FLOOR}`, met: (lane.pf ?? Number.NEGATIVE_INFINITY) > HEADLINE_PF_FLOOR, progress: thresholdProgress(lane.pf, HEADLINE_PF_FLOOR, 'gt') },
      { label: `payoff >= 0.75`, met: (lane.payoffRatio ?? Number.NEGATIVE_INFINITY) >= 0.75, progress: thresholdProgress(lane.payoffRatio, 0.75, 'gte') },
      { label: `drawdown <= 5R`, met: lane.approxMaxDrawdownR !== null && lane.approxMaxDrawdownR <= 5, progress: inverseThresholdProgress(lane.approxMaxDrawdownR, 5) },
      { label: `top-symbol share <= 40%`, met: lane.topSymbolPnlShare !== null && lane.topSymbolPnlShare <= 0.4, progress: inverseThresholdProgress(lane.topSymbolPnlShare, 0.4) },
      { label: `calendar days >= 5`, met: (lane.calendarDays ?? 0) >= 5, progress: ratioProgress(lane.calendarDays, 5) },
      { label: `distinct regimes >= 2`, met: (lane.distinctRegimes ?? 0) >= 2, progress: ratioProgress(lane.distinctRegimes, 2) },
      { label: `infra gates ready`, met: lane.infraReady === true, progress: booleanProgress(lane.infraReady) },
    ];
    return {
      nextStage: 'Promotion candidate',
      progressPct: Math.round((requirements.reduce((sum, item) => sum + item.progress, 0) / requirements.length) * 100),
      blockers: blockers.length > 0 ? blockers : requirements.filter((item) => !item.met).map((item) => item.label),
      checklist: requirements.map((item) => item.label),
    };
  }

  if (telemetryStatus.includes('WATCHABLE')) {
    const requirements = [
      { label: `fresh-valid ${freshValid}/${STABLE_MIN_FRESH}`, met: freshValid >= STABLE_MIN_FRESH, progress: ratioProgress(freshValid, STABLE_MIN_FRESH) },
      { label: `all OOS thirds positive`, met: lane.allThreeOosPositive === true, progress: booleanProgress(lane.allThreeOosPositive) },
      { label: `netAvgR > 0.05`, met: (lane.netAvgR ?? Number.NEGATIVE_INFINITY) > 0.05, progress: thresholdProgress(lane.netAvgR, 0.05, 'gt') },
      { label: `PF > ${HEADLINE_PF_FLOOR}`, met: (lane.pf ?? Number.NEGATIVE_INFINITY) > HEADLINE_PF_FLOOR, progress: thresholdProgress(lane.pf, HEADLINE_PF_FLOOR, 'gt') },
      { label: `payoff >= 0.75`, met: (lane.payoffRatio ?? Number.NEGATIVE_INFINITY) >= 0.75, progress: thresholdProgress(lane.payoffRatio, 0.75, 'gte') },
      { label: `drawdown <= 5R`, met: lane.approxMaxDrawdownR !== null && lane.approxMaxDrawdownR <= 5, progress: inverseThresholdProgress(lane.approxMaxDrawdownR, 5) },
      { label: `top-symbol share <= 40%`, met: lane.topSymbolPnlShare !== null && lane.topSymbolPnlShare <= 0.4, progress: inverseThresholdProgress(lane.topSymbolPnlShare, 0.4) },
    ];
    return {
      nextStage: 'Stable candidate',
      progressPct: Math.round((requirements.reduce((sum, item) => sum + item.progress, 0) / requirements.length) * 100),
      blockers: blockers.length > 0 ? blockers : requirements.filter((item) => !item.met).map((item) => item.label),
      checklist: requirements.map((item) => item.label),
    };
  }

  const requirements = [
    { label: `fresh-valid ${freshValid}/${lane.oosThreshold}`, met: freshValid >= lane.oosThreshold, progress: ratioProgress(freshValid, lane.oosThreshold) },
    { label: `netAvgR > 0`, met: (lane.netAvgR ?? Number.NEGATIVE_INFINITY) > 0, progress: thresholdProgress(lane.netAvgR, 0.01, 'gt') },
    { label: `PF > ${HEADLINE_PF_FLOOR}`, met: (lane.pf ?? Number.NEGATIVE_INFINITY) > HEADLINE_PF_FLOOR, progress: thresholdProgress(lane.pf, HEADLINE_PF_FLOOR, 'gt') },
    { label: `payoff >= 0.5`, met: (lane.payoffRatio ?? Number.NEGATIVE_INFINITY) >= 0.5, progress: thresholdProgress(lane.payoffRatio, 0.5, 'gte') },
    { label: `+10bps stress stays positive`, met: lane.plus10bpsStillPositive === true, progress: booleanProgress(lane.plus10bpsStillPositive) },
    { label: `top-symbol share <= 40%`, met: lane.topSymbolPnlShare !== null && lane.topSymbolPnlShare <= 0.4, progress: inverseThresholdProgress(lane.topSymbolPnlShare, 0.4) },
  ];
  return {
    nextStage: 'Headline / watchable',
    progressPct: Math.round((requirements.reduce((sum, item) => sum + item.progress, 0) / requirements.length) * 100),
    blockers: blockers.length > 0 ? blockers : requirements.filter((item) => !item.met).map((item) => item.label),
    checklist: requirements.map((item) => item.label),
  };
}

interface LiveLaneExposure {
  laneId: string;
  sourceOrderCount: number;
  symbols: string[];
  notionalUsd: number;
  unrealizedPnl: number;
}

interface LiveAccount {
  walletBalance: number | null;
  availableBalance: number | null;
  unrealizedPnl: number;
  accountEquity: number | null;
  openPositionCount: number;
  openOrderCount: number;
  lanes: LiveLaneExposure[];
}

export default function NeuralMindmap() {
  const [telemetry, setTelemetry] = useState<NeuralTelemetry | null>(null);
  const [liveAccount, setLiveAccount] = useState<LiveAccount | null>(null);
  const [selectedId, setSelectedId] = useState('controller');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastReceivedAt, setLastReceivedAt] = useState<number | null>(null);
  const [paperControls, setPaperControls] = useState<PaperControls | null>(null);
  const [tpDraft, setTpDraft] = useState('3.00');
  const [controlStatus, setControlStatus] = useState<string | null>(null);
  const [realizeStatus, setRealizeStatus] = useState<string | null>(null);

  async function loadTelemetry() {
    try {
      const response = await fetch('/api/shadow/neural-map', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Telemetry request failed (${response.status})`);
      const next = await response.json() as NeuralTelemetry;
      setTelemetry(next);
      setLastReceivedAt(Date.now());
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Neural telemetry unavailable');
    } finally {
      setLoading(false);
    }
  }

  async function loadLiveAccount() {
    try {
      const response = await fetch('/api/live/account', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json() as { ok: boolean } & Partial<LiveAccount>;
      if (data.ok) {
        setLiveAccount({
          walletBalance: data.walletBalance ?? null,
          availableBalance: data.availableBalance ?? null,
          unrealizedPnl: data.unrealizedPnl ?? 0,
          accountEquity: data.accountEquity ?? null,
          openPositionCount: data.openPositionCount ?? 0,
          openOrderCount: data.openOrderCount ?? 0,
          lanes: data.lanes ?? [],
        });
      }
    } catch {
      // non-critical — silently skip if engine is down
    }
  }

  async function loadPaperControls() {
    try {
      const response = await fetch('/api/shadow/paper-controls', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Controls request failed (${response.status})`);
      const next = await response.json() as PaperControls;
      setPaperControls(next);
      setTpDraft(next.cgWideTp.activeTpPct.toFixed(2));
    } catch (nextError) {
      setControlStatus(nextError instanceof Error ? nextError.message : 'controls unavailable');
    }
  }

  useEffect(() => {
    void loadTelemetry();
    void loadLiveAccount();
    void loadPaperControls();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadTelemetry();
      void loadLiveAccount();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  const lanePositions = useMemo(() => {
    const positions = new Map<string, Point>();
    const lanes = telemetry?.lanes ?? [];
    const gap = lanes.length > 1 ? Math.min(88, 430 / (lanes.length - 1)) : 0;
    lanes.forEach((lane, index) => positions.set(lane.id, { x: 1055, y: 100 + index * gap }));
    return positions;
  }, [telemetry?.lanes]);

  const nodesById = useMemo(
    () => new Map((telemetry?.nodes ?? []).map((node) => [node.id, node])),
    [telemetry?.nodes],
  );

  const selectedNode = nodesById.get(selectedId) ?? null;
  const selectedLane = telemetry?.lanes.find((lane) => lane.id === selectedId) ?? null;
  const selectedLaneMilestone = selectedLane ? laneMilestone(selectedLane) : null;
  const selectedLaneProgress = selectedLane ? stageProgress(selectedLane) : null;
  const selectedLiveLane = liveAccount?.lanes.find((lane) => lane.laneId === selectedLane?.id) ?? null;
  const selectedGuide = selectedNode ? PROCESS_GUIDES[selectedNode.id] : null;
  const newestAgeSec = lastReceivedAt === null ? Infinity : Math.round((Date.now() - lastReceivedAt) / 1000);
  const stale = newestAgeSec > (telemetry?.staleAfterSec ?? 30) || Boolean(error);
  const criticalCount = (telemetry?.nodes.filter((node) => node.health === 'CRITICAL').length ?? 0) +
    (telemetry?.lanes.filter((lane) => lane.health === 'CRITICAL').length ?? 0);
  const warningCount = (telemetry?.nodes.filter((node) => node.health === 'WARNING').length ?? 0) +
    (telemetry?.lanes.filter((lane) => lane.health === 'WARNING').length ?? 0);
  // Real paper P&L = HEADLINE only (realized + unrealized). Diagnostic probes are
  // measurement, never mirror to live, and are reported separately below.
  const paperRealPnl = telemetry
    ? telemetry.paper.headlinePnl + (telemetry.paper.headlineUnrealizedPnl ?? 0)
    : 0;
  const paperRealTone = paperRealPnl > 0 ? 'tone-healthy' : paperRealPnl < 0 ? 'tone-critical' : 'tone-measure';
  const paperTpAssessment = telemetry?.paper.openTpAssessment ?? paperControls?.cgWideTp.assessment ?? null;
  const activeTpPct = paperControls?.cgWideTp.activeTpPct ?? 3;
  const draftTpPct = Number(tpDraft);
  const draftNetAfterCostPct = Number.isFinite(draftTpPct)
    ? draftTpPct - (paperControls?.cgWideTp.roundTripCostPct ?? 0.22)
    : null;
  const canSaveTp = Number.isFinite(draftTpPct) && draftTpPct >= 0.05 && draftTpPct <= 10;
  const milestoneRows = useMemo(
    () => (telemetry?.lanes ?? []).map((lane) => ({ lane, milestone: laneMilestone(lane), progress: stageProgress(lane) })),
    [telemetry?.lanes],
  );
  const watchableThreshold = telemetry?.lanes.find((lane) => lane.oosThreshold > 0)?.oosThreshold ?? 10;

  const neuralEdges = useMemo(() => {
    if (!telemetry) return [];
    const laneEdges: Array<[string, string]> = [];
    for (const lane of telemetry.lanes) {
      laneEdges.push(['occupancy', lane.id], [lane.id, 'paper']);
    }
    return [...CORE_EDGES, ...laneEdges];
  }, [telemetry]);

  function positionOf(id: string): Point | null {
    return NODE_POSITIONS[id] ?? lanePositions.get(id) ?? null;
  }

  function healthOf(id: string): NeuralHealth {
    const lane = telemetry?.lanes.find((candidate) => candidate.id === id);
    if (lane) {
      const liveLane = liveAccount?.lanes.find((candidate) => candidate.laneId === lane.id);
      if (liveLane) {
        if (liveLane.unrealizedPnl > 0) return 'ACTIVE';
        if (liveLane.unrealizedPnl < 0) return 'CRITICAL';
        return 'COLLECTING';
      }
      return lane.health;
    }
    return nodesById.get(id)?.health ?? 'IDLE';
  }

  async function saveCgWideTp(nextValue: number | null) {
    try {
      setControlStatus('Saving CG WIDE TP...');
      const response = await fetch('/api/shadow/paper-controls/cg-wide-tp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cgWideTpPct: nextValue }),
      });
      const next = await response.json() as (PaperControls & { ok?: boolean; reason?: string });
      if (!response.ok || next.ok === false) throw new Error(next.reason ?? `Save failed (${response.status})`);
      setPaperControls(next);
      setTpDraft(next.cgWideTp.activeTpPct.toFixed(2));
      setControlStatus(nextValue === null
        ? 'CG WIDE TP reset to default 3.00%. New paper admissions use default target.'
        : `CG WIDE TP set to ${next.cgWideTp.activeTpPct.toFixed(2)}%. New paper admissions use this target.`);
      void loadTelemetry();
    } catch (nextError) {
      setControlStatus(nextError instanceof Error ? nextError.message : 'Unable to save TP control');
    }
  }

  async function captureDiagnosticProfit() {
    const confirm = window.prompt('Type CAPTURE_DIAG_PROFIT to close profitable diagnostic PAPER trades using Binance mark. This does not close live Binance positions.');
    if (confirm !== 'CAPTURE_DIAG_PROFIT') {
      setRealizeStatus('Cancelled. Diagnostic paper trades were not changed.');
      return;
    }
    try {
      setRealizeStatus('Capturing profitable diagnostic MTM using Binance mark...');
      const response = await fetch('/api/shadow/paper-controls/realize-open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm, mode: 'PROFITABLE_DIAGNOSTIC' }),
      });
      const result = await response.json() as {
        ok?: boolean;
        reason?: string;
        mode?: string;
        closed?: number;
        skipped?: number;
        skippedNonProfit?: number;
        realizedPnl?: number;
        realizedR?: number;
      };
      if (!response.ok || result.ok === false) throw new Error(result.reason ?? `Realize failed (${response.status})`);
      setRealizeStatus(
        `Captured ${result.closed ?? 0} profitable diagnostic trades: ${fmtUsdt(result.realizedPnl ?? 0)} / ${fmtR(result.realizedR ?? 0)}. Skipped ${result.skipped ?? 0} missing mark, ${result.skippedNonProfit ?? 0} not profitable.`,
      );
      void loadTelemetry();
    } catch (nextError) {
      setRealizeStatus(nextError instanceof Error ? nextError.message : 'Unable to capture diagnostic profit');
    }
  }

  async function flattenBinanceExchange() {
    const confirm = window.prompt('DANGER: type FLATTEN_BINANCE_ALL to cancel Binance USD-M orders and market-close ALL exchange positions.');
    if (confirm !== 'FLATTEN_BINANCE_ALL') {
      setRealizeStatus('Cancelled. Binance exchange positions were not changed.');
      return;
    }
    try {
      setRealizeStatus('Flattening Binance exchange positions...');
      const response = await fetch('/api/live/flatten-exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm, reason: 'dashboard operator flatten' }),
      });
      const result = await response.json() as {
        ok?: boolean;
        reason?: string;
        env?: string;
        flattened?: Array<{ symbol: string; quantity: number }>;
        canceledOrderSymbols?: string[];
        canceledAlgoSymbols?: string[];
        failed?: Array<{ symbol: string; action: string; reason: string }>;
      };
      if (!response.ok || result.ok === false) {
        const failures = result.failed?.map((item) => `${item.symbol}:${item.action}`).join(', ');
        throw new Error(result.reason ?? failures ?? `Flatten failed (${response.status})`);
      }
      setRealizeStatus(
        `Binance ${result.env ?? 'exchange'} flattened ${result.flattened?.length ?? 0} positions; canceled ${result.canceledOrderSymbols?.length ?? 0} order symbols and ${result.canceledAlgoSymbols?.length ?? 0} algo symbols. Kill-switch latched.`,
      );
      void loadLiveAccount();
      void loadTelemetry();
    } catch (nextError) {
      setRealizeStatus(nextError instanceof Error ? nextError.message : 'Unable to flatten Binance exchange');
      void loadLiveAccount();
    }
  }

  const selectedConnections = useMemo(() => {
    if (!telemetry || (!selectedNode && !selectedLane)) return { inputs: [] as string[], outputs: [] as string[] };
    const id = selectedNode?.id ?? selectedLane?.id ?? '';
    const edges = [
      ...CORE_EDGES,
      ...telemetry.lanes.flatMap((lane): Array<[string, string]> => [['occupancy', lane.id], [lane.id, 'paper']]),
    ];
    const labelOf = (nodeId: string) =>
      nodesById.get(nodeId)?.label ?? telemetry.lanes.find((lane) => lane.id === nodeId)?.label ?? nodeId;
    return {
      inputs: edges.filter(([, to]) => to === id).map(([from]) => labelOf(from)),
      outputs: edges.filter(([from]) => from === id).map(([, to]) => labelOf(to)),
    };
  }, [nodesById, selectedLane, selectedNode, telemetry]);

  return (
    <div className="neural-shell">
      <header className="neural-topbar">
        <div className="neural-brand">
          <span className={`neural-live-dot ${stale ? 'is-stale' : ''}`} />
          <div>
            <p>Kronos system intelligence</p>
            <h1>Neural Map</h1>
          </div>
        </div>
        <nav className="neural-nav" aria-label="Dashboard views">
          <button type="button" className="is-current">Neural Map</button>
        </nav>
        <div className="neural-actions">
          <label className="neural-toggle">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            <span />
            Live
          </label>
          <button type="button" className="neural-icon-button" title="Refresh telemetry" aria-label="Refresh telemetry" onClick={() => void loadTelemetry()}>
            ↻
          </button>
        </div>
      </header>

      <section className="neural-statusbar">
        <div>
          <span>Regime</span>
          <strong>{telemetry?.controller.regime ?? 'Connecting'}</strong>
          <small>{telemetry?.controller.mode ?? 'UNKNOWN'} / {telemetry?.controller.bias ?? 'UNKNOWN'}</small>
        </div>
        <div>
          <span>System pulse</span>
          <strong className={criticalCount > 0 ? 'tone-critical' : warningCount > 0 ? 'tone-warning' : 'tone-healthy'}>
            {criticalCount > 0 ? `${criticalCount} critical` : warningCount > 0 ? `${warningCount} degraded` : 'Nominal'}
          </strong>
          <small>{stale ? 'telemetry stale' : `updated ${new Date(telemetry?.generatedAt ?? Date.now()).toLocaleTimeString()}`}</small>
        </div>
        <div>
          <span>Paper P&amp;L (real)</span>
          <strong className={paperRealTone}>
            {telemetry ? `${fmtUsdt(paperRealPnl)} headline` : 'Loading'}
          </strong>
          <small>
            {telemetry
              ? `${telemetry.paper.open} open · meas ${fmtUsdt(telemetry.paper.diagnosticUnrealizedPnl)} (not real)`
              : 'paper only'}
          </small>
        </div>
        <div>
          <span>Binance unrealized PnL</span>
          <strong className={(liveAccount?.unrealizedPnl ?? 0) >= 0 ? 'tone-healthy' : 'tone-critical'}>
            {liveAccount ? `${liveAccount.unrealizedPnl >= 0 ? '+' : ''}${liveAccount.unrealizedPnl.toFixed(2)} USDT` : 'n/a'}
          </strong>
          <small>{liveAccount ? `${liveAccount.openPositionCount} positions / ${liveAccount.openOrderCount} exits` : 'testnet execution'}</small>
        </div>
        <div>
          <span>Binance equity</span>
          <strong>{liveAccount?.accountEquity != null ? `${liveAccount.accountEquity.toFixed(2)} USDT` : 'Loading'}</strong>
          <small>{liveAccount?.availableBalance != null ? `${liveAccount.availableBalance.toFixed(2)} available` : 'testnet'}</small>
        </div>
        <div>
          <span>Safety</span>
          <strong className="tone-healthy">Testnet mirror</strong>
          <small>{liveAccount ? `${liveAccount.openPositionCount} protected positions` : 'loading account'}</small>
        </div>
      </section>

      {error && (
        <div className="neural-error">
          <strong>Telemetry link interrupted</strong>
          <span>{error}. The last known state remains visible.</span>
        </div>
      )}

      <section className="neural-control-panel" aria-label="CG WIDE TP control">
        <div className={`neural-tp-verdict verdict-${paperTpAssessment?.verdict.toLowerCase().replace(/_/g, '-') ?? 'unknown'}`}>
          <span>CG WIDE TP assessment</span>
          <strong>{tpVerdictLabel(paperTpAssessment)}</strong>
          <p>{paperTpAssessment?.reason ?? 'Waiting for paper control telemetry.'}</p>
        </div>
        <div className="neural-tp-metrics">
          <div><span>Current TP</span><strong>{fmtPlainPct(activeTpPct)}</strong><small>{paperControls?.controls.cgWideTpPct === null ? 'default' : 'manual override'}</small></div>
          <div><span>Fee + slippage est.</span><strong>{fmtPlainPct(paperControls?.cgWideTp.roundTripCostPct ?? 0.22)}</strong><small>round trip estimate</small></div>
          <div><span>Net after cost</span><strong className={(paperTpAssessment?.netTpAfterCostPct ?? 0) >= 0 ? 'tone-healthy' : 'tone-critical'}>{fmtPlainPct(paperTpAssessment?.netTpAfterCostPct ?? null)}</strong><small>TP minus cost</small></div>
          <div><span>MFE p75 / p90</span><strong>{fmtPlainPct(telemetry?.paper.openP75MfePct ?? null)} / {fmtPlainPct(telemetry?.paper.openP90MfePct ?? null)}</strong><small>open paper excursion</small></div>
        </div>
        <div className="neural-tp-editor">
          <label>
            <span>Set future CG WIDE TP</span>
            <input
              type="range"
              min="0.05"
              max="10"
              step="0.05"
              value={Number.isFinite(draftTpPct) ? draftTpPct : activeTpPct}
              onChange={(event) => setTpDraft(Number(event.target.value).toFixed(2))}
            />
          </label>
          <div className="neural-tp-manual">
            <input
              type="number"
              min="0.05"
              max="10"
              step="0.05"
              inputMode="decimal"
              value={tpDraft}
              onChange={(event) => setTpDraft(event.target.value)}
              aria-label="Manual CG WIDE TP percent"
            />
            <button type="button" disabled={!canSaveTp} onClick={() => void saveCgWideTp(draftTpPct)}>Apply TP</button>
            <button type="button" className="is-secondary" onClick={() => void saveCgWideTp(null)}>Reset 3%</button>
          </div>
          <small>
            Draft net after cost: <b className={(draftNetAfterCostPct ?? 0) >= 0 ? 'tone-healthy' : 'tone-critical'}>{fmtPlainPct(draftNetAfterCostPct)}</b>.
            Applies to new CG WIDE paper admissions only.
          </small>
        </div>
        <div className="neural-realize-box">
          <button type="button" onClick={() => void captureDiagnosticProfit()}>Capture diag profit</button>
          <p>Closes only profitable diagnostic paper MTM using Binance mark. Non-profitable diagnostics stay open; live Binance positions are untouched.</p>
          <button type="button" className="is-exchange-danger" onClick={() => void flattenBinanceExchange()}>Close Binance exchange</button>
          <p>Cancels visible Binance USD-M orders and market reduce-only closes every exchange position. This latches the kill-switch.</p>
        </div>
        {(controlStatus || realizeStatus) && (
          <div className="neural-control-status">
            {controlStatus && <span>{controlStatus}</span>}
            {realizeStatus && <span>{realizeStatus}</span>}
          </div>
        )}
      </section>

      <section className="neural-milestone-panel" aria-label="Lane maturity thresholds">
        <div className="neural-milestone-summary">
          <span>Promotion ladder</span>
          <strong>Collecting → Paper evidence → Headline → Stable → Promotion</strong>
          <p>
            Runtime thresholds on VPS now: watchable/headline floor <b>{watchableThreshold}</b> fresh-valid,
            stable candidate <b>{STABLE_MIN_FRESH}</b>, promotion candidate <b>{PROMOTION_MIN_FRESH}</b>.
            The table below now shows both the raw telemetry status from the engine and the UI grouping,
            so it no longer looks like two different truths. Live exchange trading still needs live gate
            pass plus infra readiness.
          </p>
        </div>
        <div className="neural-milestone-grid">
          <div>
            <span>Collecting</span>
            <strong>{watchableThreshold} fresh-valid</strong>
            <small>Below this, lane is still collecting OOS.</small>
          </div>
          <div>
            <span>Headline ready</span>
            <strong>{watchableThreshold}+ / PF&gt;1.2 / net&gt;0</strong>
            <small>Plus `+10bps` stress pass and non-reject economics gate.</small>
          </div>
          <div>
            <span>Stable candidate</span>
            <strong>{STABLE_MIN_FRESH}+ OOS all positive</strong>
            <small>Also needs stronger payoff, net, PF, and drawdown shape.</small>
          </div>
          <div>
            <span>Live-ready gate</span>
            <strong>{PROMOTION_MIN_FRESH}+ infra pass</strong>
            <small>Promotion candidate alone is still not enough for real live trading.</small>
          </div>
        </div>
        <div className="neural-milestone-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Lane</th>
                <th>Telemetry</th>
                <th>UI Stage</th>
                <th>Next Stage</th>
                <th>Progress</th>
                <th>Fresh Valid</th>
                <th>Net Avg R</th>
                <th>PF</th>
                <th>Stats</th>
                <th>Missing</th>
              </tr>
            </thead>
            <tbody>
              {milestoneRows.map(({ lane, milestone, progress }) => (
                <tr key={`milestone-${lane.id}`} onClick={() => setSelectedId(lane.id)}>
                  <td>{compactLaneLabel(lane.label)}</td>
                  <td>{lane.status}</td>
                  <td><span className={`neural-stage-pill stage-${milestone.stage.toLowerCase()}`}>{stageLabel(milestone.stage)}</span></td>
                  <td>{progress.nextStage}</td>
                  <td>{progress.progressPct}%</td>
                  <td>{lane.oosFreshValid ?? lane.closed} / {lane.oosThreshold}</td>
                  <td className={(lane.netAvgR ?? 0) >= 0 ? 'tone-healthy' : 'tone-critical'}>{fmtR(lane.netAvgR)}</td>
                  <td>{fmtNumber(lane.pf)}</td>
                  <td>{lane.statsSource === 'VM_SIM' ? 'VM sim' : 'Paper book'}</td>
                  <td>{progress.blockers.slice(0, 2).join(' | ') || 'None'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <main className="neural-workspace">
        <section className="neural-canvas-panel" aria-label="Live bot neural system map">
          {loading && !telemetry ? (
            <div className="neural-loading"><span />Connecting to bot telemetry...</div>
          ) : (
            <div className="neural-canvas-scroll">
              <svg className="neural-map" viewBox="0 0 1380 760" role="img" aria-label="Animated neural map of bot inputs, controller, lanes, and paper execution">
                <defs>
                  <pattern id="neural-grid" width="36" height="36" patternUnits="userSpaceOnUse">
                    <path d="M 36 0 L 0 0 0 36" className="neural-grid-line" />
                  </pattern>
                </defs>
                <rect width="1380" height="760" fill="url(#neural-grid)" />
                <text x="65" y="60" className="neural-zone-label">INPUT LAYER</text>
                <text x="292" y="60" className="neural-zone-label">INFERENCE PIPELINE</text>
                <text x="655" y="60" className="neural-zone-label">DECISION CORE</text>
                <text x="1008" y="60" className="neural-zone-label">LANE FIELD</text>
                <text x="1190" y="60" className="neural-zone-label">TESTNET OUTPUT</text>

                <g className="neural-edges">
                  {neuralEdges.map(([fromId, toId], index) => {
                    const from = positionOf(fromId);
                    const to = positionOf(toId);
                    if (!from || !to) return null;
                    const sourceHealth = healthOf(fromId);
                    const targetHealth = healthOf(toId);
                    const health = healthRank(targetHealth) > healthRank(sourceHealth) ? targetHealth : sourceHealth;
                    const path = edgePath(from, to);
                    const flowing = nodesById.get(fromId)?.active || nodesById.get(toId)?.active ||
                      telemetry?.lanes.find((lane) => (lane.id === fromId || lane.id === toId) && lane.active);
                    return (
                      <g key={`${fromId}-${toId}`} className={`neural-edge health-${health.toLowerCase()} ${flowing ? 'is-flowing' : ''}`}>
                        <path d={path} className="neural-edge-base" />
                        <path d={path} className="neural-edge-signal" style={{ animationDelay: `${index * -0.19}s` }} />
                      </g>
                    );
                  })}
                </g>

                {(telemetry?.nodes ?? []).map((node) => {
                  const point = positionOf(node.id);
                  if (!point) return null;
                  const central = node.id === 'controller';
                  const nodeLabel = node.id === 'live-lock' && liveAccount ? 'Binance Testnet' : node.label;
                  const nodeMetric = node.id === 'live-lock' && liveAccount
                    ? `${liveAccount.openPositionCount} POSITIONS`
                    : node.metric;
                  return (
                    <g
                      key={node.id}
                      className={`neural-node health-${node.health.toLowerCase()} ${node.active ? 'is-active' : ''} ${selectedId === node.id ? 'is-selected' : ''}`}
                      transform={`translate(${point.x} ${point.y})`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${nodeLabel}: ${nodeMetric}`}
                      onClick={() => setSelectedId(node.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') setSelectedId(node.id);
                      }}
                    >
                      <circle className="neural-node-halo" r={central ? 62 : 48} />
                      <circle className="neural-node-core" r={central ? 48 : 38} />
                      <circle className="neural-node-pulse" r={central ? 53 : 43} />
                      <text y={central ? -5 : -4} className="neural-node-title">{nodeLabel}</text>
                      <text y={central ? 16 : 15} className="neural-node-metric">{nodeMetric.slice(0, 22)}</text>
                    </g>
                  );
                })}

                {(telemetry?.lanes ?? []).map((lane) => {
                  const point = lanePositions.get(lane.id);
                  if (!point) return null;
                  const displayHealth = healthOf(lane.id);
                  return (
                    <g
                      key={lane.id}
                      className={`neural-lane health-${displayHealth.toLowerCase()} ${lane.active ? 'is-active' : ''} ${selectedId === lane.id ? 'is-selected' : ''}`}
                      transform={`translate(${point.x} ${point.y})`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${lane.label}: ${lane.status}`}
                      onClick={() => setSelectedId(lane.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') setSelectedId(lane.id);
                      }}
                    >
                      <rect x="-80" y="-29" width="160" height="58" rx="5" className="neural-lane-body" />
                      <circle cx="-62" cy="0" r="5" className="neural-lane-led" />
                      <text x="-48" y="-5" className="neural-lane-title">{compactLaneLabel(lane.label)}</text>
                      <text x="-48" y="14" className="neural-lane-metric">
                        {laneMetricLabel(
                          lane,
                          liveAccount?.lanes.find((liveLane) => liveLane.laneId === lane.id),
                          liveAccount?.accountEquity,
                        )}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
          <div className="neural-legend">
            {(Object.keys(HEALTH_LABELS) as NeuralHealth[]).map((health) => (
              <span key={health}><i className={`health-${health.toLowerCase()}`} />{HEALTH_LABELS[health]}</span>
            ))}
          </div>
        </section>

        <aside className="neural-inspector">
          <div className="neural-inspector-heading">
            <span>{selectedLane ? 'Lane intelligence' : selectedNode?.kind ?? 'System node'}</span>
            <strong>{selectedLane?.label ?? selectedNode?.label ?? 'Select a node'}</strong>
            {(selectedLane || selectedNode) && (
              <em className={`health-${(selectedLane?.health ?? selectedNode?.health ?? 'IDLE').toLowerCase()}`}>
                {HEALTH_LABELS[selectedLane?.health ?? selectedNode?.health ?? 'IDLE']}
              </em>
            )}
          </div>

          {selectedNode && (
            <>
              <div className={`neural-diagnosis health-${selectedNode.health.toLowerCase()}`}>
                <span>Diagnosis</span>
                <strong>{selectedNode.diagnosisSummary}</strong>
                <p>{`Condition class: ${DIAGNOSIS_LABELS[selectedNode.diagnosisCategory]}`}</p>
              </div>
              <div className="neural-inspector-section">
                <h2>Live checks</h2>
                <dl>
                  <div><dt>Condition class</dt><dd>{DIAGNOSIS_LABELS[selectedNode.diagnosisCategory]}</dd></div>
                  <div><dt>Current state</dt><dd>{selectedNode.metric}</dd></div>
                  <div><dt>Flow</dt><dd>{selectedNode.active ? 'Active now' : 'Standby'}</dd></div>
                  {selectedNode.diagnosisFacts.map((detail, index) => (
                    <div key={`${detail}-${index}`}>
                      <dt>Check {index + 1}</dt>
                      <dd>{detail}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              {selectedGuide && (
                <>
                  <div className="neural-inspector-section">
                    <h2>What this node does</h2>
                    <p>{selectedGuide.purpose}</p>
                  </div>
                  <div className="neural-inspector-section">
                    <h2>Process trace</h2>
                    <ol className="neural-process-list">
                      {selectedGuide.steps.map((step, index) => (
                        <li key={step}><span>{index + 1}</span><p>{step}</p></li>
                      ))}
                    </ol>
                  </div>
                  <div className="neural-inspector-section">
                    <h2>Healthy condition</h2>
                    <p>{selectedGuide.healthyMeans}</p>
                  </div>
                  {(selectedNode.health === 'WARNING' || selectedNode.health === 'CRITICAL') && (
                    <div className="neural-inspector-section">
                      <h2>Inspect next</h2>
                      <ul className="neural-check-list">
                        {selectedGuide.inspectWhenBad.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {selectedLane && (
            <>
              <div className={`neural-diagnosis health-${selectedLane.health.toLowerCase()}`}>
                <span>Lane diagnosis</span>
                <strong>{selectedLiveLane ? 'Lane color follows Binance unrealized PnL.' : laneDiagnosis(selectedLane)}</strong>
                <p>Paper evidence remains separate; execution equity, exposure, and current PnL come from Binance testnet.</p>
              </div>
              {selectedLane.oosFreshValid !== null && (
                <div className="neural-inspector-section">
                  <h2>OOS maturity (this lane)</h2>
                  <dl>
                    <div>
                      <dt>Validated</dt>
                      <dd>{selectedLane.oosFreshValid} / {selectedLane.oosThreshold} fresh closes</dd>
                    </div>
                    <div>
                      <dt>Progress</dt>
                      <dd>
                        <div className="neural-oos-bar">
                          <div
                            className={`neural-oos-fill ${selectedLane.oosFreshValid >= selectedLane.oosThreshold ? 'is-complete' : ''}`}
                            style={{ width: `${Math.min(100, (selectedLane.oosFreshValid / Math.max(1, selectedLane.oosThreshold)) * 100).toFixed(1)}%` }}
                          />
                        </div>
                        {selectedLane.oosFreshValid >= selectedLane.oosThreshold
                          ? 'Mature — headline-eligible'
                          : `${Math.floor((selectedLane.oosFreshValid / Math.max(1, selectedLane.oosThreshold)) * 100)}% — still collecting (direction-agnostic geometry validation)`}
                      </dd>
                    </div>
                  </dl>
                </div>
              )}
              <div className="neural-inspector-section">
                <dl>
                  <div><dt>Evidence status</dt><dd>{selectedLane.status}</dd></div>
                  <div><dt>UI stage</dt><dd>{selectedLaneMilestone ? stageLabel(selectedLaneMilestone.stage) : 'n/a'}</dd></div>
                  <div><dt>Next stage</dt><dd>{selectedLaneProgress?.nextStage ?? 'n/a'}</dd></div>
                  <div><dt>Progress</dt><dd>{selectedLaneProgress ? `${selectedLaneProgress.progressPct}%` : 'n/a'}</dd></div>
                  <div><dt>Evidence health</dt><dd>{HEALTH_LABELS[selectedLane.evidenceHealth]}</dd></div>
                  <div><dt>Stats source</dt><dd>{selectedLane.statsSource === 'VM_SIM' ? 'Variant-matrix simulation' : 'Paper book'}</dd></div>
                  <div><dt>Open / closed</dt><dd>{selectedLane.open} / {selectedLane.closed}</dd></div>
                  <div><dt>Net Avg R</dt><dd className={(selectedLane.netAvgR ?? 0) >= 0 ? 'tone-healthy' : 'tone-critical'}>{fmtR(selectedLane.netAvgR)}</dd></div>
                  <div><dt>PF / WR</dt><dd>{fmtNumber(selectedLane.pf)} / {selectedLane.wr === null ? 'n/a' : `${(selectedLane.wr * 100).toFixed(1)}%`}</dd></div>
                  <div><dt>Payoff / +10bps</dt><dd>{fmtNumber(selectedLane.payoffRatio)} / {selectedLane.plus10bpsStillPositive == null ? 'n/a' : selectedLane.plus10bpsStillPositive ? 'pass' : 'fail'}</dd></div>
                  <div><dt>OOS thirds / regimes</dt><dd>{selectedLane.allThreeOosPositive == null ? 'n/a' : selectedLane.allThreeOosPositive ? 'all positive' : 'not yet'} / {selectedLane.distinctRegimes ?? 'n/a'}</dd></div>
                  <div><dt>Drawdown / concentration</dt><dd>{fmtR(selectedLane.approxMaxDrawdownR)} / {pctShare(selectedLane.topSymbolPnlShare)}</dd></div>
                  <div><dt>Calendar / infra</dt><dd>{selectedLane.calendarDays === null ? 'n/a' : `${selectedLane.calendarDays.toFixed(1)}d`} / {selectedLane.infraReady == null ? 'n/a' : selectedLane.infraReady ? 'ready' : 'not ready'}</dd></div>
                  <div><dt>Avg entry / mark</dt><dd>{fmtPrice(selectedLane.openAvgEntryPrice)} / {fmtPrice(selectedLane.openAvgMarkPrice)}</dd></div>
                  <div><dt>Avg TP / gap</dt><dd>{fmtPrice(selectedLane.openAvgTakeProfitPrice)} / {fmtGapPct(selectedLane.openAvgDistanceToTpPct)}</dd></div>
                  <div><dt>Nearest TP gap</dt><dd>{fmtGapPct(selectedLane.openNearestDistanceToTpPct)} across {selectedLane.openMarkedSymbolCount} symbols</dd></div>
                  <div><dt>MFE avg / p90</dt><dd>{fmtPlainPct(selectedLane.openAvgMfePct)} / {fmtPlainPct(selectedLane.openP90MfePct)}</dd></div>
                  <div><dt>TP quality</dt><dd>{tpVerdictLabel(selectedLane.openTpAssessment)} · TP {fmtPlainPct(selectedLane.openAvgConfiguredTpPct)}</dd></div>
                  <div><dt>Headline PnL (real)</dt><dd className={(() => { const v = selectedLane.headlinePnl + (selectedLane.headlineUnrealizedPnl ?? 0); return v > 0 ? 'tone-healthy' : v < 0 ? 'tone-critical' : 'tone-measure'; })()}>{fmtUsdt(selectedLane.headlinePnl + (selectedLane.headlineUnrealizedPnl ?? 0))} / {fmtR((selectedLane.netAvgR ?? 0) === 0 && selectedLane.closed === 0 ? null : selectedLane.headlineUnrealizedR)}{selectedLane.pnlIsDiagnosticOnly ? ' · flat (no real trades yet)' : ''}</dd></div>
                  <div><dt>Paper evidence PnL</dt><dd className={selectedLane.pnlIsDiagnosticOnly ? 'tone-measure' : undefined}>{fmtMoney(selectedLane.totalPnl)}{selectedLane.pnlIsDiagnosticOnly ? ' · diagnostic' : ''}</dd></div>
                  <div><dt>Diagnostic open MTM <small>(measurement)</small></dt><dd className="tone-measure">{fmtUsdt(selectedLane.diagnosticUnrealizedPnl)} / {fmtR(selectedLane.diagnosticUnrealizedR)}</dd></div>
                  <div><dt>Max favorable open</dt><dd className="tone-measure">{fmtUsdt(selectedLane.openMaxFavorablePnl)} / {fmtR(selectedLane.openMaxFavorableR)}</dd></div>
                  <div><dt>All open MTM</dt><dd className={selectedLane.pnlIsDiagnosticOnly ? 'tone-measure' : (selectedLane.openUnrealizedPnl ?? 0) >= 0 ? 'tone-healthy' : 'tone-critical'}>{fmtUsdt(selectedLane.openUnrealizedPnl)} / {fmtR(selectedLane.openUnrealizedR)}</dd></div>
                  <div><dt>Binance mirrored</dt><dd>{selectedLiveLane ? `${selectedLiveLane.sourceOrderCount} orders / ${selectedLiveLane.symbols.length} symbols` : 'not open'}</dd></div>
                  <div><dt>Binance notional</dt><dd>{selectedLiveLane ? `${selectedLiveLane.notionalUsd.toFixed(2)} USDT` : '0.00 USDT'}</dd></div>
                  <div><dt>Binance unrealized</dt><dd className={(selectedLiveLane?.unrealizedPnl ?? 0) >= 0 ? 'tone-healthy' : 'tone-critical'}>{selectedLiveLane ? `${selectedLiveLane.unrealizedPnl >= 0 ? '+' : ''}${selectedLiveLane.unrealizedPnl.toFixed(2)} USDT` : '0.00 USDT'}</dd></div>
                  <div><dt>Account equity</dt><dd>{liveAccount?.accountEquity != null ? `${liveAccount.accountEquity.toFixed(2)} USDT` : 'n/a'}</dd></div>
                </dl>
              </div>
              <div className="neural-inspector-section">
                <h2>Why this state</h2>
                <p>{selectedLane.reason}</p>
                {selectedLaneMilestone && <p>{selectedLaneMilestone.reason}</p>}
              </div>
              {selectedLaneProgress && (
                <div className="neural-inspector-section">
                  <h2>Next stage blockers</h2>
                  <p>{selectedLaneProgress.nextStage} is currently {selectedLaneProgress.progressPct}% complete.</p>
                  <ul className="neural-check-list">
                    {(selectedLaneProgress.blockers.length > 0 ? selectedLaneProgress.blockers : ['No blocker currently visible in telemetry.']).map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
              )}
              <div className="neural-inspector-section">
                <h2>Lane process</h2>
                <ol className="neural-process-list">
                  <li><span>1</span><p>Candidate qualifies for this lane geometry.</p></li>
                  <li><span>2</span><p>Router and occupancy admission evaluate the signal.</p></li>
                  <li><span>3</span><p>Eligible paper orders receive lane metadata and risk sizing.</p></li>
                  <li><span>4</span><p>Closed outcomes update lane evidence and paper PnL separately.</p></li>
                </ol>
              </div>
            </>
          )}

          {(selectedNode || selectedLane) && (
            <div className="neural-inspector-section">
              <h2>Connections</h2>
              <dl>
                <div><dt>Receives from</dt><dd>{selectedConnections.inputs.join(', ') || 'External state'}</dd></div>
                <div><dt>Sends to</dt><dd>{selectedConnections.outputs.join(', ') || 'Operator telemetry'}</dd></div>
              </dl>
            </div>
          )}

          {telemetry && telemetry.mixed.oosThreshold > 0 && (
            <div className="neural-inspector-section">
              <h2>Mixed-regime OOS guardrail</h2>
              <p className="neural-section-note">Only accrues during a <strong>Mixed</strong> regime. 0 here while the regime is Bullish/Bearish is expected — per-lane geometry maturity is the meter above.</p>
              <dl>
                <div>
                  <dt>Collected</dt>
                  <dd>{telemetry.mixed.oosCount} / {telemetry.mixed.oosThreshold} trades</dd>
                </div>
                <div>
                  <dt>Progress</dt>
                  <dd>
                    <div className="neural-oos-bar">
                      <div
                        className={`neural-oos-fill ${telemetry.mixed.oosCount >= telemetry.mixed.oosThreshold ? 'is-complete' : ''}`}
                        style={{ width: `${Math.min(100, (telemetry.mixed.oosCount / telemetry.mixed.oosThreshold) * 100).toFixed(1)}%` }}
                      />
                    </div>
                    <span className="neural-oos-pct">
                      {telemetry.mixed.oosCount >= telemetry.mixed.oosThreshold
                        ? 'Ready'
                        : `${Math.floor((telemetry.mixed.oosCount / telemetry.mixed.oosThreshold) * 100)}%`}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{telemetry.mixed.guardrailStatus}</dd>
                </div>
              </dl>
            </div>
          )}

          <div className="neural-inspector-section">
            <h2>Controller decision</h2>
            <dl>
              <div><dt>Long / short</dt><dd>{telemetry?.controller.allowsLong ? 'ON' : 'OFF'} / {telemetry?.controller.allowsShort ? 'ON' : 'OFF'}</dd></div>
              <div><dt>New entries</dt><dd>{telemetry?.controller.allowsNewEntries ? 'Allowed' : 'Controlled'}</dd></div>
              <div><dt>Mixed admission</dt><dd>{telemetry?.mixed.admission ?? 'n/a'}</dd></div>
              <div><dt>Budget</dt><dd>{telemetry?.mixed.budgetProfile ?? 'n/a'}</dd></div>
            </dl>
          </div>

          <div className="neural-inspector-section">
            <h2>Scan latency</h2>
            <dl>
              <div><dt>Total</dt><dd>{fmtMs(telemetry?.scan.totalMs ?? null)}</dd></div>
              <div><dt>Slowest stage</dt><dd>{telemetry?.scan.slowestStage ?? 'n/a'} {fmtMs(telemetry?.scan.slowestStageMs ?? null)}</dd></div>
              <div><dt>Timeout symbols</dt><dd>{telemetry?.scan.timeoutSymbols ?? 0}</dd></div>
              <div><dt>Queue lag</dt><dd>{telemetry?.scan.backgroundLagSec == null ? 'n/a' : `${telemetry.scan.backgroundLagSec.toFixed(0)}s`}</dd></div>
            </dl>
          </div>
        </aside>
      </main>

      <section className="neural-bottom-grid">
        <div className="neural-alerts">
          <header><span>Active diagnostics</span><strong>{telemetry?.alerts.length ?? 0}</strong></header>
          {(telemetry?.alerts.length ?? 0) === 0 ? (
            <p className="neural-all-clear">No critical telemetry alerts. Evidence collection states can still require attention.</p>
          ) : telemetry?.alerts.slice(0, 6).map((alert, index) => (
            <button key={`${alert.source}-${index}`} type="button" onClick={() => {
              const match = telemetry.nodes.find((node) => node.label === alert.source);
              if (match) setSelectedId(match.id);
            }}>
              <i className={`health-${alert.severity.toLowerCase()}`} />
              <span><strong>{alert.source}</strong>{alert.message}</span>
            </button>
          ))}
        </div>

        <div className="neural-lane-strip">
          <header><span>Lane performance field</span><strong>{telemetry?.lanes.length ?? 0} lanes</strong></header>
          <div className="neural-lane-table-wrap">
            <table>
              <thead><tr><th>Lane</th><th>Evidence</th><th>TP Gap</th><th>Diag MTM</th><th>MFE</th><th>Binance PnL</th><th>Growth</th><th>Mirrored</th><th>n</th><th>Net Avg R</th><th>PF</th><th>WR</th></tr></thead>
              <tbody>
                {telemetry?.lanes.map((lane) => {
                  const liveLane = liveAccount?.lanes.find((item) => item.laneId === lane.id);
                  const livePnl = liveLane?.unrealizedPnl ?? 0;
                  const liveGrowth = liveAccount?.accountEquity && liveAccount.accountEquity > 0
                    ? (livePnl / liveAccount.accountEquity) * 100
                    : null;
                  return (
                    <tr key={lane.id} className={lane.active ? 'is-active' : ''} onClick={() => setSelectedId(lane.id)}>
                      <td><i className={`health-${healthOf(lane.id).toLowerCase()}`} />{compactLaneLabel(lane.label)}</td>
                      <td>{lane.status}</td>
                      <td>{fmtGapPct(lane.openAvgDistanceToTpPct)}</td>
                      <td className="tone-measure">{fmtUsdt(lane.diagnosticUnrealizedPnl)}</td>
                      <td className="tone-measure">{fmtUsdt(lane.openMaxFavorablePnl)}</td>
                      <td className={livePnl >= 0 ? 'tone-healthy' : 'tone-critical'}>{`${livePnl >= 0 ? '+' : ''}${livePnl.toFixed(2)} USDT`}</td>
                      <td className={livePnl >= 0 ? 'tone-healthy' : 'tone-critical'}>{fmtPct(liveGrowth)}</td>
                      <td>{liveLane?.sourceOrderCount ?? 0}</td>
                      <td>{lane.closed}</td>
                      <td>{fmtR(lane.netAvgR)}</td>
                      <td>{fmtNumber(lane.pf)}</td>
                      <td>{lane.wr === null ? 'n/a' : `${(lane.wr * 100).toFixed(1)}%`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
