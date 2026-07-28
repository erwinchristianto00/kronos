import { useState } from 'react';
import { useShadowReport } from './InnovationLanesCard';
import { Disclosure } from './LaneMaturityTable';

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

type MarketStateBrainView = {
  family: string;
  bias: string;
  volatility: string;
  liquidity: string;
  confidence: number;
  transitionRisk: number;
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
};

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
type FourBrainReadinessGate = {
  gate: 'EVIDENCE' | 'EDGE' | 'SELECTION' | 'CALIBRATION';
  passed: boolean | null;
  value: number | null;
  detail: string;
};
type FourBrainReadinessScope = {
  scope: string;
  verdict: 'READY' | 'NOT_READY' | 'INSUFFICIENT_EVIDENCE' | 'NOT_READY_SIMULATED_ONLY';
  summary: string;
  gates: FourBrainReadinessGate[];
};
type FourBrainReadinessBlock = {
  verdict: FourBrainReadinessScope['verdict'];
  summary: string;
  perScope: FourBrainReadinessScope[];
};
type DirectionEntryOutcomesResponse = {
  reportOnly: true;
  generatedAt: string;
  enabled: boolean;
  readiness?: { direction: FourBrainReadinessBlock; entry: FourBrainReadinessBlock } | null;
  report: DirectionEntryOutcomeReport | null;
};

/** READY is the only green. NOT_READY_SIMULATED_ONLY is deliberately NOT neutral — a brain whose
 *  numbers look excellent but come entirely from a counterfactual walk is the single most dangerous
 *  thing on this card, so it reads as a warning, not as "still collecting". */
const readinessColor = (v: FourBrainReadinessScope['verdict']): string =>
  v === 'READY' ? C.good : v === 'NOT_READY' ? C.bad : v === 'NOT_READY_SIMULATED_ONLY' ? C.accent : C.dim;
const readinessLabel = (v: FourBrainReadinessScope['verdict']): string =>
  v === 'READY' ? 'SIAP' : v === 'NOT_READY' ? 'BELUM SIAP' : v === 'NOT_READY_SIMULATED_ONLY' ? 'SIMULASI SAJA' : 'BUKTI KURANG';

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
          : 'Testnet tidak menjawab, jadi angka ini dari instance LOKAL (research/3101) — dataset yang BERBEDA, bukan data testnet yang berubah.'
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

