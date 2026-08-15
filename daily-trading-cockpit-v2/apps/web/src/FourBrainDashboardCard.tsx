import { useState } from 'react';
import { useShadowReport, type ExitBrainReport } from './InnovationLanesCard';
import { Disclosure } from './LaneMaturityTable';
import { ReadinessVerdict, readinessColor, readinessLabel, type FourBrainReadinessBlock } from './ReadinessVerdict';

/** Module-level constant: a fresh object literal here would be a new effect dependency every render. */
const DIRECTION_TESTNET_ONLY = { testnetOnly: true } as const;

// Four-Brain operator dashboard card (2026-07-23 operator ask — "gw bisa liat performance dan decision
// dan dibuat sama four brain di mana? Biar gw bisa liat, bener ga, dan bisa adjust"). /research only,
// mounted alongside CortexReadinessCard / InnovationLanesCard (same place, same convention — those are
// unconditional on this page, so this is too). Four-brain shadow mode only ever runs on research (3101)
// and testnet (3102), never live (3103) — this card fetches testnet-preferred data via useShadowReport
// (the SAME hook InnovationLanesCard already built: testnet Caddy prefix first, local fallback, seq-
// guarded, keep-last-good), exactly like every other report-only card on this page.
//
// Backend: GET /api/shadow/four-brain — health (live metrics aggregator) + recentDecisions (bounded
// in-memory ring buffer, NEVER a re-read of the growing journal file — see
// four-brain-recent-decisions.ts's doc comment for the exact incident that avoids repeating).
//
// Exit Brain's performance used to be re-rendered here from the /api/shadow/exit-brain endpoint's
// `performance` object, but with strictly less detail than InnovationLanesCard's Exit Brain row
// (no coverage box) — 2026-07-23 declutter cut the duplicate in favor of a pointer to that row.
// Direction Brain and Entry Brain have NO counterfactual measurement anywhere else — this card is
// deliberately honest about that gap instead of fabricating a number for them.

type FourBrainHealth = {
  ticks: {
    attempted: number; completed: number; skippedSingleFlight: number; gatherErrors: number;
    exceptions: number; journalErrors: number; brainErrors: number; invariantFailures: number;
  };
  decisions: { total: number; duplicateDecisionIds: number; unknownLanes: number; duplicateIdentities: number };
  coverage: { lastLaneCoverage: number; maxLaneCoverage: number; lastPositionCoverage: number; maxPositionCoverage: number };
  sourceQuality: Record<string, { total: number; freshPct: number; stalePct: number; missingPct: number; errorPct: number }>;
  byCandidateStatus: Record<string, number>;
  byBrainAction: Record<string, number>;
  latencyMs: {
    gather: { p50: number | null; p90: number | null; p99: number | null; samples: number };
    inference: { p50: number | null; p90: number | null; p99: number | null; samples: number };
    journal: { p50: number | null; p90: number | null; p99: number | null; samples: number };
  };
};

type MarketStateAuthorityView = {
  source: 'TESTNET_EXECUTOR';
  canonicalRegimeFamily: 'BULLISH' | 'BEARISH' | 'MIXED' | 'UNKNOWN';
  scannerRegime: string | null;
  capturedAtMs: number | null;
};
type MarketStateBrainView = {
  family: string;
  bias: string;
  volatility: string;
  liquidity: string;
  confidence: number;
  transitionRisk: number;
  sourceStatuses?: Record<string, string>;
  authority?: MarketStateAuthorityView | null;
} | null;
type DirectionBrainView = { action: string; confidence: number; horizon: string; expectedDirectionalR: number | null } | null;
type EntryBrainView = { action: string; confidence: number; expectedNetR: number | null } | null;
type ExitBrainDecisionView = { action: string; edgeRemainingR: number | null; continuationProbability: number } | null;

type ExecutiveDecisionRecord = {
  kind: 'EXECUTIVE_DECISION';
  asOfMs: number;
  laneId: string | null;
  symbolOrBasketId: string | null;
  candidateStatus: string;
  wouldAct: boolean;
  reasons?: string[];
  brains: { marketState: MarketStateBrainView; direction: DirectionBrainView; entry: EntryBrainView; exit: ExitBrainDecisionView };
};
type MarketSnapshotRecord = { kind: 'MARKET_SNAPSHOT'; asOfMs: number; marketState: MarketStateBrainView };
type RecentRecord = ExecutiveDecisionRecord | MarketSnapshotRecord | { kind: string; asOfMs?: number };

type FourBrainReport = {
  reportOnly: true;
  generatedAt: string;
  enabled: boolean;
  health: FourBrainHealth;
  recentDecisions: RecentRecord[];
  bridge?: { active?: boolean; mode?: string; evaluations?: number; blocked?: number } | null;
  actualFillBindings?: {
    candidates: number; open: number; measured: number; unmeasured: number; unbound: number;
    entryAdmission?: { observed: number; enterNow: number; validEnterNow: number; exactCandidatesRecorded: number };
    preEntryAdmission?: { observed: number; enterNow: number; validEnterNow: number; exactCandidatesRecorded: number };
  } | null;
};

function marketStateLabel(state: MarketStateBrainView): string {
  if (!state) return '—';
  if (state.authority?.source === 'TESTNET_EXECUTOR') {
    return `Canonical ${state.authority.canonicalRegimeFamily} · Scanner ${state.authority.scannerRegime ?? '—'}`;
  }
  return `${state.family}/${state.bias}`;
}

