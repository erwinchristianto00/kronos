import { useEffect, useState } from 'react';

type CortexCollectionStatus = {
  collection: { mode: 'shadow' | 'off'; instanceId: string; status: string; journalBadLines: number };
  lineage: {
    totalEvents: number; decisionSnapshots: number; outcomesResolved: number; unresolvedOpportunities: number;
    directOutcomes: number; ambiguousOutcomes: number; economicWins: number; economicWinHurdleR: number;
  };
  cortex: {
    brainPresent: boolean; cumulativeResolved: number; liveBeta: number;
    archetypes: Record<string, { effectiveSamples: number }>;
    latestRefit: {
      at: string; examplesNew: number; examplesTotal: number;
      statuses: Array<{ archetype: string; status: string; effectiveSamples: number }>;
      coverage: { cumulativeResolved: number; regimeFamiliesWithOutcomes: number; regimeCoverageGateMet: boolean; learningActiveLanes: number; blindCapitalPct: number; evaluationBeta: number };
      lanes: Array<{ laneId: string; archetype: string; status: string; outcomesSeen: number; attributed: number; positive: number; noReward: number; unattributedNoDecision: number; schemaMismatch: number; duplicateDropped: number }>;
    } | null;
  };
  learning: {
    reportOnly: boolean; positiveDefinition: string;
    causalLabels: { POSITIVE: number; NON_POSITIVE: number; EXCLUDED: number };
    minAttributedExamplesPerLane: number;
    recentCausalOutcomes: Array<{ resolvedAt: string | null; laneId: string | null; symbolOrBasketId: string | null; direction: string | null; regime: string | null; netR: number | null; grossR: number | null; costR: number | null; exitReason: string | null; reinforcement: 'POSITIVE' | 'NON_POSITIVE' | 'EXCLUDED'; exclusionReason: string | null }>;
  };
};

const C = { card: '#14222a', border: '#20313a', text: '#dbe7ec', dim: '#7d97a3', good: '#46d39a', bad: '#ff6b6b', measure: '#6fb3d6', accent: '#f0b54b' };
const INSTANCES = [
  ['research', 'Collector / research', '/api/shadow/cortex-collection-status'],
  ['testnet', 'Testnet', '/testnet/api/shadow/cortex-collection-status'],
  ['live', 'Live mainnet', '/live/api/shadow/cortex-collection-status'],
] as const;

const ago = (timestamp: string) => {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
};