function ReadinessVerdict({ block, title }: { block: FourBrainReadinessBlock | undefined; title: string }) {
  if (!block) return null;
  return (
    <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 6, background: C.track, border: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4 }}>{title}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: readinessColor(block.verdict) }}>{readinessLabel(block.verdict)}</span>
        <span style={{ fontSize: 12, color: C.sub }}>{block.summary}</span>
      </div>
      <div style={{ marginTop: 6, display: 'grid', gap: 2 }}>
        {block.perScope.map((s) => (
          <div key={s.scope} style={{ fontSize: 11, color: C.dim, display: 'flex', gap: 6 }}>
            <span style={{ minWidth: 150, color: C.sub }}>{s.scope}</span>
            <span style={{ minWidth: 92, color: readinessColor(s.verdict) }}>{readinessLabel(s.verdict)}</span>
            <span>{s.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const isExecutiveDecision = (r: RecentRecord): r is ExecutiveDecisionRecord => r.kind === 'EXECUTIVE_DECISION';
const isMarketSnapshot = (r: RecentRecord): r is MarketSnapshotRecord => r.kind === 'MARKET_SNAPSHOT';

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

const agoShort = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

const deTierLabel = (t: DEEntryTier) => (t === 'TIER1_REALIZED' ? 'TIER 1 — REAL FILL' : 'TIER 2 — SIMULATED');
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

export function FourBrainDashboardCard() {
  const report = useShadowReport<FourBrainReport>('four-brain');
  const directionEntry = useShadowReport<DirectionEntryOutcomesResponse>('direction-entry-outcomes');
  const r = report.data;
  const [showAllDecisions, setShowAllDecisions] = useState(false);
  const [showEntryTier2, setShowEntryTier2] = useState(false);

  if (!r) {
    return (
      <section style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 18, padding: 16, color: C.dim }}>
        Four-Brain: loading…
      </section>
    );
  }

  const h = r.health;
  const decisionRows = r.recentDecisions.filter(isExecutiveDecision).slice(0, 30);
  const visibleDecisionRows = showAllDecisions ? decisionRows : decisionRows.slice(0, 8);
  const latestSnapshot = r.recentDecisions.find(isMarketSnapshot) ?? null;
  const sourceLabel = report.source === 'testnet' ? 'sumber: testnet (3102)' : report.source === 'local' ? 'sumber: instance ini' : null;
  const deo = directionEntry.data;
  const deReport = deo?.report ?? null;
  // Health rollup (2026-07-23 declutter): the ~11-chip breakdown moved behind a Disclosure —
  // this badge is the at-a-glance summary so collapsed state still communicates something.
  const healthErrorCount = h.ticks.gatherErrors + h.ticks.exceptions + h.ticks.journalErrors;
  const healthWarningCount = h.ticks.brainErrors + h.ticks.invariantFailures;
  const sourceFreshPcts = Object.values(h.sourceQuality).map((q) => q.freshPct);
  const avgFreshPct = sourceFreshPcts.length ? sourceFreshPcts.reduce((a, b) => a + b, 0) / sourceFreshPcts.length : null;

  return (
    <section style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 18 }}>
      <header style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: C.text }}>Four-Brain (shadow decision layer)</h2>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>
            Market State / Direction / Entry / Exit brain — 100% shadow, tidak pernah eksekusi/allocate. {sourceLabel && <span style={{ color: C.measure }}>{sourceLabel}</span>}
            {report.unreachable && report.data != null && <span style={{ color: C.accent }}> · koneksi putus — data terakhir</span>}
          </div>
        </div>
        <span style={{ color: C.dim, fontSize: 12 }}>refresh 60s</span>
      </header>

      {!r.enabled ? (
        <div style={{ padding: 16, color: C.dim, fontSize: 12 }}>
          Belum ada data — four-brain shadow mode belum aktif di instance ini (atau belum ada tick yang selesai).
        </div>
      ) : (
        <>
          {/* Health — rollup badge always visible, full ~11-chip breakdown behind a Disclosure
              (2026-07-23 declutter). */}
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Health</div>
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
              Recent decisions
              {latestSnapshot?.marketState && (
                <span style={{ marginLeft: 8, textTransform: 'none', color: C.dim, fontWeight: 400 }}>
                  · Market State terakhir: <b style={{ color: C.text }}>{latestSnapshot.marketState.family}</b> / {latestSnapshot.marketState.bias} (conf {fmtPct(latestSnapshot.marketState.confidence * 100)})
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
                          {d.brains.marketState ? `${d.brains.marketState.family}/${d.brains.marketState.bias}` : '—'}
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
                    {showAllDecisions ? 'show fewer' : `show all ${decisionRows.length}`}
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

          {/* Performance — Entry Brain: Tier 1 (real fill) vs Tier 2 (simulated) ALWAYS two separate
              blocks, never one blended number (requirement: visibly distinct). WAIT/SKIP rows (confidence
              EXPERIMENTAL_COST_OF_CAUTION) are dimmed + footnoted relative to ENTER_NOW (MEASURED). */}
          <div style={{ padding: '12px 16px' }}>
            <div style={{ fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
              Performance — Entry Brain (measured, Tier 1 real fill + Tier 2 simulated — tidak pernah digabung)
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
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                  <StatRow label="pending" value={String(deReport.entry.coverage.pending)} />
                  <StatRow label="Tier 1 resolved" value={String(deReport.entry.coverage.resolvedRealMatch)} color={C.good} />
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
                    {/* Tier 1 (real fill) always visible; Tier 2 (simulated) behind an explicit
                        toggle — never rendered blended into one number (2026-07-23 declutter). */}
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
        </>
      )}
    </section>
  );
}