// Direction + Entry Brain counterfactual outcome report (2026-07-23) — GET /api/shadow/direction-entry-outcomes.
// Mirrors direction-entry-outcome-store.ts's DirectionEntryOutcomeReport shape (only the fields this card
// actually renders — `recent` arrays are intentionally typed loosely since neither section renders them here).
// TWO INDEPENDENT SECTIONS, NEVER BLENDED: direction vs entry. Within entry, Tier 1 (real fill) and Tier 2
// (simulated) are ALWAYS two separate rows (see `tier` on every entry aggregate) — never summed into one number.
type RateView = {
  n: number;
  // TRUE denominators behind meanNetR / winRate. They can be far smaller than `n`: SKIP and untriggered
  // WAIT_* rows resolve with netR:null by design, so they count toward n but contribute no R. Rendering
  // `n` alone next to meanR overstated the evidence badly (testnet: n=10808 vs 62 rows actually carrying
  // an R). Optional so an older backend that doesn't send them degrades to the previous display.
  netRTrackedN?: number;
  winTrackedN?: number;
  insufficientData: boolean;
  winRate: number | null;
  meanNetR: number | null;
  cumNetR: number;
  meanRegretR: number | null;
  meanCalibrationGapR: number | null;
};
type DEHorizon = 'SCALP' | 'INTRADAY' | 'SWING';
type DEDirectionAction = 'LONG' | 'SHORT' | 'FLAT' | 'BOTH';
type DEEntryTier = 'TIER1_REALIZED' | 'TIER2_SIMULATED';
// MEASURED = real/ENTER_NOW-grade confidence; EXPERIMENTAL_COST_OF_CAUTION = the permanent tag Tier 2's
// resolver stamps on WAIT_*/SKIP rows (a simulated cost-of-caution number, never presented as equally solid).
type DEEntryConfidence = 'MEASURED' | 'EXPERIMENTAL_COST_OF_CAUTION';
type DEEntryAction = 'ENTER_NOW' | 'WAIT_PULLBACK' | 'WAIT_BREAKOUT' | 'WAIT_CONFIRMATION' | 'SKIP';

type DirectionEntryOutcomeReport = {
  generatedAt: string;
  reportOnly: true;
  direction: {
    coverage: { pending: number; evaluated: number; instrumentDataMissing: number; expiredUnresolvable: number; note: string };
    perHorizon: Array<{
      horizon: DEHorizon;
      n: number;
      effectiveN: number;
      insufficientEffectiveSampleSize: boolean;
      perAction: Array<{ action: DEDirectionAction } & RateView>;
    }>;
  };
  entry: {
    coverage: {
      pending: number; resolvedRealMatch: number; resolvedSimulated: number;
      instrumentDataMissing: number; expiredUnresolvable: number; note: string;
    };
    perAction: Array<{ tier: DEEntryTier; action: DEEntryAction; confidence: DEEntryConfidence } & RateView>;
    calibration: Array<{ tier: DEEntryTier } & RateView>;
    perLane: Array<{ tier: DEEntryTier; laneId: string } & RateView>;
    perSymbol: Array<{ tier: DEEntryTier; symbolOrBasketId: string } & RateView>;
  };
  cycleMeta: { lastRunAtIso: string | null; lastProcessed: number; lastError: string | null };
};
// 2026-07-28: the READINESS VERDICT. Until now this card showed four raw columns (n / WR / meanR /
// regret / calib-gap) and no answer to the only question an operator actually has — is this brain
// good enough to act on yet. CORTEX has had a readiness meter since it was built; the four brains
// had none. Computed server-side (four-brain-readiness.ts); optional here so an older backend that
// does not send it simply renders nothing rather than breaking the card.
type DirectionEntryOutcomesResponse = {
  reportOnly: true;
  generatedAt: string;
  enabled: boolean;
  readiness?: { direction: FourBrainReadinessBlock; entry: FourBrainReadinessBlock } | null;
  report: DirectionEntryOutcomeReport | null;
};

/**
 * WHICH INSTANCE AM I LOOKING AT (2026-07-28). useShadowReport tries /testnet first and silently
 * falls back to the LOCAL instance when testnet does not answer, re-deciding every 60 seconds — so
 * the same panel alternates between two different datasets with no indication. An operator watching
 * INTRADAY move from n=1867 to n=1674 and back reasonably reads that as data being reset or lost.
 * The hook has always returned `source`; nothing displayed it.
 */
function SourceBadge({ source, unreachable }: { source: 'testnet' | 'local' | null; unreachable: boolean }) {
  if (source == null) return null;
  const testnet = source === 'testnet';
  return (
    <span
      title={
        testnet
          ? 'Angka dari TESTNET (3102) — instance yang benar-benar mengeksekusi.'
          : 'Testnet tidak menjawab. Panel Direction/Entry sengaja TIDAK jatuh ke research/3101 — edge memory di sana cuma 3 sampel dan tidak satu pun di regime saat ini, jadi vonisnya tidak bisa dipercaya. Angka yang tampil adalah nilai testnet terakhir yang baik.'
      }
      style={{
        marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 4, letterSpacing: 0.3,
        border: `1px solid ${testnet ? C.measure : C.accent}`, color: testnet ? C.measure : C.accent,
      }}
    >
      {testnet ? 'TESTNET' : 'RESEARCH (testnet tidak menjawab)'}{unreachable ? ' · STALE' : ''}
    </span>
  );
}

const ACTIVE_TESTNET_LANE_PREFIXES = [
  'CROSS_SECTIONAL_MARKET_NEUTRAL',
  'CROSS_SECTIONAL_DIRECTIONAL_',
] as const;

const isExecutiveDecision = (r: RecentRecord): r is ExecutiveDecisionRecord => r.kind === 'EXECUTIVE_DECISION';
const isMarketSnapshot = (r: RecentRecord): r is MarketSnapshotRecord => r.kind === 'MARKET_SNAPSHOT';
const isFocusedTestnetLane = (laneId: string | null) =>
  laneId != null && (
    ACTIVE_TESTNET_LANE_PREFIXES.some((prefix) => laneId.startsWith(prefix)) ||
    laneId.includes('CG_MFE_GIVEBACK')
  );