const fmtR = (value: number | null) => value == null || !Number.isFinite(value) ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(3)}R`;
const outcomeColor = (value: 'POSITIVE' | 'NON_POSITIVE' | 'EXCLUDED') => value === 'POSITIVE' ? C.good : value === 'NON_POSITIVE' ? C.bad : C.accent;

export function CortexCollectionStatusCard() {
  const [status, setStatus] = useState<Record<string, CortexCollectionStatus | null>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const entries = await Promise.all(INSTANCES.map(async ([key, _label, url]) => {
        try {
          const response = await fetch(url, { cache: 'no-store' });
          if (!response.ok) return [key, null] as const;
          return [key, await response.json() as CortexCollectionStatus] as const;
        } catch {
          return [key, null] as const;
        }
      }));
      if (!cancelled) setStatus(Object.fromEntries(entries));
    };
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  return (
    <section style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 18 }}>
      <header style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: C.text }}>CORTEX collection &amp; causal lineage</h2>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>Append-only decision → opportunity → outcome evidence. Read-only: never changes allocation or orders.</div>
        </div>
        <span style={{ color: C.dim, fontSize: 12 }}>refreshes 10s</span>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        {INSTANCES.map(([key, label]) => {
          const item = status[key];
          if (!item) return <div key={key} style={{ padding: 16, borderRight: `1px solid ${C.border}`, color: C.dim }}>{label}: loading or unreachable…</div>;
          const collecting = item.collection.mode === 'shadow';
          const winRate = item.lineage.outcomesResolved > 0 ? item.lineage.economicWins / item.lineage.outcomesResolved : null;
          const labels = item.learning.causalLabels;
          const refit = item.cortex.latestRefit;
          return (
            <div key={key} style={{ padding: '14px 16px', borderRight: `1px solid ${C.border}`, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                <strong style={{ color: C.text }}>{label}</strong>
                <span style={{ color: collecting ? C.good : C.accent, fontSize: 11, fontWeight: 700 }}>{collecting ? 'SHADOW COLLECTING' : item.collection.status.toUpperCase()}</span>
              </div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, padding: '8px 0', borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, color: C.dim }}>
                <span>snapshots <b style={{ color: C.text }}>{item.lineage.decisionSnapshots}</b></span>
                <span>open / resolved <b style={{ color: C.text }}>{item.lineage.unresolvedOpportunities} / {item.lineage.outcomesResolved}</b></span>
                <span>wins &gt;{item.lineage.economicWinHurdleR.toFixed(2)}R <b style={{ color: winRate == null ? C.dim : winRate >= 0.5 ? C.good : C.bad }}>{winRate == null ? '—' : `${item.lineage.economicWins}/${item.lineage.outcomesResolved} (${Math.round(winRate * 100)}%)`}</b></span>
              </div>
              <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.6, marginTop: 8 }}>
                <div>Lineage: <span style={{ color: C.text }}>{item.lineage.totalEvents}</span> events · {item.lineage.directOutcomes}/{item.lineage.outcomesResolved} direct · {item.lineage.ambiguousOutcomes} ambiguous</div>
                <div>CORTEX refit: <span style={{ color: item.cortex.brainPresent ? C.good : C.dim }}>{item.cortex.brainPresent ? `${item.cortex.cumulativeResolved} attributed outcomes` : 'not running on this instance'}</span></div>
                <div>Archetypes: {Object.entries(item.cortex.archetypes).map(([name, value]) => <span key={name} style={{ color: value.effectiveSamples > 0 ? C.measure : C.dim, marginRight: 8 }}>{name} nEff {value.effectiveSamples.toFixed(1)}</span>)}</div>
                <div>{refit ? <>Latest refit {ago(refit.at)} ago · +{refit.examplesNew} new · {refit.statuses.map((entry) => `${entry.archetype}: ${entry.status}`).join(', ')}</> : 'No refit has run on this instance.'}</div>
                <div>Safety: live beta <span style={{ color: C.good, fontWeight: 700 }}>{item.cortex.liveBeta.toFixed(2)}</span>{item.collection.journalBadLines ? <span style={{ color: C.bad }}> · {item.collection.journalBadLines} unreadable journal line(s)</span> : null}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, fontSize: 11 }}>
                <span style={{ color: C.good }}>positive {labels.POSITIVE}</span>
                <span style={{ color: C.bad }}>non-positive {labels.NON_POSITIVE}</span>
                <span style={{ color: C.accent }}>excluded {labels.EXCLUDED}</span>
              </div>
              <details open={key !== 'live'} style={{ marginTop: 11, borderTop: `1px solid ${C.border}`, paddingTop: 9 }}>
                <summary style={{ cursor: 'pointer', color: C.measure, fontSize: 12, fontWeight: 700 }}>Learning ledger &amp; progress</summary>
                <div style={{ color: C.dim, fontSize: 11, lineHeight: 1.45, marginTop: 8 }}>{item.learning.positiveDefinition}. `Excluded` stays visible but cannot be used as a label.</div>
                {refit ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: C.dim, marginTop: 8 }}>
                  <span><b style={{ color: C.text }}>{refit.coverage.learningActiveLanes}</b> active lanes</span>
                  <span><b style={{ color: C.text }}>{refit.coverage.regimeFamiliesWithOutcomes}</b> regime families</span>
                  <span>eval beta <b style={{ color: C.measure }}>{refit.coverage.evaluationBeta.toFixed(2)}</b></span>
                  <span>blind capital <b style={{ color: refit.coverage.blindCapitalPct > 0 ? C.accent : C.good }}>{refit.coverage.blindCapitalPct.toFixed(1)}%</b></span>
                </div> : null}
                <div style={{ marginTop: 9, display: 'grid', gap: 5 }}>
                  {item.learning.recentCausalOutcomes.length ? item.learning.recentCausalOutcomes.slice(0, 6).map((outcome, index) => (
                    <div key={`${outcome.resolvedAt ?? index}-${outcome.laneId ?? ''}`} style={{ display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr) auto', gap: 7, alignItems: 'center', borderTop: `1px solid ${C.border}`, paddingTop: 5, fontSize: 11 }}>
                      <span style={{ color: outcomeColor(outcome.reinforcement), fontWeight: 700 }}>{outcome.reinforcement === 'NON_POSITIVE' ? 'NO REWARD' : outcome.reinforcement}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.text }}>{outcome.laneId ?? 'unknown lane'} · {outcome.symbolOrBasketId ?? 'unknown symbol'} · {outcome.direction ?? 'n/a'}{outcome.regime ? ` · ${outcome.regime}` : ''}</span>
                      <span style={{ color: outcome.netR != null && outcome.netR > 0 ? C.good : C.bad }}>{fmtR(outcome.netR)}</span>
                    </div>
                  )) : <div style={{ color: C.dim, fontSize: 11, marginTop: 8 }}>No resolved causal outcome yet.</div>}
                </div>
                {refit ? <div style={{ marginTop: 10 }}>
                  <div style={{ color: C.dim, fontSize: 11, marginBottom: 5 }}>Refit attribution: each lane needs {item.learning.minAttributedExamplesPerLane} valid owner-linked examples to become `LEARNING_ACTIVE`.</div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    {refit.lanes.filter((lane) => lane.outcomesSeen > 0 || lane.status !== 'INSUFFICIENT_DATA').slice(0, 12).map((lane) => (
                      <div key={lane.laneId} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto auto', gap: 7, fontSize: 11, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>
                        <span style={{ color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lane.laneId}</span>
                        <span style={{ color: lane.status === 'LEARNING_ACTIVE' ? C.good : C.accent }}>{lane.attributed}/{item.learning.minAttributedExamplesPerLane}</span>
                        <span style={{ color: lane.positive > lane.noReward ? C.good : lane.positive === lane.noReward ? C.dim : C.bad }}>+{lane.positive} / {lane.noReward} no reward</span>
                        <span style={{ color: C.dim }}>{lane.status.replaceAll('_', ' ')}</span>
                      </div>
                    ))}
                  </div>
                </div> : null}
              </details>
            </div>
          );
        })}
      </div>
      <div style={{ padding: '9px 16px', fontSize: 11, color: C.dim, borderTop: `1px solid ${C.border}` }}>
        “Resolved” is raw causal evidence. “CORTEX refit” is the eligible attributed subset consumed by the six-hour shadow batch, so the counters are intentionally different. Live remains blocked as a causal training source.
      </div>
    </section>
  );
}
