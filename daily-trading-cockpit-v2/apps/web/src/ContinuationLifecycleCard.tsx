import { useEffect, useState } from 'react';

type LifecycleStatus = {
  configured: boolean;
  lifecycle: {
    autoPromotionEnabled?: boolean;
    trainingPaused?: boolean;
    trainingRunning?: boolean;
    latestMatureLabelTimestampMs?: number | null;
    latestFeatureRefreshAt?: string | null;
    trainingRows?: number | null;
    newMatureRows?: number | null;
    nextRetrainEligibleAt?: string | null;
    lastRun?: { verdict: string; reason: string; completedAt: string | null } | null;
    currentChampion?: { version: string; artifactSha256: string; trainedAt: string; trainingCutoffMs: number | null } | null;
    resource?: { safe: boolean; reason: string | null; nice: number | null; threads: number; freeMemoryBytes: number | null } | null;
  } | null;
  collector: {
    updatedAt: string;
    sourceSummary: Record<string, { required: boolean; freshness: 'HEALTHY' | 'STALE' | 'GAPPED' | 'UNKNOWN'; lastError: string | null }>;
  } | null;
  labelMaturation: {
    state: 'UNAVAILABLE' | 'PENDING_LABEL' | 'MATURE';
    latestMatureFormationTimestampMs: number | null;
  } | null;
  runtimeArtifact: { artifactId: string; source: string; available: boolean; warning: string | null; reason: string | null };
};

const C = { card: '#14222a', sub: '#0f1c23', border: '#20313a', text: '#dbe7ec', dim: '#7d97a3', good: '#46d39a', bad: '#ff6b6b', warn: '#f0b54b', accent: '#6fb3d6' };
const format = (value: string | number | null | undefined) => value == null ? '—' : new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei' }).format(new Date(value));

export default function ContinuationLifecycleCard({ apiPrefix }: { apiPrefix: string }) {
  const [state, setState] = useState<LifecycleStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(`${apiPrefix}/live/cross-sectional/continuation-lifecycle/status`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value = await response.json() as LifecycleStatus;
        if (alive) { setState(value); setFailed(false); }
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [apiPrefix]);

  const lifecycle = state?.lifecycle ?? null;
  const required = Object.values(state?.collector?.sourceSummary ?? {}).filter((source) => source.required);
  const healthy = required.filter((source) => source.freshness === 'HEALTHY' && source.lastError === null).length;
  const collectorTone = required.length > 0 && healthy === required.length ? C.good : required.length ? C.warn : C.dim;
  const runtimeTone = state?.runtimeArtifact.available ? C.good : C.bad;
  const lastVerdict = lifecycle?.lastRun?.verdict ?? 'belum ada run';
  const verdictTone = lastVerdict === 'PROMOTED' ? C.good : lastVerdict === 'REJECTED' || lastVerdict === 'FAILED' ? C.warn : C.dim;

  return <section style={{ margin: '12px 0', border: `1px solid ${C.border}`, borderRadius: 7, overflow: 'hidden', background: C.card }}>
    <header style={{ padding: '9px 12px', background: C.sub, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <strong style={{ color: C.text }}>Continuation model lifecycle</strong>
      <span style={{ color: runtimeTone, fontSize: 12 }}>{state?.runtimeArtifact.available ? '● runtime siap' : '● runtime fallback / tidak siap'}</span>
    </header>
    {failed && <div style={{ padding: '8px 12px', color: C.bad, fontSize: 12 }}>Status lifecycle tidak bisa dibaca. Trading basket tidak diubah oleh panel ini.</div>}
    {!failed && !state && <div style={{ padding: '8px 12px', color: C.dim, fontSize: 12 }}>Memuat status lifecycle…</div>}
    {state && <div style={{ padding: '10px 12px', display: 'grid', gap: 7, fontSize: 12 }}>
      {!state.configured && <div style={{ color: C.warn }}>Registry lifecycle belum dikonfigurasi; runtime memakai artifact V4 bootstrap yang dipin.</div>}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', color: C.dim }}>
        <span>Champion: <strong style={{ color: C.text }}>{lifecycle?.currentChampion?.version ?? state.runtimeArtifact.artifactId}</strong></span>
        <span>source: <strong style={{ color: C.text }}>{state.runtimeArtifact.source}</strong></span>
        <span>collector: <strong style={{ color: collectorTone }}>{healthy}/{required.length || '—'} required healthy</strong></span>
        <span>promotion: <strong style={{ color: lifecycle?.autoPromotionEnabled === false ? C.warn : C.good }}>{lifecycle?.autoPromotionEnabled === false ? 'paused' : 'strict auto'}</strong></span>
        <span>training: <strong style={{ color: lifecycle?.trainingRunning ? C.accent : lifecycle?.trainingPaused ? C.warn : C.dim }}>{lifecycle?.trainingRunning ? 'sedang jalan' : lifecycle?.trainingPaused ? 'dipause' : 'idle'}</strong></span>
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', color: C.dim }}>
        <span>Label mature: <strong style={{ color: C.text }}>{format(lifecycle?.latestMatureLabelTimestampMs)}</strong></span>
        <span>Queue label: <strong style={{ color: state.labelMaturation?.state === 'UNAVAILABLE' ? C.warn : C.text }}>{state.labelMaturation?.state ?? '—'}</strong></span>
        <span>Rows: <strong style={{ color: C.text }}>{lifecycle?.trainingRows ?? '—'}</strong> · baru <strong style={{ color: C.text }}>{lifecycle?.newMatureRows ?? '—'}</strong></span>
        <span>Eligible lagi: <strong style={{ color: C.text }}>{format(lifecycle?.nextRetrainEligibleAt)}</strong></span>
        <span>Resource: <strong style={{ color: lifecycle?.resource?.safe === false ? C.warn : C.good }}>{lifecycle?.resource?.safe === false ? lifecycle.resource.reason ?? 'guard aktif' : `nice ${lifecycle?.resource?.nice ?? '—'} · ${lifecycle?.resource?.threads ?? '—'} thread`}</strong></span>
      </div>
      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 6, color: C.dim }}>
        Challenger terakhir: <strong style={{ color: verdictTone }}>{lastVerdict}</strong>
        {lifecycle?.lastRun?.reason && <> · {lifecycle.lastRun.reason}</>}
        {lifecycle?.lastRun?.completedAt && <> · {format(lifecycle.lastRun.completedAt)}</>}
      </div>
      {(state.runtimeArtifact.warning || state.runtimeArtifact.reason) && <div style={{ color: C.warn, fontSize: 11 }}>Runtime note: {state.runtimeArtifact.warning ?? state.runtimeArtifact.reason}</div>}
      <a href={`${apiPrefix}/live/cross-sectional/continuation-lifecycle/model`} target="_blank" rel="noreferrer" style={{ color: C.accent, fontSize: 11 }}>Model + metrics detail →</a>
    </div>}
  </section>;
}