const C = { card: '#14222a', sub: '#0f1c23', border: '#20313a', text: '#dbe7ec', dim: '#7d97a3', good: '#46d39a', bad: '#ff6b6b', measure: '#6fb3d6', accent: '#f0b54b', track: '#1c2c34' };

const fmtR = (v: number | null | undefined, d = 3) =>
  v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}R`;
const fmtPct = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}%`);
const fmtMs = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(1)}ms`);
const toneR = (v: number | null | undefined) => (v == null ? C.measure : v > 0 ? C.good : v < 0 ? C.bad : C.dim);

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ flex: 1, height: 8, background: C.track, borderRadius: 3, overflow: 'hidden', minWidth: 60 }}>
      <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', background: color }} />
    </div>
  );
}

function StatRow({ label, value, color, title }: { label: string; value: string; color?: string; title?: string }) {
  return (
    <span title={title} style={{ fontSize: 12, color: C.dim, whiteSpace: 'nowrap', cursor: title ? 'help' : undefined }}>
      {label} <b style={{ color: color ?? C.text }}>{value}</b>
    </span>
  );
}

type BrainReadinessProgress = {
  pct: number;
  label: string;
  detail: string;
  color: string;
  evidence: number;
  target: number;
};

const clampPct = (value: number) => Math.round(Math.min(100, Math.max(0, value)));

function measuredReadinessProgress(block: FourBrainReadinessBlock | null | undefined): BrainReadinessProgress {
  if (!block) return { pct: 0, label: 'MENUNGGU DATA', detail: 'Belum ada verdict readiness dari testnet.', color: C.dim, evidence: 0, target: 0 };
  const realScopes = block.perScope.filter((scope) => scope.measuredBasis !== 'SIMULATED');
  const scopes = realScopes.length > 0 ? realScopes : block.perScope;
  const evidenceGates = scopes
    .map((scope) => scope.gates.find((gate) => gate.gate === 'EVIDENCE'))
    .filter((gate): gate is NonNullable<typeof gate> => gate != null);
  const evidence = evidenceGates.reduce((sum, gate) => sum + (typeof gate.value === 'number' ? gate.value : 0), 0);
  const target = evidenceGates.reduce((sum, gate) => {
    const match = /need\s*[≥>=]+\s*(\d+)/i.exec(gate.detail);
    return sum + (match ? Number(match[1]) : 20);
  }, 0);
  const evidencePct = target > 0 ? clampPct((evidence / target) * 100) : 0;
  const failed = scopes.flatMap((scope) => scope.gates.filter((gate) => gate.passed === false).map((gate) => gate.gate));
  if (block.verdict === 'READY') return { pct: 100, label: readinessLabel(block.verdict), detail: `Semua gate lolos pada ${evidence}/${target} bukti nyata.`, color: readinessColor(block.verdict), evidence, target };
  if (block.verdict === 'NOT_READY') return { pct: 0, label: readinessLabel(block.verdict), detail: `Bukti ${evidence}/${target} ada, tetapi ${[...new Set(failed)].join(' + ') || 'gate'} gagal.`, color: readinessColor(block.verdict), evidence, target };
  if (block.verdict === 'NOT_READY_SIMULATED_ONLY') return { pct: 0, label: readinessLabel(block.verdict), detail: 'Simulasi tidak dihitung sebagai izin untuk memengaruhi executor.', color: readinessColor(block.verdict), evidence, target };
  return { pct: evidencePct, label: readinessLabel(block.verdict), detail: `Bukti nyata ${evidence}/${target} sampel independen.`, color: readinessColor(block.verdict), evidence, target };
}

function marketStateDataProgress(state: MarketStateBrainView): BrainReadinessProgress {
  const statuses = Object.values(state?.sourceStatuses ?? {});
  const fresh = statuses.filter((status) => status === 'FRESH').length;
  const total = statuses.length;
  const pct = total > 0 ? clampPct((fresh / total) * 100) : 0;
  const color = pct >= 80 ? C.good : pct >= 50 ? C.accent : C.bad;
  return {
    pct,
    label: total === 0 ? 'MENUNGGU SNAPSHOT' : pct >= 80 ? 'DATA KUAT' : pct >= 50 ? 'DATA PARSIAL' : 'DATA LEMAH',
    detail: total === 0 ? 'Belum ada input market-state terbaru.' : `${fresh}/${total} input market-state fresh pada snapshot terakhir.`,
    color,
    evidence: fresh,
    target: total,
  };
}

function exactFillEntryProgress(
  readiness: FourBrainReadinessBlock | null | undefined,
  bindings: FourBrainReport['actualFillBindings'],
): BrainReadinessProgress {
  const base = measuredReadinessProgress(readiness);
  if (!bindings) return base;
  const preEntry = bindings.preEntryAdmission ?? bindings.entryAdmission;
  const target = base.target || 20;
  const pct = readiness?.verdict === 'READY'
    ? 100
    : readiness?.verdict === 'NOT_READY' || readiness?.verdict === 'NOT_READY_SIMULATED_ONLY'
      ? 0
      : clampPct((bindings.measured / target) * 100);
  return {
    ...base,
    pct,
    detail: preEntry && preEntry.observed === 0
      ? 'Belum ada kandidat baru yang benar-benar sampai ke jalur submit executor sejak cohort exact-fill dimulai.'
      : `Cohort exact-fill baru: ${bindings.measured}/${target} close lengkap · ${bindings.open} masih open · legacy tidak dihitung.`,
    evidence: bindings.measured,
    target,
  };
}

function BrainReadinessTile({ name, progress, title }: { name: string; progress: BrainReadinessProgress; title: string }) {
  return (
    <div title={title} style={{ minWidth: 0, padding: '10px 11px', borderRadius: 7, background: C.sub, border: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 11, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.35 }}>{name}</span>
        <b style={{ fontSize: 18, color: progress.color }}>{progress.pct}%</b>
      </div>
      <div style={{ marginTop: 7 }}><Bar pct={progress.pct} color={progress.color} /></div>
      <div style={{ marginTop: 7, fontSize: 11, fontWeight: 700, color: progress.color }}>{progress.label}</div>
      <div style={{ marginTop: 3, minHeight: 28, fontSize: 11, lineHeight: 1.3, color: C.dim }}>{progress.detail}</div>
    </div>
  );
}

function FocusCell({ label, value, detail, color = C.text }: { label: string; value: string; detail: string; color?: string }) {
  return (
    <div style={{ minWidth: 0, padding: '10px 11px', borderRadius: 7, background: C.sub, border: `1px solid ${C.border}` }}>
      <div style={{ fontSize: 10, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.28, fontWeight: 700, color, overflowWrap: 'anywhere' }}>{value}</div>
      <div style={{ marginTop: 4, minHeight: 28, fontSize: 11, lineHeight: 1.3, color: C.dim }}>{detail}</div>
    </div>
  );
}

const agoShort = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

const deTierLabel = (t: DEEntryTier) => (t === 'TIER1_REALIZED' ? 'TIER 1 — REAL-MATCH AUDIT' : 'TIER 2 — SIMULATED');
const deTierColor = (t: DEEntryTier) => (t === 'TIER1_REALIZED' ? C.good : C.measure);

/** One RateView rendered inline — honest about INSUFFICIENT_DATA / n=0, never a blank or fabricated number
 *  (matches this codebase's existing INSUFFICIENT_PATH_DATA convention — see Exit Brain's coverage block). */
function RateStatsInline({ rv, dim }: { rv: RateView; dim?: boolean }) {
  if (rv.n === 0) {
    return <span style={{ fontSize: 11, color: C.dim, fontStyle: 'italic' }}>belum ada data (n=0)</span>;
  }
  if (rv.insufficientData) {
    return (
      <span style={{ fontSize: 11, color: C.accent }} title="di bawah floor n≥20 — angka tidak ditampilkan supaya tidak menyesatkan">
        INSUFFICIENT_DATA (n={rv.n}, butuh ≥20)
      </span>
    );
  }
  return (
    <span style={{ fontSize: 11, color: dim ? C.dim : C.text }}>
      n={rv.n}
      {rv.netRTrackedN != null && rv.netRTrackedN < rv.n && (
        <span
          style={{ color: C.accent }}
          title={`meanR/cumR dihitung dari ${rv.netRTrackedN} baris yang benar-benar punya R — ${rv.n - rv.netRTrackedN} baris sisanya (SKIP / WAIT yang tidak pernah ter-trigger) resolve dengan netR:null dan tidak menyumbang apa pun ke rata-rata.`}
        >
          {' '}({rv.netRTrackedN} dgn R)
        </span>
      )}{' '}
      · WR {fmtPct(rv.winRate != null ? rv.winRate * 100 : null)} · meanR{' '}
      <b style={{ color: toneR(rv.meanNetR) }}>{fmtR(rv.meanNetR)}</b>
      {rv.meanRegretR != null && <> · regret {fmtR(rv.meanRegretR)}</>}
      {rv.meanCalibrationGapR != null && <> · calib-gap {fmtR(rv.meanCalibrationGapR)}</>}
    </span>
  );
}

export function FourBrainDashboardCard({ grouped = false }: { grouped?: boolean } = {}) {
  const report = useShadowReport<FourBrainReport>('four-brain');
  // TESTNET ONLY, deliberately (2026-07-28). Research's edge memory holds 3 samples against testnet's
  // 19, and none in the regime family the market is in — its Direction longEdge/shortEdge can never
  // resolve, so its readiness verdict is noise dressed as evidence. Falling back to it on a testnet
  // blink swapped the answer for a different one with nothing on screen saying so, which is also what
  // made this panel look like it was flipping between two datasets by itself.
  const directionEntry = useShadowReport<DirectionEntryOutcomesResponse>('direction-entry-outcomes', DIRECTION_TESTNET_ONLY);
  const exitBrain = useShadowReport<ExitBrainReport>('exit-brain', DIRECTION_TESTNET_ONLY);
  const r = report.data;
  const [showAllDecisions, setShowAllDecisions] = useState(false);
  const [showEntryTier2, setShowEntryTier2] = useState(false);

  if (!r) {
    return (
      <section style={{ background: C.card, border: grouped ? 'none' : `1px solid ${C.border}`, borderRadius: grouped ? 0 : 10, marginBottom: grouped ? 0 : 18, padding: 16, color: C.dim }}>
        Four-Brain: loading…
      </section>
    );
  }

  const h = r.health;
  const decisionRows = r.recentDecisions.filter(isExecutiveDecision).filter((row) => isFocusedTestnetLane(row.laneId)).slice(0, 30);
  const visibleDecisionRows = showAllDecisions ? decisionRows : decisionRows.slice(0, 8);
  const latestDecision = decisionRows.find((row) => row.brains.direction != null || row.brains.entry != null || row.brains.exit != null) ?? decisionRows[0] ?? null;
  const latestSnapshot = r.recentDecisions.find(isMarketSnapshot) ?? null;
  const latestMarketState = latestSnapshot?.marketState ?? decisionRows.find((row) => row.brains.marketState)?.brains.marketState ?? null;
  const sourceLabel = report.source === 'testnet' ? 'sumber: testnet (3102)' : report.source === 'local' ? 'sumber: instance ini' : null;
  const deo = directionEntry.data;
  const deReport = deo?.report ?? null;
  const marketReadiness = marketStateDataProgress(latestMarketState);
  const directionReadiness = measuredReadinessProgress(deo?.readiness?.direction);
  const entryReadiness = exactFillEntryProgress(deo?.readiness?.entry, r.actualFillBindings);
  const exitReadiness = measuredReadinessProgress(exitBrain.data?.readiness);
  // Health rollup (2026-07-23 declutter): the ~11-chip breakdown moved behind a Disclosure —
  // this badge is the at-a-glance summary so collapsed state still communicates something.
  const healthErrorCount = h.ticks.gatherErrors + h.ticks.exceptions + h.ticks.journalErrors;
  const healthWarningCount = h.ticks.brainErrors + h.ticks.invariantFailures;
  const sourceFreshPcts = Object.values(h.sourceQuality).map((q) => q.freshPct);
  const avgFreshPct = sourceFreshPcts.length ? sourceFreshPcts.reduce((a, b) => a + b, 0) / sourceFreshPcts.length : null;
  const entryAdmission = r.actualFillBindings?.preEntryAdmission ?? r.actualFillBindings?.entryAdmission;
  const blockers = [
    marketReadiness.pct < 100 ? `Market State: ${marketReadiness.detail}` : null,
    directionReadiness.pct < 100 ? `Direction: ${directionReadiness.detail}` : null,
    entryReadiness.pct < 100 ? `Entry: ${entryReadiness.detail}` : null,
    exitReadiness.pct < 100 ? `Exit: ${exitReadiness.detail}` : null,
  ].filter((value): value is string => value != null);

  return (
    <section style={{ background: C.card, border: grouped ? 'none' : `1px solid ${C.border}`, borderRadius: grouped ? 0 : 10, overflow: 'hidden', marginBottom: grouped ? 0 : 18 }}>
      <header style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: C.text }}>Four-Brain — ringkasan keputusan</h2>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>
            Market State / Direction / Entry / Exit brain — 100% shadow, tidak pernah eksekusi/allocate. {sourceLabel && <span style={{ color: C.measure }}>{sourceLabel}</span>}
            {report.unreachable && report.data != null && <span style={{ color: C.accent }}> · koneksi putus — data terakhir</span>}
          </div>
        </div>
        <span style={{ color: C.dim, fontSize: 12 }}>refresh 60s</span>
      </header>

      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 9 }}>
          <div style={{ fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4 }}>Sekarang · 3 lane testnet</div>
          <div style={{ fontSize: 11, color: C.dim }}>{latestDecision ? `keputusan ${agoShort(new Date(latestDecision.asOfMs).toISOString())} lalu` : 'belum ada candidate aktif'}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))', gap: 8 }}>
          <FocusCell
            label="Market"
            value={marketStateLabel(latestMarketState)}
            detail={latestMarketState ? `confidence ${fmtPct(latestMarketState.confidence * 100)} · transition risk ${fmtPct(latestMarketState.transitionRisk * 100)}` : 'Belum ada market snapshot terbaru.'}
            color={marketReadiness.color}
          />
          <FocusCell
            label="Direction shadow"
            value={latestDecision?.brains.direction ? `${latestDecision.brains.direction.action} · ${fmtPct(latestDecision.brains.direction.confidence * 100)}` : 'Belum ada candidate'}
            detail={latestDecision?.brains.direction ? `${latestDecision.brains.direction.horizon} · ${latestDecision.laneId ?? 'lane —'} / ${latestDecision.symbolOrBasketId ?? 'symbol —'}` : 'Menunggu keputusan pada cross-sectional, directional, atau CG.'}
            color={latestDecision?.brains.direction?.action === 'LONG' ? C.good : latestDecision?.brains.direction?.action === 'SHORT' ? C.bad : C.dim}
          />
          <FocusCell
            label="Entry shadow"
            value={latestDecision?.brains.entry?.action ?? 'Belum ada keputusan'}
            detail={entryAdmission ? `${entryAdmission.validEnterNow} ENTER_NOW valid · ${entryAdmission.exactCandidatesRecorded} exact candidate pre-submit` : 'Cohort exact-fill belum tersedia.'}
            color={latestDecision?.brains.entry?.action === 'ENTER_NOW' ? C.good : C.accent}
          />
          <FocusCell
            label="Pengaruh ke executor"
            value={r.bridge?.active ? 'PILOT VETO SAJA' : 'SHADOW ONLY'}
            detail={r.bridge?.active ? `${r.bridge.evaluations ?? 0} evaluasi · ${r.bridge.blocked ?? 0} veto · tidak membuka order.` : 'Tidak membuka, menutup, atau mengalokasikan posisi.'}
            color={r.bridge?.active ? C.accent : C.measure}
          />
        </div>
        <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: C.sub, border: `1px solid ${C.border}`, fontSize: 11, lineHeight: 1.4, color: C.dim }}>
          <b style={{ color: C.text }}>{latestDecision ? 'Mengapa:' : 'Status:'}</b>{' '}
          {latestDecision?.reasons?.[0] ?? 'Belum ada keputusan pada tiga lane testnet yang sedang menjadi fokus.'}
        </div>
      </div>

      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 9 }}>
          <div style={{ fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4 }}>Kesiapan menuju pengaruh testnet</div>
          <div style={{ fontSize: 11, color: C.dim }}>bukti nyata · bukan confidence sinyal</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(205px, 1fr))', gap: 8 }}>
          <BrainReadinessTile name="Market State" progress={marketReadiness} title="Kesiapan data input market-state; bukan izin eksekusi." />
          <BrainReadinessTile name="Direction" progress={directionReadiness} title="Bukti arah dari outcome nyata testnet." />
          <BrainReadinessTile name="Entry" progress={entryReadiness} title="Hanya cohort exact actual-fill baru yang dihitung." />
          <BrainReadinessTile name="Exit" progress={exitReadiness} title="Jumlah sampel saja tidak cukup: edge harus lolos." />
        </div>
        <div style={{ marginTop: 9, fontSize: 11, lineHeight: 1.35, color: C.dim }}>
          100% berarti boleh dipertimbangkan untuk tahap pengaruh berikutnya.{' '}
          Bridge pilot: <b style={{ color: r.bridge?.active ? C.good : C.dim }}>{r.bridge?.active ? 'aktif' : 'belum aktif'}</b>
          {r.bridge?.active && <> · {r.bridge.evaluations ?? 0} evaluasi · {r.bridge.blocked ?? 0} veto</>}
          {' '}· hanya bukti negatif matang yang dapat memveto entry; boost positif tetap ranking shadow.
        </div>
        {blockers.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.45, color: C.dim }}>
            <b style={{ color: C.accent }}>Yang kurang sekarang:</b> {blockers.join(' · ')}
          </div>
        )}
      </div>

      {!r.enabled ? (
        <div style={{ padding: 16, color: C.dim, fontSize: 12 }}>
          Belum ada data — four-brain shadow mode belum aktif di instance ini (atau belum ada tick yang selesai).
        </div>
      ) : (
        <div style={{ padding: '10px 16px 14px' }}>
          <Disclosure
            summary={<><b style={{ color: C.measure }}>Bukti & audit detail</b><span style={{ color: C.dim }}> · {decisionRows.length} keputusan pada 3 lane · {healthErrorCount} error / {healthWarningCount} warning</span></>}
          >
            <div style={{ marginTop: 10, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
          {/* Health — rollup badge always visible, full ~11-chip breakdown behind a Disclosure
              (2026-07-23 declutter). */}
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Kesehatan runtime</div>
            <span style={{ fontSize: 13, fontWeight: 700, color: healthErrorCount > 0 ? C.bad : healthWarningCount > 0 ? C.accent : C.good }}>
              {healthErrorCount} errors / {healthWarningCount} warnings{avgFreshPct != null ? `, ${Math.round(avgFreshPct)}% fresh` : ''}
            </span>
            <Disclosure summary="details ▸">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                <StatRow label="tick attempted" value={String(h.ticks.attempted)} />
                <StatRow label="completed" value={String(h.ticks.completed)} color={C.good} />
                <StatRow label="skipped" value={String(h.ticks.skippedSingleFlight)} />
                <StatRow label="gather err" value={String(h.ticks.gatherErrors)} color={h.ticks.gatherErrors > 0 ? C.bad : undefined} />
                <StatRow label="exceptions" value={String(h.ticks.exceptions)} color={h.ticks.exceptions > 0 ? C.bad : undefined} />
                <StatRow label="brain err" value={String(h.ticks.brainErrors)} color={h.ticks.brainErrors > 0 ? C.accent : undefined} />
                <StatRow label="journal err" value={String(h.ticks.journalErrors)} color={h.ticks.journalErrors > 0 ? C.bad : undefined} />
                <StatRow label="invariant fail" value={String(h.ticks.invariantFailures)} color={h.ticks.invariantFailures > 0 ? C.accent : undefined} />
                <StatRow label="decisions" value={String(h.decisions.total)} />
                <StatRow label="lane coverage" value={`${h.coverage.lastLaneCoverage} (max ${h.coverage.maxLaneCoverage})`} />
                <StatRow label="position coverage" value={`${h.coverage.lastPositionCoverage} (max ${h.coverage.maxPositionCoverage})`} />
                <StatRow label="latency gather p50/p90" value={`${fmtMs(h.latencyMs.gather.p50)} / ${fmtMs(h.latencyMs.gather.p90)}`} />
              </div>
              {Object.keys(h.sourceQuality).length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 11, color: C.dim, marginBottom: 4 }}>source freshness (fresh / stale / missing)</div>
                  <div style={{ display: 'grid', gap: 5 }}>
                    {Object.entries(h.sourceQuality).map(([cls, q]) => (
                      <div key={cls} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                        <span style={{ width: 120, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cls}</span>
                        <Bar pct={q.freshPct} color={C.good} />
                        <span style={{ width: 130, textAlign: 'right', color: C.dim }}>
                          {fmtPct(q.freshPct)} / {fmtPct(q.stalePct)} / {fmtPct(q.missingPct)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Disclosure>
          </div>

          {/* Recent decisions */}
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
              Audit keputusan terbaru · 3 lane testnet
              {latestSnapshot?.marketState && (
                <span style={{ marginLeft: 8, textTransform: 'none', color: C.dim, fontWeight: 400 }}>
                  · State executor: <b style={{ color: C.text }}>{marketStateLabel(latestSnapshot.marketState)}</b>
                  {latestSnapshot.marketState.authority && <> · teknikal {latestSnapshot.marketState.family} (audit)</>}
                </span>
              )}
            </div>
            {decisionRows.length === 0 ? (
              <div style={{ fontSize: 12, color: C.dim }}>Belum ada decision — belum ada tick dengan candidate (lane/position) untuk instance ini.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ color: C.dim, textAlign: 'left' }}>
                      <th style={{ padding: '3px 6px' }}>lane / symbol</th>
                      <th style={{ padding: '3px 6px' }}>market state</th>
                      <th style={{ padding: '3px 6px' }}>direction</th>
                      <th style={{ padding: '3px 6px' }}>entry</th>
                      <th style={{ padding: '3px 6px' }}>exit</th>
                      <th style={{ padding: '3px 6px' }}>wouldAct</th>
                      <th style={{ padding: '3px 6px' }}>reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleDecisionRows.map((d) => (
                      <tr key={`${d.asOfMs}-${d.laneId ?? ''}-${d.symbolOrBasketId ?? ''}`} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td style={{ padding: '4px 6px', color: C.text, whiteSpace: 'nowrap' }}>{d.laneId ?? '—'} / {d.symbolOrBasketId ?? '—'}</td>
                        <td style={{ padding: '4px 6px', color: C.dim, whiteSpace: 'nowrap' }}>
                          {marketStateLabel(d.brains.marketState)}
                        </td>
                        <td style={{ padding: '4px 6px', color: C.dim, whiteSpace: 'nowrap' }}>
                          {d.brains.direction ? `${d.brains.direction.action} (${fmtPct(d.brains.direction.confidence * 100)})` : '—'}
                        </td>
                        <td style={{ padding: '4px 6px', color: C.dim, whiteSpace: 'nowrap' }}>{d.brains.entry?.action ?? '—'}</td>
                        <td style={{ padding: '4px 6px', color: C.dim, whiteSpace: 'nowrap' }}>
                          {d.brains.exit ? `${d.brains.exit.action}${d.brains.exit.edgeRemainingR != null ? ` (${fmtR(d.brains.exit.edgeRemainingR)})` : ''}` : '—'}
                        </td>
                        <td style={{ padding: '4px 6px', color: d.wouldAct ? C.good : C.dim, fontWeight: 700 }}>{d.wouldAct ? 'YES' : 'no'}</td>
                        <td style={{ padding: '4px 6px', color: C.dim, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.reasons?.join('; ')}>
                          {d.reasons?.[0] ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {decisionRows.length > 8 && (
                  <button
                    onClick={() => setShowAllDecisions((v) => !v)}
                    style={{ marginTop: 8, background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, color: C.measure, cursor: 'pointer', fontSize: 11, padding: '3px 8px' }}
                  >
                    {showAllDecisions ? 'tampilkan ringkas' : `tampilkan semua ${decisionRows.length}`}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Performance — Exit Brain: cut (2026-07-23 declutter) — this block used to duplicate
              InnovationLanesCard's Exit Brain row with strictly LESS detail (no coverage box).
              Exit Brain's real measured counterfactual lives there now; this is a pointer, not a
              re-render, so there is exactly one place to look for its numbers. */}
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Performance — Exit Brain</div>
            <div style={{ fontSize: 12, color: C.dim }}>
              Exit Brain performance — see <a href="#innovation-lanes" style={{ color: C.measure }}>Research &amp; Innovation Lanes</a> below (same measured counterfactual, full coverage detail).
            </div>
          </div>

          {/* Performance — Direction Brain (2026-07-23: GET /api/shadow/direction-entry-outcomes,
              never blended with Entry — see direction-entry-outcome-store.ts's own "NEVER BLENDED" doc). */}
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
              Performance — Direction Brain (measured, BTCUSDT proxy)
              <SourceBadge source={directionEntry.source} unreachable={directionEntry.unreachable} />
            </div>
            <ReadinessVerdict block={deo?.readiness?.direction} title="Vonis kesiapan" />
            {deo == null ? (
              <div style={{ fontSize: 12, color: C.dim }}>loading…</div>
            ) : !deo.enabled || deReport == null ? (
              <div style={{ fontSize: 12, color: C.dim }}>
                Belum aktif — outcome measurement mode belum di-enable di instance ini (reconciler belum jalan), atau belum ada tick yang selesai.
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                  <StatRow label="pending" value={String(deReport.direction.coverage.pending)} />
                  <StatRow label="evaluated" value={String(deReport.direction.coverage.evaluated)} color={C.good} />
                  <StatRow
                    label="instrument data missing"
                    value={String(deReport.direction.coverage.instrumentDataMissing)}
                    color={deReport.direction.coverage.instrumentDataMissing > 0 ? C.accent : undefined}
                    title="gauge cycle-saat-ini (transient, di-retry cycle berikutnya) — bukan angka kumulatif"
                  />
                  <StatRow label="expired unresolvable" value={String(deReport.direction.coverage.expiredUnresolvable)} />
                </div>
                {deReport.direction.coverage.evaluated + deReport.direction.coverage.expiredUnresolvable === 0 ? (
                  <div style={{ fontSize: 12, color: C.dim, marginTop: 8 }}>{deReport.direction.coverage.note}</div>
                ) : (
                  <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                    {deReport.direction.perHorizon
                      .filter((h) => h.n > 0)
                      .map((h) => (
                        <div key={h.horizon} style={{ background: C.sub, borderRadius: 6, padding: '6px 10px' }}>
                          <div style={{ fontSize: 12, color: C.text, fontWeight: 700 }}>
                            {h.horizon}{' '}
                            <span style={{ color: C.dim, fontWeight: 400 }}>
                              (n={h.n}, effectiveN={h.effectiveN}
                              {h.insufficientEffectiveSampleSize ? ', INSUFFICIENT_EFFECTIVE_SAMPLE_SIZE' : ''})
                            </span>
                          </div>
                          <div style={{ display: 'grid', gap: 3, marginTop: 4 }}>
                            {h.perAction
                              .filter((a) => a.n > 0)
                              .map((a) => (
                                <div key={a.action} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                                  <span style={{ width: 46, color: C.text, fontSize: 11 }}>{a.action}</span>
                                  <RateStatsInline rv={a} />
                                </div>
                              ))}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Entry readiness is DIRECT/ENTER_NOW exact-fill only. The audit below intentionally keeps
              legacy real-match and simulated outcomes visible, but neither can inflate readiness. */}
          <div style={{ padding: '12px 16px' }}>
            <div style={{ fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
              Audit Entry Brain (real-match executor + Tier 2 simulated — bukan cohort readiness)
              <SourceBadge source={directionEntry.source} unreachable={directionEntry.unreachable} />
            </div>
            <ReadinessVerdict block={deo?.readiness?.entry} title="Vonis kesiapan" />
            {deo == null ? (
              <div style={{ fontSize: 12, color: C.dim }}>loading…</div>
            ) : !deo.enabled || deReport == null ? (
              <div style={{ fontSize: 12, color: C.dim }}>
                Belum aktif — outcome measurement mode belum di-enable di instance ini (reconciler belum jalan), atau belum ada tick yang selesai.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.45, marginBottom: 8 }}>
                  Readiness hanya menghitung keputusan <span style={{ color: C.measure }}>DIRECT/ENTER_NOW</span> dengan exact actual-fill.
                  Audit di bawah dapat berisi WAIT/SKIP yang dicocokkan ke fill executor; itu tidak menambah readiness atau reinforcement.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                  <StatRow label="pending" value={String(deReport.entry.coverage.pending)} />
                  <StatRow
                    label="real-match audit"
                    value={String(deReport.entry.coverage.resolvedRealMatch)}
                    color={C.good}
                    title="Real exchange outcome yang dicocokkan ke keputusan Four-Brain, termasuk WAIT/SKIP; bukan DIRECT/ENTER_NOW exact-fill."
                  />
                  <StatRow label="Tier 2 resolved" value={String(deReport.entry.coverage.resolvedSimulated)} color={C.measure} />
                  <StatRow
                    label="instrument data missing"
                    value={String(deReport.entry.coverage.instrumentDataMissing)}
                    color={deReport.entry.coverage.instrumentDataMissing > 0 ? C.accent : undefined}
                    title="gauge cycle-saat-ini (transient) — bukan angka kumulatif"
                  />
                  <StatRow label="expired unresolvable" value={String(deReport.entry.coverage.expiredUnresolvable)} />
                </div>
                {deReport.entry.coverage.resolvedRealMatch + deReport.entry.coverage.resolvedSimulated + deReport.entry.coverage.expiredUnresolvable === 0 ? (
                  <div style={{ fontSize: 12, color: C.dim, marginTop: 8 }}>{deReport.entry.coverage.note}</div>
                ) : (
                  <>
                    {/* Tier 1 real-match audit is always visible; Tier 2 stays behind an explicit
                        toggle. Neither audit tier is blended into the direct exact-fill readiness cohort. */}
                    {(showEntryTier2 ? (['TIER1_REALIZED', 'TIER2_SIMULATED'] as const) : (['TIER1_REALIZED'] as const)).map((tier) => {
                      const rows = deReport.entry.perAction.filter((a) => a.tier === tier && a.n > 0);
                      const calib = deReport.entry.calibration.find((c) => c.tier === tier) ?? null;
                      if (rows.length === 0 && (calib == null || calib.n === 0)) return null;
                      return (
                        <div key={tier} style={{ marginTop: 10, background: C.sub, borderRadius: 6, padding: '8px 10px' }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: deTierColor(tier) }}>{deTierLabel(tier)}</div>
                          <div style={{ display: 'grid', gap: 3, marginTop: 4 }}>
                            {rows.map((a) => {
                              const deemphasize = a.confidence === 'EXPERIMENTAL_COST_OF_CAUTION';
                              return (
                                <div
                                  key={`${a.action}-${a.confidence}`}
                                  style={{ display: 'flex', gap: 8, alignItems: 'baseline', opacity: deemphasize ? 0.6 : 1 }}
                                >
                                  <span
                                    style={{ width: 140, color: deemphasize ? C.dim : C.text, fontSize: 11, fontStyle: deemphasize ? 'italic' : undefined }}
                                  >
                                    {a.action}
                                    {deemphasize ? '†' : ''}
                                  </span>
                                  <RateStatsInline rv={a} dim={deemphasize} />
                                </div>
                              );
                            })}
                          </div>
                          {calib && calib.n > 0 && (
                            <div style={{ marginTop: 6, fontSize: 11, color: C.dim }}>
                              calibration (expected − realized): <RateStatsInline rv={calib} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <button
                      onClick={() => setShowEntryTier2((v) => !v)}
                      style={{ marginTop: 8, background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, color: C.measure, cursor: 'pointer', fontSize: 11, padding: '3px 8px' }}
                    >
                      {showEntryTier2 ? 'sembunyikan Tier 2 (simulated)' : 'tampilkan Tier 2 (simulated) ▸'}
                    </button>
                    {showEntryTier2 && (
                      <div style={{ fontSize: 10, color: C.dim, marginTop: 8, lineHeight: 1.5 }}>
                        † EXPERIMENTAL_COST_OF_CAUTION — baris WAIT_*/SKIP tidak pernah benar-benar dieksekusi; angka ini simulasi
                        biaya kehati-hatian (forward candle walk), bukan MEASURED seperti ENTER_NOW. Jangan dibaca setara.
                      </div>
                    )}
                  </>
                )}
              </>
            )}
            {deo && deo.enabled && deReport?.cycleMeta.lastRunAtIso && (
              <div style={{ fontSize: 10, color: C.dim, marginTop: 10 }}>
                reconciler cycle {agoShort(deReport.cycleMeta.lastRunAtIso)} lalu
                {deReport.cycleMeta.lastError && <span style={{ color: C.bad }}> · error: {deReport.cycleMeta.lastError}</span>}
              </div>
            )}
          </div>
            </div>
          </Disclosure>
        </div>
      )}
    </section>
  );
}
