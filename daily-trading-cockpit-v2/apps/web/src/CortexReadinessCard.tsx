import { useEffect, useRef, useState } from 'react';
import { Disclosure } from './LaneMaturityTable';

// CORTEX Readiness card (2026-07-21 operator ask) — /research only. Headline "Kesiapan CORTEX" % +
// component breakdown + progress/hari + ETA + status + kualitas data + lineage + reinforcement.
// Data preference: TESTNET (3102) — that's where promotion is actually being proven since 2026-07-21 —
// via (1) the local endpoint's server-side peer relay (CORTEX_READINESS_PEER_URL), else (2) a direct
// browser fetch through the /testnet Caddy prefix (same precedent as CortexCollectionStatusCard's
// INSTANCES), else (3) research's own local readiness, labeled honestly. Polls 60s (matches the
// collection card — the refit cycle behind most of these numbers only advances every ~6h anyway).

type Component = { key: string; pct: number; weight: number; detail: string };
type Readiness = {
  formulaVersion: number;
  formula: string;
  readyDefinition: string;
  readinessPct: number;
  ready: boolean;
  components: Component[];
  beta: { evaluationBeta: number; promotedBeta: number; betaMax: number };
  rate: {
    pctPerDay: number | null;
    basis: 'history' | 'ledger-beta-only' | null;
    basisNote: string;
    resolvedPerDay: Array<{ dateUtc: string; resolved: number }>;
  };
  eta: { etaDays: number | null; etaIso: string | null; reason: string | null };
  status: { state: 'STEADY_PROGRESS' | 'SLOWED_DOWN' | 'STUCK'; last24hResolved: number; prior7dAvgPerDay: number; ratioPct: number | null };
  quality: {
    cumulativeResolved: number;
    examplesTotal: number | null;
    examplesGap: number | null;
    journalBadLines: number | null;
    archetypes: Array<{ archetype: string; status: string; examples: number }>;
    familyBalance: Array<{ family: string; resolved: number; sharePct: number }>;
    largestFamilySharePct: number | null;
    lanes: { total: number; learningActive: number; insufficientData: number; noOutcomeSource: number; schemaMismatch: number };
  };
  lineage: {
    mode: string; instanceId: string; totalEvents: number; decisionSnapshots: number; opportunitiesOpened: number;
    outcomesResolved: number; unresolvedOpportunities: number; validOutcomes: number; directOutcomes: number; economicWins: number; latestAt: string | null;
  } | null;
  reinforcement: {
    positive: number; noReward: number; positiveSharePct: number | null;
    refitAccepted: number; refitRejected: number; refitNoExamples: number;
    decisionAlpha: { n: number; cumulativeTiltDeltaR: number; meanTiltDeltaR: number | null; perLane: Array<{ laneId: string; n: number; cumulativeTiltDeltaR: number }> } | null;
  };
  inputsPresent: { brain: boolean; refit: boolean; collection: boolean; decisionAlpha: boolean; historyDays: number };
};
type ReadinessResponse = { reportOnly: true; generatedAt: string; instanceId: string; local: Readiness; peer: { url: string; label: string; report: Readiness } | null; peerError: string | null };

const C = { card: '#14222a', sub: '#0f1c23', border: '#20313a', text: '#dbe7ec', dim: '#7d97a3', good: '#46d39a', bad: '#ff6b6b', measure: '#6fb3d6', accent: '#f0b54b', track: '#1c2c34' };

const COMPONENT_LABELS: Record<string, string> = {
  betaRamp: 'β-ramp (resolved/300)',
  capitalCoverage: 'Cakupan kapital (100−blind)',
  laneCoverage: 'Lane LEARNING_ACTIVE',
  regimeCoverage: 'Cakupan regime family',
};
const STATUS_LABEL: Record<Readiness['status']['state'], { text: string; color: string }> = {
  STEADY_PROGRESS: { text: 'STEADY PROGRESS', color: C.good },
  SLOWED_DOWN: { text: 'SLOWED DOWN', color: C.accent },
  STUCK: { text: 'STUCK', color: C.bad },
};

