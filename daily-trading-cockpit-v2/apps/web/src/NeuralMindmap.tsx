import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import './neural-mindmap.css';

const TELEMETRY_TIMEOUT_MS = 15_000;

type NeuralHealth = 'HEALTHY' | 'ACTIVE' | 'WARNING' | 'CRITICAL' | 'IDLE' | 'COLLECTING' | 'QUARANTINE' | 'DIAGNOSTIC';
type LaneMaturitySectionKey = 'LONG' | 'SHORT' | 'MULTI' | 'REGIME';
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

interface LaneCohortStats {
  n: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  payoffRatio: number | null;
}

interface RotationShortlistSymbol {
  symbol: string;
  n: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  score: number;
  verdict: 'ALLOW' | 'WATCH' | 'BLOCK';
  reason: string;
}

interface NeuralProvenSymbol {
  symbol: string;
  tier: 'LIVE_READY' | 'TESTNET_ONLY';
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
  statsSource: 'VM_SIM' | 'PAPER_BOOK' | 'H6_RESEARCH' | 'REGIME_DIAGNOSTIC';
  cohorts?: {
    LONG: LaneCohortStats | null;
    SHORT: LaneCohortStats | null;
    MIXED: LaneCohortStats | null;
    BULLISH?: LaneCohortStats | null;
    BEARISH?: LaneCohortStats | null;
    LONG_BULLISH?: LaneCohortStats | null;
    SHORT_BEARISH?: LaneCohortStats | null;
    LONG_MIXED?: LaneCohortStats | null;
    SHORT_MIXED?: LaneCohortStats | null;
  };
  /**
   * Symbols where this lane's realized book is currently proven positive, tagged by tier:
   * LIVE_READY = headline-confirmed (real money-grade), TESTNET_ONLY = book-positive but not yet.
   */
  provenSymbols?: NeuralProvenSymbol[];
  rotationShortlist?: {
    bearish: RotationShortlistSymbol[];
    bullish: RotationShortlistSymbol[];
  };
  payoffRatio: number | null;
  plus10bpsStillPositive: boolean | null;
  allThreeOosPositive: boolean | null;
  oosThirds: [number | null, number | null, number | null] | null;
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

interface LaneMaturitySection {
  key: LaneMaturitySectionKey;
  label: string;
  detail: string;
  lanes: NeuralLane[];
}

const LANE_MATURITY_SECTION_ORDER: LaneMaturitySectionKey[] = ['LONG', 'SHORT', 'MULTI', 'REGIME'];
const LANE_MATURITY_SECTION_META: Record<LaneMaturitySectionKey, { label: string; detail: string }> = {
  LONG: {
    label: 'LONG direction lanes',
    detail: 'Direction axis: buy-side / bullish continuation / long-only diagnostics',
  },
  SHORT: {
    label: 'SHORT direction lanes',
    detail: 'Direction axis: sell-side / fade-short / short-only diagnostics',
  },
  MULTI: {
    label: 'MULTI-context geometry lanes',
    detail: 'Same geometry can be measured in LONG, SHORT, and MIXED contexts; pick by the cohort columns, not by prefix',
  },
  REGIME: {
    label: 'REGIME-specific lanes',
    detail: 'Regime axis: choppy/mixed lanes only; this is not a third trade direction',
  },
};

function laneMaturitySection(lane: NeuralLane): LaneMaturitySectionKey {
  const id = lane.id.toUpperCase();
  const label = lane.label.toUpperCase();
  if (id.includes('MIXED') || label.includes('MIXED')) {
    return 'REGIME';
  }
  if (
    id.startsWith('CG_LONG_VARIANT_MATRIX:') ||
    id.includes('H6_TREND') ||
    label.includes(' LONG') ||
    label.startsWith('LONG ') ||
    label.includes('BULL')
  ) {
    return 'LONG';
  }
  if (id.startsWith('CG_VARIANT_MATRIX:') && !label.includes(' SHORT') && !id.includes('EXP_SHORT') && !id.includes('WIDE_FAST_SHORT')) {
    return 'MULTI';
  }
  return 'SHORT';
}

function groupLanesByMaturitySection(lanes: NeuralLane[]): LaneMaturitySection[] {
  return LANE_MATURITY_SECTION_ORDER.map((key) => {
    const meta = LANE_MATURITY_SECTION_META[key];
    return {
      key,
      label: meta.label,
      detail: meta.detail,
      lanes: lanes.filter((lane) => laneMaturitySection(lane) === key),
    };
  }).filter((section) => section.lanes.length > 0);
}

function statsSourceLongLabel(source: NeuralLane['statsSource']): string {
  if (source === 'VM_SIM') return 'Variant-matrix simulation';
  if (source === 'H6_RESEARCH') return 'H6 trend research';
  if (source === 'REGIME_DIAGNOSTIC') return 'Diagnostic orders grouped by regime';
  return 'Paper book';
}

interface DiagnosticDirectionStats {
  closed: number;
  open: number;
  realizedPnl: number;
  unrealizedPnl: number | null;
  netAvgR: number | null;
  wr: number | null;
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
    diagnosticByDirection: {
      LONG: DiagnosticDirectionStats;
      SHORT: DiagnosticDirectionStats;
    };
    diagnosticByRegime?: {
      MIXED: DiagnosticDirectionStats;
    };
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
  fadeLong: {
    freshValid: number;
    open: number;
    expired: number;
    oosThreshold: number;
    status: 'COLLECTING' | 'WATCHABLE';
    netAvgR: number | null;
    grossAvgR: number | null;
    pf: number | null;
    wr: number | null;
    totalNetR: number;
    antiCrash: {
      tagged: number;
      wouldBlock: number;
      pass: number;
      blockedClosed: number;
      blockedNetAvgR: number | null;
      blockedWR: number | null;
      passClosed: number;
      passNetAvgR: number | null;
      passWR: number | null;
      latest: {
        universeCount: number;
        down15mPct: number | null;
        down1hPct: number | null;
        median15mReturnPct: number | null;
        median1hReturnPct: number | null;
        btc1hReturnPct: number | null;
        eth1hReturnPct: number | null;
        freshSignalCluster: number;
        wouldBlock: boolean;
        reasons: string[];
      } | null;
    };
  } | null;
  h6Trend: {
    freshValid: number;
    open: number;
    expired: number;
    oosThreshold: number;
    status: 'COLLECTING' | 'WATCHABLE';
    netAvgR: number | null;
    grossAvgR: number | null;
    pf: number | null;
    wr: number | null;
    avgMaxFavorableR: number | null;
    tp1HitRate: number | null;
    totalNetR: number;
    entryPolicy: { name: string; required: string[]; sourceOptional: string[] };
    exitPolicy: { tp1R: number; tp1ExitPct: number; breakevenAfterTp1: true; runner: string };
    tight: { freshValid: number; netAvgR: number | null; pf: number | null; wr: number | null; avgMaxFavorableR: number | null; tp1HitRate: number | null };
    tightLargeCap: { freshValid: number; netAvgR: number | null; pf: number | null; wr: number | null; avgMaxFavorableR: number | null; tp1HitRate: number | null };
  } | null;
  alerts: Array<{ severity: 'WARNING' | 'CRITICAL'; source: string; message: string }>;
}

interface Point {
  x: number;
  y: number;
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

function compactLaneLabel(label: string): string {
  return label.slice(0, 24);
}

function fmtNumber(value: number | null, digits = 2): string {
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (value === null || !Number.isFinite(value)) return 'n/a';
  if (value >= 999_999) return 'inf';
  return value.toFixed(digits);
}

function fmtR(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}R`;
}

function fmtCohort(cohort: LaneCohortStats | null | undefined): string {
  if (!cohort || cohort.n <= 0) return 'n/a';
  const wr = cohort.wr === null || !Number.isFinite(cohort.wr) ? '—' : `${Math.round(cohort.wr * 100)}%`;
  return `${cohort.n} · ${fmtR(cohort.netAvgR)} · PF ${fmtNumber(cohort.pf)} · ${wr}`;
}

function cohortTone(cohort: LaneCohortStats | null | undefined): string {
  if (!cohort || cohort.n <= 0 || cohort.netAvgR === null || !Number.isFinite(cohort.netAvgR)) return 'tone-measure';
  return cohort.netAvgR >= 0 ? 'tone-healthy' : 'tone-critical';
}

// The lane's REALIZED (paper-book) economics — the number that actually drives the
// bench/quarantine, as opposed to the idealized VM-sim cohort above. Surfacing both
// side by side is why a "BENCHED" lane can show a green sim number and a red book number.
function fmtBook(lane: NeuralLane): string {
  if (lane.netAvgR === null || !Number.isFinite(lane.netAvgR)) return 'book n/a';
  const pf = lane.pf !== null && Number.isFinite(lane.pf) ? ` · PF ${fmtNumber(lane.pf)}` : '';
  const cl = lane.closed !== null && lane.closed !== undefined ? ` · ${lane.closed}cl` : '';
  return `book ${fmtR(lane.netAvgR)}${cl}${pf}`;
}
function renderProvenSymbols(symbols: NeuralProvenSymbol[] | undefined) {
  if (!symbols || symbols.length === 0) {
    return <small className="neural-decision-symbols">Symbols: none proven yet (book-negative or insufficient data)</small>;
  }
  const sorted = [...symbols].sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'LIVE_READY' ? -1 : 1));
  return (
    <small className="neural-decision-symbols">
      Symbols:{' '}
      {sorted.map((s) => (
        <span
          key={s.symbol}
          className={`neural-symbol-badge ${s.tier === 'LIVE_READY' ? 'tier-live-ready' : 'tier-testnet-only'}`}
          title={s.tier === 'LIVE_READY' ? 'Headline-confirmed — real-money grade, gates LIVE admission' : 'Book-positive on the diagnostic sleeve — gates TESTNET admission only, not yet live-ready'}
        >
          {s.symbol.replace(/USDT$/, '')}
          {s.tier === 'LIVE_READY' ? ' ✓' : ''}
        </span>
      ))}
    </small>
  );
}
function bookTone(lane: NeuralLane): string {
  if (lane.netAvgR === null || !Number.isFinite(lane.netAvgR)) return 'tone-measure';
  return lane.netAvgR >= 0 ? 'tone-healthy' : 'tone-critical';
}

interface LaneContextInfo {
  cohort: LaneCohortStats | null;
  source: string;
  secondary: string;
}

interface LaneDecisionContext {
  key: 'LONG_BULLISH' | 'SHORT_BEARISH' | 'MIXED';
  title: string;
  subtitle: string;
  tone: 'long' | 'short' | 'mixed';
}

interface LaneDecisionRow {
  lane: NeuralLane;
  cohort: LaneCohortStats | null;
  source: string;
  secondary: string;
  verdict: string;
  tone: 'healthy' | 'warning' | 'critical' | 'blocked' | 'measure';
  score: number;
}

const LANE_DECISION_CONTEXTS: LaneDecisionContext[] = [
  {
    key: 'LONG_BULLISH',
    title: 'LONG / bullish',
    subtitle: 'Use when controller allows LONG and regime family is bullish/expansion.',
    tone: 'long',
  },
  {
    key: 'SHORT_BEARISH',
    title: 'SHORT / bearish',
    subtitle: 'Use when controller allows SHORT and regime family is bearish/pressure.',
    tone: 'short',
  },
  {
    key: 'MIXED',
    title: 'MIXED / choppy',
    subtitle: 'Use when market is range/rotation; mixed is a regime subset, not a third direction.',
    tone: 'mixed',
  },
];

function miniCohort(cohort: LaneCohortStats | null | undefined): string {
  if (!cohort || cohort.n <= 0) return 'n/a';
  return `${cohort.n} · ${fmtR(cohort.netAvgR)} · PF ${fmtNumber(cohort.pf)}`;
}

function cohortForDecision(lane: NeuralLane, context: LaneDecisionContext['key']): LaneContextInfo {
  const cohorts = lane.cohorts;
  if (context === 'LONG_BULLISH') {
    const exact = cohorts?.LONG_BULLISH ?? null;
    return {
      cohort: exact ?? cohorts?.LONG ?? null,
      source: exact ? 'exact LONG+BULLISH' : 'fallback LONG direction',
      secondary: `bullish family ${miniCohort(cohorts?.BULLISH)}`,
    };
  }
  if (context === 'SHORT_BEARISH') {
    const exact = cohorts?.SHORT_BEARISH ?? null;
    return {
      cohort: exact ?? cohorts?.SHORT ?? null,
      source: exact ? 'exact SHORT+BEARISH' : 'fallback SHORT direction',
      secondary: `bearish family ${miniCohort(cohorts?.BEARISH)}`,
    };
  }
  return {
    cohort: cohorts?.MIXED ?? null,
    source: 'regime-family MIXED',
    secondary: `L-mix ${miniCohort(cohorts?.LONG_MIXED)} · S-mix ${miniCohort(cohorts?.SHORT_MIXED)}`,
  };
}

function laneContextVerdict(lane: NeuralLane, cohort: LaneCohortStats | null): Pick<LaneDecisionRow, 'verdict' | 'tone' | 'score'> {
  const blocked = isQuarantinedLane(lane);
  if (!cohort || cohort.n <= 0 || cohort.netAvgR === null || !Number.isFinite(cohort.netAvgR)) {
    return { verdict: blocked ? 'BLOCKED / NO DATA' : 'NO DATA', tone: blocked ? 'blocked' : 'measure', score: blocked ? -20 : -10 };
  }
  const pf = cohort.pf ?? 0;
  const wr = cohort.wr ?? 0;
  const net = cohort.netAvgR;
  const sampleScore = Math.min(2, Math.log10(Math.max(1, cohort.n)));
  const economicsScore = Math.max(-2, Math.min(5, net * 10)) + Math.min(3, Math.max(0, pf)) + wr + sampleScore;
  const proven = cohort.n >= STABLE_MIN_FRESH && net > 0.05 && (pf > HEADLINE_PF_FLOOR || pf >= 999_999);
  const watch = cohort.n >= 10 && net > 0 && (pf > 1 || pf >= 999_999);
  if (blocked && (proven || watch)) {
    // The VM-sim cohort looks positive, but the lane is benched by its REALIZED (paper-book)
    // economics. "BENCHED" (not "BLOCKED EDGE") + the book number rendered alongside makes it
    // obvious this is a sim-only edge that lost money realistically — not a good edge unfairly blocked.
    return { verdict: 'BENCHED', tone: 'blocked', score: 90 + economicsScore };
  }
  if (blocked) return { verdict: 'BLOCKED', tone: 'blocked', score: 10 + economicsScore };
  if (proven) return { verdict: 'PROVEN', tone: 'healthy', score: 100 + economicsScore };
  if (watch) return { verdict: 'WATCH', tone: 'warning', score: 60 + economicsScore };
  return { verdict: net > 0 ? 'EARLY' : 'NO EDGE', tone: net > 0 ? 'measure' : 'critical', score: economicsScore };
}

function laneDecisionRows(lanes: NeuralLane[], context: LaneDecisionContext['key']): LaneDecisionRow[] {
  return lanes
    .map((lane) => {
      const info = cohortForDecision(lane, context);
      const verdict = laneContextVerdict(lane, info.cohort);
      const hasProvenSymbols = (lane.provenSymbols?.length ?? 0) > 0;
      // The lane's BLANKET (sim) verdict can be negative/blocked while specific symbols are
      // realized-book proven (exactly why lane-symbol-curation exists — CG_WIDE_FAST_SHORT is
      // aggregate-negative but LINK/BTC/SEI are individually positive). Don't let a bad blanket
      // verdict hide a lane that has real per-symbol proof; surface it distinctly instead.
      const rescued = hasProvenSymbols && verdict.tone !== 'healthy' && verdict.tone !== 'warning';
      return {
        lane,
        cohort: info.cohort,
        source: info.source,
        secondary: info.secondary,
        ...(rescued ? { verdict: 'SYMBOL PROVEN', tone: 'warning' as const, score: 50 } : verdict),
      };
    })
    // Only PROVEN / WATCH / SYMBOL PROVEN (positive-edge verdicts) — BLOCKED, BENCHED, NO EDGE,
    // NO DATA and EARLY are noise here; they're still visible in the full Lane maturity table below.
    .filter((row) => row.tone === 'healthy' || row.tone === 'warning')
    .sort((a, b) => b.score - a.score || (b.cohort?.n ?? 0) - (a.cohort?.n ?? 0))
    .slice(0, 5);
}

function bestContextLabel(lane: NeuralLane): string {
  const candidates = LANE_DECISION_CONTEXTS.map((context) => {
    const info = cohortForDecision(lane, context.key);
    const verdict = laneContextVerdict(lane, info.cohort);
    return { context, info, verdict };
  }).filter((item) => item.info.cohort && item.info.cohort.n > 0);
  if (candidates.length === 0) return 'No cohort yet';
  candidates.sort((a, b) => b.verdict.score - a.verdict.score);
  const best = candidates[0]!;
  return `${best.context.title} · ${best.verdict.verdict}`;
}

function rotationShortlistItems(items: RotationShortlistSymbol[] | null | undefined): RotationShortlistSymbol[] {
  if (!items || items.length === 0) return [];
  const actionable = items.filter((item) => item.verdict !== 'BLOCK');
  return (actionable.length > 0 ? actionable : items).slice(0, 4);
}

function rotationShortlistText(items: RotationShortlistSymbol[] | null | undefined): string {
  const visible = rotationShortlistItems(items);
  if (visible.length === 0) return 'n/a';
  return visible.map((item) => `${item.symbol} ${fmtR(item.netAvgR)}`).join(' · ');
}

function renderRotationShortlist(items: RotationShortlistSymbol[] | null | undefined) {
  const visible = rotationShortlistItems(items);
  if (visible.length === 0) return <span className="rotation-empty">n/a</span>;
  return (
    <div className="rotation-shortlist">
      {visible.map((item) => (
        <span className={`rotation-chip verdict-${item.verdict.toLowerCase()}`} title={item.reason} key={`${item.symbol}-${item.verdict}`}>
          <b>{item.symbol}</b>
          <em>{fmtR(item.netAvgR)}</em>
          <small>{item.n}</small>
        </span>
      ))}
    </div>
  );
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

function laneDiagnosis(lane: NeuralLane): string {
  if (lane.statsSource === 'H6_RESEARCH') {
    return 'H6 trend-continuation is a report-only research lane. It measures R-based evidence and gate quality, but it does not create paper/live orders yet.';
  }
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
  if (lane.statsSource === 'H6_RESEARCH') {
    return `${fmtR(lane.netAvgR)} / n=${lane.closed}`;
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

const STABLE_MIN_FRESH = 100;
const PROMOTION_MIN_FRESH = 200;
const HEADLINE_PF_FLOOR = 1.2;
// Mirrors the backend gate floors (current-guard-variant-matrix.ts PAYOFF_WATCH/PAYOFF_AUTHORIZE,
// default 0.3). It was hardcoded 0.75 here — stricter than the real gate — so lanes the backend
// promotes showed a FALSE red "payoff" blocker. Keep in sync with the backend default.
const PAYOFF_FLOOR = 0.3;
// Mirrors the backend DRAWDOWN_R_TO_CUM_SHARE (0.3): the drawdown cap scales with a lane's banked
// cumulative R, so a proven lane isn't permanently benched by the monotonic all-time max drawdown.
const DRAWDOWN_R_TO_CUM_SHARE = 0.3;
function drawdownCapR(lane: NeuralLane): number {
  const cumR = (lane.netAvgR ?? 0) * (lane.oosFreshValid ?? 0);
  return Math.max(5, DRAWDOWN_R_TO_CUM_SHARE * cumR);
}

function stageLabel(stage: MilestoneStage): string {
  if (stage === 'PROMOTION_CANDIDATE') return 'Promotion candidate';
  if (stage === 'STABLE_CANDIDATE') return 'Stable candidate';
  if (stage === 'HEADLINE_ACTIVE') return 'Headline active';
  if (stage === 'HEADLINE_READY') return 'Headline ready';
  if (stage === 'PAPER_EVIDENCE') return 'Paper evidence';
  return 'Collecting';
}

function evidencePillClass(lane: NeuralLane, milestone?: { stage: MilestoneStage }): string {
  if (lane.health === 'QUARANTINE' || lane.status.toUpperCase().includes('QUARANTIN')) {
    return 'stage-quarantined';
  }
  return `stage-${(milestone ?? laneMilestone(lane)).stage.toLowerCase()}`;
}

function isQuarantinedLane(lane: NeuralLane): boolean {
  return lane.health === 'QUARANTINE' || lane.status.toUpperCase().includes('QUARANTIN');
}

function laneMilestone(lane: NeuralLane): { stage: MilestoneStage; reason: string } {
  const watchableMin = lane.oosThreshold > 0 ? lane.oosThreshold : 10;
  const freshValid = lane.oosFreshValid ?? lane.closed;
  const status = lane.status.toUpperCase();
  if (isPaperBookOnlyLane(lane) && paperBookClearsHeadline(lane)) {
    if (lane.active) {
      return {
        stage: 'HEADLINE_ACTIVE',
        reason: `Paper-book lane clears headline floor: fresh-valid ${freshValid}/${watchableMin}, net ${fmtR(lane.netAvgR)}, PF ${fmtNumber(lane.pf)}.`,
      };
    }
    return {
      stage: 'HEADLINE_READY',
      reason: `Paper-book lane clears headline floor: fresh-valid ${freshValid}/${watchableMin}, net ${fmtR(lane.netAvgR)}, PF ${fmtNumber(lane.pf)}.`,
    };
  }
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

function isPaperBookOnlyLane(lane: NeuralLane): boolean {
  return lane.statsSource === 'PAPER_BOOK' && lane.oosFreshValid === null;
}

function paperBookClearsHeadline(lane: NeuralLane): boolean {
  const freshValid = lane.closed;
  const watchableMin = lane.oosThreshold > 0 ? lane.oosThreshold : 10;
  return freshValid >= watchableMin &&
    (lane.netAvgR ?? Number.NEGATIVE_INFINITY) > 0 &&
    (lane.pf ?? Number.NEGATIVE_INFINITY) > HEADLINE_PF_FLOOR;
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

// Renders the chronological OOS thirds [oldest / middle / newest] so the promotion table shows
// WHICH third drags a lane below STABLE — e.g. "all OOS thirds positive (+0.07 / −0.03 / +0.06)".
function oosThirdsLabel(thirds: NeuralLane['oosThirds']): string {
  if (!thirds) return '';
  const parts = thirds.map((v) => (v === null ? '—' : fmtR(v)));
  return ` (${parts.join(' / ')})`;
}

function stageProgress(lane: NeuralLane): StageProgress {
  const freshValid = lane.oosFreshValid ?? lane.closed;
  const telemetryStatus = lane.status.toUpperCase();
  const blockers = lane.blockers ?? [];

  if (isPaperBookOnlyLane(lane)) {
    const headlineReady = paperBookClearsHeadline(lane);
    const requirements = headlineReady ? [
      { label: `fresh-valid ${freshValid}/${STABLE_MIN_FRESH}`, met: freshValid >= STABLE_MIN_FRESH, progress: ratioProgress(freshValid, STABLE_MIN_FRESH) },
      { label: `netAvgR > 0.05`, met: (lane.netAvgR ?? Number.NEGATIVE_INFINITY) > 0.05, progress: thresholdProgress(lane.netAvgR, 0.05, 'gt') },
      { label: `PF > ${HEADLINE_PF_FLOOR}`, met: (lane.pf ?? Number.NEGATIVE_INFINITY) > HEADLINE_PF_FLOOR, progress: thresholdProgress(lane.pf, HEADLINE_PF_FLOOR, 'gt') },
      { label: 'paper-book lane: VM-only OOS/payoff/stress gates n/a for headline display', met: true, progress: 1 },
    ] : [
      { label: `fresh-valid ${freshValid}/${lane.oosThreshold}`, met: freshValid >= lane.oosThreshold, progress: ratioProgress(freshValid, lane.oosThreshold) },
      { label: `netAvgR > 0`, met: (lane.netAvgR ?? Number.NEGATIVE_INFINITY) > 0, progress: thresholdProgress(lane.netAvgR, 0.01, 'gt') },
      { label: `PF > ${HEADLINE_PF_FLOOR}`, met: (lane.pf ?? Number.NEGATIVE_INFINITY) > HEADLINE_PF_FLOOR, progress: thresholdProgress(lane.pf, HEADLINE_PF_FLOOR, 'gt') },
    ];
    return {
      nextStage: headlineReady ? 'Stable candidate' : 'Headline / watchable',
      progressPct: Math.round((requirements.reduce((sum, item) => sum + item.progress, 0) / requirements.length) * 100),
      blockers: requirements.filter((item) => !item.met).map((item) => item.label),
      checklist: requirements.map((item) => item.label),
    };
  }

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
      { label: `all OOS thirds positive${oosThirdsLabel(lane.oosThirds)}`, met: lane.allThreeOosPositive === true, progress: booleanProgress(lane.allThreeOosPositive) },
      { label: `netAvgR > 0.05`, met: (lane.netAvgR ?? Number.NEGATIVE_INFINITY) > 0.05, progress: thresholdProgress(lane.netAvgR, 0.05, 'gt') },
      { label: `PF > ${HEADLINE_PF_FLOOR}`, met: (lane.pf ?? Number.NEGATIVE_INFINITY) > HEADLINE_PF_FLOOR, progress: thresholdProgress(lane.pf, HEADLINE_PF_FLOOR, 'gt') },
      { label: `payoff >= ${PAYOFF_FLOOR}`, met: (lane.payoffRatio ?? Number.NEGATIVE_INFINITY) >= PAYOFF_FLOOR, progress: thresholdProgress(lane.payoffRatio, PAYOFF_FLOOR, 'gte') },
      { label: `drawdown <= ${drawdownCapR(lane).toFixed(1)}R`, met: lane.approxMaxDrawdownR !== null && lane.approxMaxDrawdownR <= drawdownCapR(lane), progress: inverseThresholdProgress(lane.approxMaxDrawdownR, drawdownCapR(lane)) },
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
      { label: `all OOS thirds positive${oosThirdsLabel(lane.oosThirds)}`, met: lane.allThreeOosPositive === true, progress: booleanProgress(lane.allThreeOosPositive) },
      { label: `netAvgR > 0.05`, met: (lane.netAvgR ?? Number.NEGATIVE_INFINITY) > 0.05, progress: thresholdProgress(lane.netAvgR, 0.05, 'gt') },
      { label: `PF > ${HEADLINE_PF_FLOOR}`, met: (lane.pf ?? Number.NEGATIVE_INFINITY) > HEADLINE_PF_FLOOR, progress: thresholdProgress(lane.pf, HEADLINE_PF_FLOOR, 'gt') },
      { label: `payoff >= ${PAYOFF_FLOOR}`, met: (lane.payoffRatio ?? Number.NEGATIVE_INFINITY) >= PAYOFF_FLOOR, progress: thresholdProgress(lane.payoffRatio, PAYOFF_FLOOR, 'gte') },
      { label: `drawdown <= ${drawdownCapR(lane).toFixed(1)}R`, met: lane.approxMaxDrawdownR !== null && lane.approxMaxDrawdownR <= drawdownCapR(lane), progress: inverseThresholdProgress(lane.approxMaxDrawdownR, drawdownCapR(lane)) },
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

interface ShortFadeReport {
  laneId: string;
  interval: string;
  universe: string[];
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  edgeReady: boolean;
  topRecent: Array<{ symbol: string; netR: number | null; status: string; exitReason: string | null; openedAt: string; rsiAtEntry: number; fundingBps: number | null }>;
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
  const [shortFade, setShortFade] = useState<ShortFadeReport | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastReceivedAt, setLastReceivedAt] = useState<number | null>(null);
  const telemetryInFlightRef = useRef(false);
  const hasTelemetryRef = useRef(false);

  async function loadTelemetry() {
    if (telemetryInFlightRef.current) return;
    telemetryInFlightRef.current = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
    try {
      const response = await fetch('/api/shadow/neural-map', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Telemetry request failed (${response.status})`);
      const next = await response.json() as NeuralTelemetry;
      setTelemetry(next);
      hasTelemetryRef.current = true;
      setLastReceivedAt(Date.now());
      setError(null);
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      const aborted = nextError instanceof Error &&
        (nextError.name === 'AbortError' || message.toLowerCase().includes('aborted'));
      if (!aborted || !hasTelemetryRef.current) {
        setError(aborted ? 'Telemetry request timed out; retrying' : message || 'Neural telemetry unavailable');
      }
    } finally {
      window.clearTimeout(timeout);
      telemetryInFlightRef.current = false;
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

  async function loadShortFade() {
    try {
      const response = await fetch('/api/shadow/short-fade-report', { cache: 'no-store' });
      if (!response.ok) return;
      setShortFade(await response.json() as ShortFadeReport);
    } catch {
      // non-critical — new/experimental lane, silently skip on failure
    }
  }

  useEffect(() => {
    void loadTelemetry();
    void loadLiveAccount();
    void loadShortFade();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadTelemetry();
      void loadLiveAccount();
      void loadShortFade();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  const visualLanes = useMemo(
    () => (telemetry?.lanes ?? []).filter((lane) => !isQuarantinedLane(lane)),
    [telemetry?.lanes],
  );

  const lanePositions = useMemo(() => {
    const positions = new Map<string, Point>();
    const lanes = visualLanes;
    const gap = lanes.length > 1 ? Math.min(88, 430 / (lanes.length - 1)) : 0;
    lanes.forEach((lane, index) => positions.set(lane.id, { x: 1055, y: 100 + index * gap }));
    return positions;
  }, [visualLanes]);

  const nodesById = useMemo(
    () => new Map((telemetry?.nodes ?? []).map((node) => [node.id, node])),
    [telemetry?.nodes],
  );

  const displayLanes = useMemo(() => {
    return (telemetry?.lanes ?? []).filter((lane) => lane.statsSource !== 'REGIME_DIAGNOSTIC');
  }, [telemetry?.lanes]);
  const laneDecisionCards = useMemo(
    () => LANE_DECISION_CONTEXTS.map((context) => ({
      ...context,
      rows: laneDecisionRows(displayLanes, context.key),
    })),
    [displayLanes],
  );
  const laneMaturitySections = useMemo(
    () => groupLanesByMaturitySection(displayLanes),
    [displayLanes],
  );
  const selectedLane = displayLanes.find((lane) => lane.id === selectedId) ?? null;
  const selectedLaneMilestone = selectedLane ? laneMilestone(selectedLane) : null;
  const selectedLaneProgress = selectedLane ? stageProgress(selectedLane) : null;
  const selectedLiveLane = liveAccount?.lanes.find((lane) => lane.laneId === selectedLane?.id) ?? null;
  const selectedLaneHeadlinePnl = selectedLane
    ? selectedLane.headlinePnl + (selectedLane.headlineUnrealizedPnl ?? 0)
    : 0;
  const selectedLaneHeadlineTone = selectedLaneHeadlinePnl > 0
    ? 'tone-healthy'
    : selectedLaneHeadlinePnl < 0
      ? 'tone-critical'
      : 'tone-measure';
  const selectedLaneOpenTone = selectedLane?.pnlIsDiagnosticOnly
    ? 'tone-measure'
    : (selectedLane?.openUnrealizedPnl ?? 0) >= 0
      ? 'tone-healthy'
      : 'tone-critical';
  const selectedLaneOosProgressText = selectedLane?.oosFreshValid == null
    ? null
    : selectedLane.oosFreshValid >= selectedLane.oosThreshold
      ? 'Mature — headline-eligible'
      : `${Math.floor((selectedLane.oosFreshValid / Math.max(1, selectedLane.oosThreshold)) * 100)}% — still collecting`;
  const selectedLaneMetricGroups = selectedLane ? [
    {
      title: 'Stage',
      rows: [
        { label: 'Evidence status', value: selectedLane.status },
        { label: 'UI stage', value: selectedLaneMilestone ? stageLabel(selectedLaneMilestone.stage) : 'n/a' },
        { label: 'Next stage', value: selectedLaneProgress?.nextStage ?? 'n/a' },
        { label: 'Progress', value: selectedLaneProgress ? `${selectedLaneProgress.progressPct}%` : 'n/a' },
        { label: 'Evidence health', value: HEALTH_LABELS[selectedLane.evidenceHealth] },
        { label: 'Stats source', value: statsSourceLongLabel(selectedLane.statsSource) },
      ],
    },
    {
      title: 'Evidence',
      rows: [
        { label: 'Open / closed', value: `${selectedLane.open} / ${selectedLane.closed}` },
        { label: 'Net Avg R', value: fmtR(selectedLane.netAvgR), tone: (selectedLane.netAvgR ?? 0) >= 0 ? 'tone-healthy' : 'tone-critical' },
        { label: 'PF / WR', value: `${fmtNumber(selectedLane.pf)} / ${selectedLane.wr === null ? 'n/a' : `${(selectedLane.wr * 100).toFixed(1)}%`}` },
        { label: 'Payoff / +10bps', value: `${fmtNumber(selectedLane.payoffRatio)} / ${selectedLane.plus10bpsStillPositive == null ? 'n/a' : selectedLane.plus10bpsStillPositive ? 'pass' : 'fail'}` },
        { label: 'OOS thirds / regimes', value: `${selectedLane.allThreeOosPositive == null ? 'n/a' : selectedLane.allThreeOosPositive ? 'all positive' : 'not yet'} / ${selectedLane.distinctRegimes ?? 'n/a'}` },
        { label: 'Drawdown / concentration', value: `${fmtR(selectedLane.approxMaxDrawdownR)} / ${pctShare(selectedLane.topSymbolPnlShare)}` },
        { label: 'Calendar / infra', value: `${selectedLane.calendarDays === null ? 'n/a' : `${selectedLane.calendarDays.toFixed(1)}d`} / ${selectedLane.infraReady == null ? 'n/a' : selectedLane.infraReady ? 'ready' : 'not ready'}` },
      ],
    },
    {
      title: 'OOS maturity',
      rows: selectedLane.oosFreshValid === null ? [
        { label: 'Validated', value: 'n/a' },
      ] : [
        { label: 'Validated', value: `${selectedLane.oosFreshValid} / ${selectedLane.oosThreshold} fresh closes` },
        {
          label: 'Progress',
          value: (
            <span className="neural-metric-progress">
              <span className="neural-oos-bar">
                <span
                  className={`neural-oos-fill ${selectedLane.oosFreshValid >= selectedLane.oosThreshold ? 'is-complete' : ''}`}
                  style={{ width: `${Math.min(100, (selectedLane.oosFreshValid / Math.max(1, selectedLane.oosThreshold)) * 100).toFixed(1)}%` }}
                />
              </span>
              <span>{selectedLaneOosProgressText}</span>
            </span>
          ),
        },
      ],
    },
    {
      title: 'TP geometry',
      rows: [
        { label: 'Avg entry / mark', value: `${fmtPrice(selectedLane.openAvgEntryPrice)} / ${fmtPrice(selectedLane.openAvgMarkPrice)}` },
        { label: 'Avg TP / gap', value: `${fmtPrice(selectedLane.openAvgTakeProfitPrice)} / ${fmtGapPct(selectedLane.openAvgDistanceToTpPct)}` },
        { label: 'Nearest TP gap', value: `${fmtGapPct(selectedLane.openNearestDistanceToTpPct)} across ${selectedLane.openMarkedSymbolCount} symbols` },
        { label: 'MFE avg / p90', value: `${fmtPlainPct(selectedLane.openAvgMfePct)} / ${fmtPlainPct(selectedLane.openP90MfePct)}` },
        { label: 'TP quality', value: `${tpVerdictLabel(selectedLane.openTpAssessment)} · TP ${fmtPlainPct(selectedLane.openAvgConfiguredTpPct)}` },
      ],
    },
    {
      title: 'Paper & diagnostics',
      rows: [
        {
          label: 'Headline PnL (real)',
          value: `${fmtUsdt(selectedLaneHeadlinePnl)} / ${fmtR((selectedLane.netAvgR ?? 0) === 0 && selectedLane.closed === 0 ? null : selectedLane.headlineUnrealizedR)}${selectedLane.pnlIsDiagnosticOnly ? ' · flat' : ''}`,
          tone: selectedLaneHeadlineTone,
        },
        { label: 'Paper evidence PnL', value: `${fmtMoney(selectedLane.totalPnl)}${selectedLane.pnlIsDiagnosticOnly ? ' · diagnostic' : ''}`, tone: selectedLane.pnlIsDiagnosticOnly ? 'tone-measure' : undefined },
        { label: 'Diagnostic open MTM', value: `${fmtUsdt(selectedLane.diagnosticUnrealizedPnl)} / ${fmtR(selectedLane.diagnosticUnrealizedR)}`, tone: 'tone-measure' },
        { label: 'Max favorable open', value: `${fmtUsdt(selectedLane.openMaxFavorablePnl)} / ${fmtR(selectedLane.openMaxFavorableR)}`, tone: 'tone-measure' },
        { label: 'All open MTM', value: `${fmtUsdt(selectedLane.openUnrealizedPnl)} / ${fmtR(selectedLane.openUnrealizedR)}`, tone: selectedLaneOpenTone },
      ],
    },
    {
      title: 'Binance mirror',
      rows: [
        { label: 'Mirrored', value: selectedLiveLane ? `${selectedLiveLane.sourceOrderCount} orders / ${selectedLiveLane.symbols.length} symbols` : 'not open' },
        { label: 'Notional', value: selectedLiveLane ? `${selectedLiveLane.notionalUsd.toFixed(2)} USDT` : '0.00 USDT' },
        { label: 'Unrealized', value: selectedLiveLane ? `${selectedLiveLane.unrealizedPnl >= 0 ? '+' : ''}${selectedLiveLane.unrealizedPnl.toFixed(2)} USDT` : '0.00 USDT', tone: (selectedLiveLane?.unrealizedPnl ?? 0) >= 0 ? 'tone-healthy' : 'tone-critical' },
        { label: 'Account equity', value: liveAccount?.accountEquity != null ? `${liveAccount.accountEquity.toFixed(2)} USDT` : 'n/a' },
      ],
    },
  ] : [];
  const newestAgeSec = lastReceivedAt === null ? Infinity : Math.round((Date.now() - lastReceivedAt) / 1000);
  const stale = newestAgeSec > (telemetry?.staleAfterSec ?? 30) || Boolean(error);
  const milestoneSections = useMemo(
    () => laneMaturitySections.map((section) => ({
      ...section,
      rows: section.lanes.map((lane) => ({ lane, milestone: laneMilestone(lane), progress: stageProgress(lane) })),
    })),
    [laneMaturitySections],
  );
  const watchableThreshold = telemetry?.lanes.find((lane) => lane.oosThreshold > 0)?.oosThreshold ?? 10;

  const neuralEdges = useMemo(() => {
    if (!telemetry) return [];
    const laneEdges: Array<[string, string]> = [];
    for (const lane of visualLanes) {
      laneEdges.push(['occupancy', lane.id], [lane.id, 'paper']);
    }
    return [...CORE_EDGES, ...laneEdges];
  }, [telemetry, visualLanes]);

  function positionOf(id: string): Point | null {
    return NODE_POSITIONS[id] ?? lanePositions.get(id) ?? null;
  }

  function healthOf(id: string): NeuralHealth {
    const lane = displayLanes.find((candidate) => candidate.id === id);
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

      {error && (
        <div className="neural-error">
          <strong>Telemetry link interrupted</strong>
          <span>{error}. The last known state remains visible.</span>
        </div>
      )}

      {shortFade && (
        <section className="neural-shortfade-card" aria-label="SHORT confirmed-exhaustion + crowded-funding fade (experimental)">
          <div className="neural-shortfade-head">
            <span>Experimental — SHORT confirmed-exhaustion + crowded-funding fade</span>
            <strong className={shortFade.edgeReady ? 'tone-healthy' : 'tone-measure'}>
              {shortFade.edgeReady ? 'EDGE READY' : 'COLLECTING'}
            </strong>
            <small>
              {shortFade.openCount} open / {shortFade.resolvedCount} resolved · {shortFade.interval} · watching {shortFade.universe.map((s) => s.replace(/USDT$/, '')).join(', ')}
            </small>
          </div>
          <p className="neural-section-note">
            Entry: RSI crosses back below overbought after confirmed exhaustion (not first touch) AND funding is
            EXTREME on the long side while OI still rises (crowded longs primed to unwind). Exit: same wide-stop
            (≥300bps) + fast-TP (0.5R) geometry already proven by CG_WIDE_FAST_SHORT. Report-only — nothing trades
            on this until the book proves positive.
          </p>
          <div className="neural-shortfade-stats">
            <div><span>Net R</span><strong className={shortFade.netAvgR == null ? '' : shortFade.netAvgR >= 0 ? 'tone-healthy' : 'tone-critical'}>{fmtR(shortFade.netAvgR)}</strong></div>
            <div><span>PF</span><strong>{fmtNumber(shortFade.pf)}</strong></div>
            <div><span>WR</span><strong>{shortFade.wr === null ? 'n/a' : `${(shortFade.wr * 100).toFixed(1)}%`}</strong></div>
          </div>
          {shortFade.topRecent.length > 0 && (
            <div className="neural-shortfade-recent">
              {shortFade.topRecent.slice(0, 6).map((r, i) => (
                <span key={`${r.symbol}-${r.openedAt}-${i}`} className={`neural-symbol-badge ${r.netR == null ? 'tier-testnet-only' : r.netR >= 0 ? 'tier-live-ready' : ''}`}>
                  {r.symbol.replace(/USDT$/, '')} {r.netR == null ? '(open)' : fmtR(r.netR)}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="neural-milestone-panel" aria-label="Lane maturity thresholds">
        <div className="neural-milestone-summary">
          <span>Lane maturity &amp; performance field</span>
          <strong>Promotion ladder + live lane scorecard</strong>
          <p>
            Runtime thresholds on VPS now: watchable/headline floor <b>{watchableThreshold}</b> fresh-valid,
            stable candidate <b>{STABLE_MIN_FRESH}</b>, promotion candidate <b>{PROMOTION_MIN_FRESH}</b>.
            One row per lane: stage, OOS progress, the gate blocking promotion, and realized book
            economics. Click a lane row for the full per-lane detail (cohorts, TP geometry, rotation
            shortlists) in the inspector panel.
          </p>
        </div>
        <p className="neural-decision-legend">
          Each lane shows two numbers: <b>sim</b> = idealized VM-simulation cohort (optimistic — entry at
          signal price, simple costs), <b>book</b> = REALIZED paper-book economics (realistic fills + cost).
          A <b>BENCHED</b> verdict means the sim looks positive but the book proved it negative, so it is
          correctly held out of live. Trust the book number for live decisions.
        </p>
        <div className="neural-decision-grid" aria-label="Lane selection matrix">
          {laneDecisionCards.map((card) => (
            <section key={card.key} className={`neural-decision-card context-${card.tone}`}>
              <div className="neural-decision-card-head">
                <span>Best lane by context</span>
                <strong>{card.title}</strong>
                <p>{card.subtitle}</p>
              </div>
              <div className="neural-decision-rows">
                {card.rows.length === 0 ? (
                  <p className="neural-decision-empty">No PROVEN/WATCH lane for this context yet.</p>
                ) : card.rows.map((row) => (
                  <button
                    type="button"
                    key={`${card.key}-${row.lane.id}`}
                    className={`neural-decision-row verdict-${row.tone}`}
                    onClick={() => setSelectedId(row.lane.id)}
                  >
                    <span className="neural-decision-rank">
                      <b className={`neural-verdict-pill verdict-${row.tone}`}>{row.verdict}</b>
                      <strong>{row.lane.label}</strong>
                    </span>
                    <em className={cohortTone(row.cohort)}>sim · {fmtCohort(row.cohort)}</em>
                    <em className={bookTone(row.lane)}>{fmtBook(row.lane)}</em>
                    <small>{row.source} · {row.secondary}</small>
                    {renderProvenSymbols(row.lane.provenSymbols)}
                  </button>
                ))}
              </div>
            </section>
          ))}
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
                <th>Stage</th>
                <th title="Fresh-valid out-of-sample observations vs the threshold for the next stage">OOS progress</th>
                <th title="The first gate blocking this lane from the next stage">Blocking gate</th>
                <th title="Market context where this lane has the best evidence">Best use</th>
                <th title="Realized paper-book average net R per trade (fills + costs)">Net R (book)</th>
                <th title="Realized paper-book profit factor">PF (book)</th>
                <th title="Realized paper-book win rate">WR (book)</th>
                <th title="Mark-to-market of this lane's OPEN paper orders (measurement only, not real money)">Open MTM</th>
                <th title="Mirrored Binance testnet exposure: unrealized PnL and mirrored order count">Binance mirror</th>
              </tr>
            </thead>
            <tbody>
              {milestoneSections.map((section) => (
                <Fragment key={`milestone-section-${section.key}`}>
                  <tr className={`neural-direction-row direction-${section.key.toLowerCase()}`}>
                    <td colSpan={10}>
                      <span>{section.label}</span>
                      <small>{section.lanes.length} lane{section.lanes.length === 1 ? '' : 's'} · {section.detail}</small>
                    </td>
                  </tr>
                  {section.rows.map(({ lane, milestone, progress }) => {
                    const liveLane = liveAccount?.lanes.find((item) => item.laneId === lane.id);
                    const livePnl = liveLane?.unrealizedPnl ?? 0;
                    return (
                      <tr
                        key={`milestone-${lane.id}`}
                        className={`${lane.active ? 'is-active' : ''}${isQuarantinedLane(lane) ? ' is-quarantined' : ''}`}
                        onClick={() => setSelectedId(lane.id)}
                      >
                        <td><i className={`health-${healthOf(lane.id).toLowerCase()}`} />{compactLaneLabel(lane.label)}</td>
                        <td><span className={`neural-stage-pill ${evidencePillClass(lane, milestone)}`}>{isQuarantinedLane(lane) ? 'Quarantined' : stageLabel(milestone.stage)}</span></td>
                        <td>{`${lane.oosFreshValid ?? lane.closed} / ${lane.oosThreshold} fresh · ${progress.progressPct}%`}</td>
                        <td className="neural-missing-cell">{progress.blockers[0] ?? 'None'}</td>
                        <td className="neural-best-use-cell">{bestContextLabel(lane)}</td>
                        <td className={lane.netAvgR == null ? '' : lane.netAvgR >= 0 ? 'tone-healthy' : 'tone-critical'}>{fmtR(lane.netAvgR)}</td>
                        <td>{fmtNumber(lane.pf)}</td>
                        <td>{lane.wr === null ? 'n/a' : `${(lane.wr * 100).toFixed(1)}%`}</td>
                        <td className="tone-measure">{fmtUsdt(lane.diagnosticUnrealizedPnl)}</td>
                        <td className={livePnl === 0 ? '' : livePnl > 0 ? 'tone-healthy' : 'tone-critical'}>
                          {liveLane ? `${livePnl >= 0 ? '+' : ''}${livePnl.toFixed(2)} USDT · ${liveLane.sourceOrderCount} mirrored` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
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
                      visualLanes.find((lane) => (lane.id === fromId || lane.id === toId) && lane.active);
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

                {visualLanes.map((lane) => {
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
            <span>Lane intelligence</span>
            <strong>{selectedLane?.label ?? 'Select a lane'}</strong>
            {selectedLane && (
              <em className={`health-${selectedLane.health.toLowerCase()}`}>
                {HEALTH_LABELS[selectedLane.health]}
              </em>
            )}
          </div>

          {selectedLane && (
            <>
              <div className={`neural-diagnosis health-${selectedLane.health.toLowerCase()}`}>
                <span>Lane diagnosis</span>
                <strong>{selectedLiveLane ? 'Lane color follows mirrored exchange P&L.' : laneDiagnosis(selectedLane)}</strong>
                <p>Paper evidence remains separate; execution equity, exposure, and current PnL come from Binance testnet.</p>
              </div>
              <div className="neural-inspector-section neural-lane-metrics-panel">
                <div className="neural-lane-metrics-header">
                  <div>
                    <h2>Lane maturity & performance</h2>
                    <p className="neural-section-note">Same data, split into compact cards so stage, OOS, TP geometry, PnL, and Binance mirror are readable side by side.</p>
                  </div>
                </div>
                <div className="neural-lane-card-grid">
                  <section className="neural-lane-metric-card neural-lane-cohort-card">
                    <h3>Direction / regime scorecard</h3>
                    <p className="neural-section-note">LONG/SHORT are direction cohorts. MIXED is a regime subset, so it is not added to direction totals.</p>
                    <dl>
                      <div><dt>LONG cohort</dt><dd className={cohortTone(selectedLane.cohorts?.LONG)}>{fmtCohort(selectedLane.cohorts?.LONG)}</dd></div>
                      <div><dt>LONG + bullish</dt><dd className={cohortTone(selectedLane.cohorts?.LONG_BULLISH)}>{fmtCohort(selectedLane.cohorts?.LONG_BULLISH)}</dd></div>
                      <div><dt>SHORT cohort</dt><dd className={cohortTone(selectedLane.cohorts?.SHORT)}>{fmtCohort(selectedLane.cohorts?.SHORT)}</dd></div>
                      <div><dt>SHORT + bearish</dt><dd className={cohortTone(selectedLane.cohorts?.SHORT_BEARISH)}>{fmtCohort(selectedLane.cohorts?.SHORT_BEARISH)}</dd></div>
                      <div><dt>MIXED regime</dt><dd className={cohortTone(selectedLane.cohorts?.MIXED)}>{fmtCohort(selectedLane.cohorts?.MIXED)}</dd></div>
                      <div><dt>Mixed split</dt><dd>{`L ${miniCohort(selectedLane.cohorts?.LONG_MIXED)} · S ${miniCohort(selectedLane.cohorts?.SHORT_MIXED)}`}</dd></div>
                    </dl>
                  </section>
                  <section className="neural-lane-metric-card neural-lane-rotation-card">
                    <h3>Rotation shortlist</h3>
                    <p className="neural-section-note">ALLOW is the only verdict that can feed testnet/live admission; WATCH is visible but not executable.</p>
                    <dl>
                      <div><dt>Bearish rotation</dt><dd>{rotationShortlistText(selectedLane.rotationShortlist?.bearish)}</dd></div>
                      <div><dt>Bullish rotation</dt><dd>{rotationShortlistText(selectedLane.rotationShortlist?.bullish)}</dd></div>
                    </dl>
                    <div className="rotation-detail-grid">
                      <div>
                        <span>Bear shortlist</span>
                        {renderRotationShortlist(selectedLane.rotationShortlist?.bearish)}
                      </div>
                      <div>
                        <span>Bull shortlist</span>
                        {renderRotationShortlist(selectedLane.rotationShortlist?.bullish)}
                      </div>
                    </div>
                  </section>
                  {selectedLaneMetricGroups.map((group) => (
                    <section className="neural-lane-metric-card" key={group.title}>
                      <h3>{group.title}</h3>
                      <dl>
                        {group.rows.map((row) => (
                          <div key={`${group.title}-${row.label}`}>
                            <dt>{row.label}</dt>
                            <dd className={'tone' in row ? row.tone : undefined}>{row.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </section>
                  ))}
                </div>
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

        </aside>
      </main>

    </div>
  );
}