const fmtR = (v: number | null) => (v == null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}R`);

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ flex: 1, height: 10, background: C.track, borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', background: color }} />
    </div>
  );
}

export function CortexReadinessCard() {
  const [data, setData] = useState<ReadinessResponse | null>(null);
  const [testnetDirect, setTestnetDirect] = useState<Readiness | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    const load = async () => {
      const seq = ++seqRef.current;
      let gotLocal = false;
      try {
        const res = await fetch('/api/shadow/cortex-readiness', { cache: 'no-store' });
        if (res.ok) {
          const body = (await res.json()) as ReadinessResponse;
          if (seq === seqRef.current) {
            setData(body);
            gotLocal = true;
          }
        }
      } catch { /* keep last */ }
      if (seq === seqRef.current) setUnreachable(!gotLocal);
      // Browser-side testnet fallback through the Caddy /testnet prefix (only used when the server-side
      // peer relay isn't configured) — same cross-instance precedent as CortexCollectionStatusCard.
      try {
        const res = await fetch('/testnet/api/shadow/cortex-readiness', { cache: 'no-store' });
        if (res.ok) {
          const body = (await res.json()) as ReadinessResponse;
          if (seq === seqRef.current && body?.local && Number.isFinite(body.local.readinessPct)) setTestnetDirect(body.local);
        }
      } catch { /* not reachable outside the VPS — fine */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!data) {
    return (
      <section style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 18, padding: 16, color: C.dim }}>
        Kesiapan CORTEX: loading…
      </section>
    );
  }

  const source = data.peer
    ? { report: data.peer.report, label: `sumber: ${data.peer.label}` }
    : testnetDirect
      ? { report: testnetDirect, label: 'sumber: testnet (3102) — via /testnet' }
      : { report: data.local, label: `sumber: ${data.instanceId} (lokal — testnet tidak terjangkau${data.peerError ? `: ${data.peerError}` : ''})` };
  const r = source.report;
  const headlineColor = r.ready ? C.good : r.readinessPct >= 60 ? C.measure : r.readinessPct >= 30 ? C.accent : C.bad;
  const st = STATUS_LABEL[r.status.state];
  const maxDay = Math.max(1, ...r.rate.resolvedPerDay.map((d) => d.resolved));
  const q = r.quality;
  const rf = r.reinforcement;
  const da = rf.decisionAlpha;

  return (
    <section style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 18 }}>
      <header style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: C.text }}>Kesiapan CORTEX</h2>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>
            Progres menuju gate promosi (β-ramp + cakupan) — meteran, BUKAN promosi otomatis. <span style={{ color: C.measure }}>{source.label}</span>
            {unreachable && <span style={{ color: C.accent }}> · koneksi putus — data terakhir</span>}
          </div>
        </div>
        <span style={{ color: C.dim, fontSize: 12 }}>refresh 60s</span>
      </header>

      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {/* headline + components */}
        <div style={{ flex: '1 1 340px', minWidth: 300, padding: '14px 16px', borderRight: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <span title={`${r.formula}\n\n${r.readyDefinition}`} style={{ fontSize: 38, fontWeight: 700, color: headlineColor, cursor: 'help' }}>
              {r.readinessPct.toFixed(1)}%
            </span>
            {r.ready && <span style={{ color: C.good, fontWeight: 700, fontSize: 12 }}>READY — semua komponen 100%</span>}
            <span style={{ color: C.dim, fontSize: 11 }}>β promosi {r.beta.promotedBeta.toFixed(3)} / max {r.beta.betaMax.toFixed(2)}</span>
          </div>
          <div style={{ marginTop: 10, display: 'grid', gap: 7 }}>
            {r.components.map((c) => (
              <div key={c.key} title={c.detail} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'help' }}>
                <span style={{ width: 168, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{COMPONENT_LABELS[c.key] ?? c.key}</span>
                <Bar pct={c.pct} color={c.pct >= 100 ? C.good : C.measure} />
                <span style={{ width: 52, textAlign: 'right', color: c.pct >= 100 ? C.good : C.text, fontWeight: 600 }}>{c.pct.toFixed(1)}%</span>
                <span style={{ width: 36, textAlign: 'right', color: C.dim }}>×{Math.round(c.weight * 100)}%</span>
              </div>
            ))}
          </div>
          <div style={{ color: C.dim, fontSize: 10, marginTop: 8, lineHeight: 1.5 }}>
            Formula terbuka (hover angka besar / tiap bar): semua komponen = input gate promosi yang sebenarnya, tidak ada angka black-box.
          </div>
        </div>

        {/* rate + ETA + status — condensed to one always-visible line (2026-07-23 declutter;
            used to be 3 separately-labeled stacked blocks). The resolved/day histogram stays as
            a compact sparkline right underneath so the 7-day trend isn't lost. */}
        <div style={{ flex: '1 1 300px', minWidth: 280, padding: '14px 16px', borderRight: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4 }}>Progress/hari · ETA · status</div>
          <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
            <span
              title={r.rate.basisNote}
              style={{ fontWeight: 700, fontSize: 18, color: r.rate.pctPerDay == null ? C.dim : r.rate.pctPerDay > 0 ? C.good : C.bad, cursor: 'help' }}
            >
              {r.rate.pctPerDay == null ? '—' : `${r.rate.pctPerDay >= 0 ? '+' : ''}${r.rate.pctPerDay.toFixed(2)}%/hari`}
            </span>
            <span style={{ color: C.dim }}>·</span>
            <span style={{ fontSize: 13, color: r.eta.etaDays == null ? C.dim : C.text }}>
              {r.eta.etaDays == null
                ? (r.eta.reason ?? 'ETA belum bisa diestimasi')
                : r.eta.etaDays === 0
                  ? 'sudah ready'
                  : `ETA ~${r.eta.etaDays.toFixed(1)} hari (${r.eta.etaIso ? new Date(r.eta.etaIso).toISOString().slice(0, 10) : ''})`}
            </span>
            <span style={{ color: C.dim }}>·</span>
            <span
              title={`24h: ${r.status.last24hResolved} resolved · rata-rata 7d sebelumnya: ${r.status.prior7dAvgPerDay.toFixed(1)}/hari${r.status.ratioPct != null ? ` · ${r.status.ratioPct.toFixed(0)}% dari rata-rata (ambang 60%)` : ''}`}
              style={{ color: st.color, fontWeight: 700, fontSize: 13, cursor: 'help' }}
            >
              {st.text}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 30, marginTop: 8 }}>
            {r.rate.resolvedPerDay.map((d) => (
              <div key={d.dateUtc} title={`${d.dateUtc}: ${d.resolved} resolved`} style={{ width: 18, height: `${(d.resolved / maxDay) * 24 + 2}px`, background: d.resolved > 0 ? C.measure : C.sub, borderRadius: 2 }} />
            ))}
          </div>
          <div style={{ fontSize: 10, color: C.dim }}>resolved outcome per hari UTC (7 hari, dari ledger exact-once) — hover angka rate/ETA/status di atas untuk detail</div>
        </div>

        {/* quality + lineage + reinforcement — collapsed by default (2026-07-23 declutter):
            these are diagnostic depth, not the headline. Click to expand, unchanged content. */}
        <div style={{ flex: '1 1 320px', minWidth: 300, padding: '14px 16px' }}>
          <Disclosure summary="Data Quality, Lineage & Reinforcement ▸">
            <div style={{ fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4 }}>Kualitas data</div>
            <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.7, marginTop: 4 }}>
              <div>
                labeled examples <b style={{ color: C.text }}>{q.examplesTotal ?? '—'}</b> dari <b style={{ color: C.text }}>{q.cumulativeResolved}</b> resolved
                {q.examplesGap != null && q.examplesGap > 0 && <span title="outcome yang ter-count untuk β-ramp tapi tidak bisa di-attribute ke decision pemiliknya (TTL lewat / journal rotate / schema)" style={{ color: C.accent, cursor: 'help' }}> · gap {q.examplesGap}</span>}
                {q.journalBadLines != null && q.journalBadLines > 0 && <span style={{ color: C.bad }}> · {q.journalBadLines} bad journal line</span>}
              </div>
              <div>
                archetype: {q.archetypes.length ? q.archetypes.map((a) => (
                  <span key={a.archetype} style={{ color: a.status === 'ACCEPTED' ? C.good : a.status === 'NO_EXAMPLES' ? C.bad : C.accent, marginRight: 8 }} title={`${a.examples} examples`}>
                    {a.archetype}: {a.status}
                  </span>
                )) : <span>belum ada refit</span>}
              </div>
              <div>
                family: {q.familyBalance.length ? q.familyBalance.map((f) => `${f.family} ${f.resolved} (${f.sharePct.toFixed(0)}%)`).join(' · ') : 'belum ada'}
                {q.largestFamilySharePct != null && q.largestFamilySharePct >= 70 && <span style={{ color: C.accent }}> · timpang (family terbesar {q.largestFamilySharePct.toFixed(0)}%)</span>}
              </div>
              <div>
                lane: <span style={{ color: C.good }}>{q.lanes.learningActive} aktif</span> · {q.lanes.insufficientData} kurang data · {q.lanes.noOutcomeSource} tanpa sumber{q.lanes.schemaMismatch > 0 ? ` · ${q.lanes.schemaMismatch} schema mismatch` : ''} / {q.lanes.total}
              </div>
            </div>

            <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 9, paddingTop: 8, fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4 }}>Lineage</div>
            <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.6, marginTop: 3 }}>
              {r.lineage ? (
                <>
                  <b style={{ color: C.text }}>{r.lineage.totalEvents}</b> events ({r.lineage.mode}, instance <span style={{ color: C.measure }}>{r.lineage.instanceId}</span>) · {r.lineage.decisionSnapshots} snapshot · {r.lineage.opportunitiesOpened} open → <b style={{ color: C.text }}>{r.lineage.outcomesResolved}</b> resolved ({r.lineage.validOutcomes} valid, {r.lineage.directOutcomes} direct, {r.lineage.unresolvedOpportunities} unresolved) · {r.lineage.economicWins} economic win
                </>
              ) : 'collection status tidak tersedia'}
            </div>

            <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 9, paddingTop: 8, fontSize: 12, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4 }}>Reinforcement +/−</div>
            <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.7, marginTop: 3 }}>
              <div>
                label training: <span style={{ color: C.good, fontWeight: 700 }}>+{rf.positive}</span> / <span style={{ color: C.bad, fontWeight: 700 }}>−{rf.noReward}</span>
                {rf.positiveSharePct != null && <span> ({rf.positiveSharePct.toFixed(0)}% positif; y=1 hanya jika netR &gt; 0.03R setelah biaya)</span>}
              </div>
              <div title="Ini snapshot 3 arketipe (BREADTH/NEUTRAL/TACTICAL) dari SIKLUS REFIT TERAKHIR saja — bukan hitungan kumulatif berapa kali refit sudah berjalan (refit sendiri jalan tiap beberapa jam otomatis via jadwal, terlepas dari angka ini).">
                refit siklus terakhir (dari 3 arketipe): <span style={{ color: C.good }}>{rf.refitAccepted} accepted</span> · <span style={{ color: rf.refitRejected > 0 ? C.accent : C.dim }}>{rf.refitRejected} rejected</span> · <span style={{ color: rf.refitNoExamples > 0 ? C.bad : C.dim }}>{rf.refitNoExamples} no-examples</span>
              </div>
              <div>
                decision-alpha: {da && da.n > 0 ? (
                  <>
                    <b style={{ color: da.cumulativeTiltDeltaR > 0 ? C.good : da.cumulativeTiltDeltaR < 0 ? C.bad : C.dim }}>{fmtR(da.cumulativeTiltDeltaR)}</b> kumulatif / {da.n} outcome (mean {fmtR(da.meanTiltDeltaR)})
                    {da.perLane.length > 0 && (
                      <div style={{ marginTop: 2 }}>
                        top: {da.perLane.slice(0, 3).map((l) => (
                          <span key={l.laneId} style={{ marginRight: 8 }}>
                            <span style={{ color: C.text }}>{l.laneId}</span> <span style={{ color: l.cumulativeTiltDeltaR > 0 ? C.good : C.bad }}>{fmtR(l.cumulativeTiltDeltaR)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : 'belum ada outcome ter-attribute'}
              </div>
            </div>
          </Disclosure>
        </div>
      </div>
    </section>
  );
}
