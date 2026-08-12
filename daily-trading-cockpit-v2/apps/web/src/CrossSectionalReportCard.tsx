import { useEffect, useState } from 'react';

const C = {
  card: '#14222a',
  sub: '#0f1c23',
  border: '#20313a',
  text: '#dbe7ec',
  dim: '#7d97a3',
  good: '#46d39a',
  bad: '#ff6b6b',
  measure: '#6fb3d6',
  accent: '#f0b54b',
};

type XSecReport = {
  signal: string;
  horizonBars: number;
  k: number;
  open: number;
  closed: number;
  netAvgReturn: number;
  grossAvgReturn: number;
  winRate: number;
  totalNetReturn: number;
  sharpeLike: number | null;
  longLegAvgReturn: number;
  shortLegAvgReturn: number;
  targetGrossReturn?: number;
  edgeReady?: boolean;
  lastCycleAt: string | null;
  nextResolveInMs: number | null;
  recentNetReturns: number[];
};
type XSecBasket = {
  openedAt: string;
  resolvedAt?: string | null;
  signal: string;
  netReturnPct?: number | null;
  long: string[];
  short: string[];
};
type XSecResponse = {
  report: XSecReport;
  filteredReport?: XSecReport;
  filteredConfig?: { minScoreGap: number; targetGrossReturn: number; longAllowlist: string[]; shortAllowlist: string[]; shortBlocklist: string[] };
  openBaskets: XSecBasket[];
  filteredOpenBaskets?: XSecBasket[];
  recentClosed: XSecBasket[];
  filteredRecentClosed?: XSecBasket[];
};

const pct = (x: number | null | undefined, d = 3) => x == null ? '—' : `${(x * 100).toFixed(d)}%`;
const pctRaw = (x: number | null | undefined, d = 2) => x == null ? '—' : `${x.toFixed(d)}%`;
const tone = (x: number | null | undefined) => x == null ? C.measure : x > 0 ? C.good : x < 0 ? C.bad : C.dim;
const ago = (ts: string) => {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
};
const duration = (ms: number | null) => {
  if (ms == null) return '—';
  if (ms <= 0) return 'due';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return <div style={{ padding: '8px 14px', borderRight: `1px solid ${C.border}` }}>
    <div style={{ color: C.dim, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
    <div style={{ color: color ?? C.text, fontSize: 18, fontWeight: 600, marginTop: 2 }}>{value}</div>
  </div>;
}

function LegBars({ report }: { report: XSecReport }) {
  const max = Math.max(0.0001, Math.abs(report.longLegAvgReturn), Math.abs(report.shortLegAvgReturn));
  return <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}` }}>
    <div style={{ color: C.dim, fontSize: 12, marginBottom: 6 }}>Leg contribution</div>
    {[['Long', report.longLegAvgReturn], ['Short', report.shortLegAvgReturn]].map(([label, value]) => {
      const n = value as number;
      return <div key={label as string} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, padding: '3px 0' }}>
        <span style={{ width: 55, color: C.text }}>{label as string}</span>
        <div style={{ flex: 1, height: 12, background: C.sub, borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${Math.min(100, Math.abs(n) / max * 100)}%`, height: '100%', background: tone(n) }} />
        </div>
        <span style={{ width: 64, textAlign: 'right', color: tone(n), fontWeight: 600 }}>{pct(n)}</span>
      </div>;
    })}
  </div>;
}

function BasketRows({ baskets, open }: { baskets: XSecBasket[]; open?: boolean }) {
  if (!baskets.length) return <div style={{ color: C.dim, fontSize: 12 }}>No {open ? 'open' : 'closed'} baskets yet.</div>;
  return <>{baskets.slice(-6).reverse().map((basket, index) => <div key={`${basket.openedAt}-${index}`} style={{ display: 'flex', gap: 12, fontSize: 12, padding: '4px 0', borderTop: index ? `1px solid ${C.border}` : undefined, flexWrap: 'wrap' }}>
    <span style={{ color: open ? C.measure : tone(basket.netReturnPct), fontWeight: 600, width: 64 }}>{open ? 'OPEN' : pctRaw(basket.netReturnPct)}</span>
    <span style={{ color: C.good }}>L: {basket.long.join(', ')}</span>
    <span style={{ color: C.bad }}>S: {basket.short.join(', ')}</span>
    <span style={{ color: C.dim, marginLeft: 'auto' }}>{open ? `${ago(basket.openedAt)} ago` : basket.resolvedAt ? `${ago(basket.resolvedAt)} ago` : 'unresolved'}</span>
  </div>)}</>;
}

export default function CrossSectionalReportCard({ apiPrefix = '/testnet/api' }: { apiPrefix?: string }) {
  const [data, setData] = useState<XSecResponse | null>(null);
  const [variant, setVariant] = useState<'RAW' | 'FILTERED'>('FILTERED');
  const [error, setError] = useState(false);

  async function load() {
    try {
      const response = await fetch(`${apiPrefix}/shadow/cross-sectional-report`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData(await response.json() as XSecResponse);
      setError(false);
    } catch {
      setError(true);
    }
  }

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 10_000); return () => window.clearInterval(timer); }, [apiPrefix]);

  const report = variant === 'FILTERED' ? data?.filteredReport ?? data?.report : data?.report;
  const closed = variant === 'FILTERED' ? data?.filteredRecentClosed ?? [] : data?.recentClosed ?? [];
  const open = variant === 'FILTERED' ? data?.filteredOpenBaskets ?? [] : data?.openBaskets ?? [];
  const config = data?.filteredConfig;

  return <section className="testnet-panel testnet-wide-panel" id="cross-sectional-report">
    <header>
      <div>
        <span>Cross-sectional horizon report</span>
        <strong>{report ? `${report.horizonBars}h horizon · ${report.signal}` : 'loading…'}</strong>
      </div>
      <span className="tone-measure">testnet measurement</span>
    </header>
    <div style={{ padding: '8px 12px', color: C.dim, fontSize: 12 }}>
      {error ? 'Report fetch failed — showing last available data.' : report ? `${report.lastCycleAt ? `last cycle ${ago(report.lastCycleAt)} ago` : 'no cycle yet'} · next resolution ${duration(report.nextResolveInMs)}` : 'Loading cross-sectional report…'}
    </div>
    <div style={{ display: 'flex', gap: 8, padding: '0 12px 8px' }}>
      <button type="button" onClick={() => setVariant('RAW')} style={{ opacity: variant === 'RAW' ? 1 : 0.65 }}>RAW</button>
      <button type="button" onClick={() => setVariant('FILTERED')} style={{ opacity: variant === 'FILTERED' ? 1 : 0.65 }}>FILTERED{data?.filteredReport?.edgeReady ? ' · edge ready' : ''}</button>
    </div>
    {report ? <>
      <div style={{ display: 'flex', flexWrap: 'wrap', borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <Stat label="Closed" value={`${report.closed}`} />
        <Stat label="Open" value={`${report.open}`} />
        <Stat label="Net avg" value={pct(report.netAvgReturn)} color={tone(report.netAvgReturn)} />
        <Stat label="Win rate" value={report.closed ? `${Math.round(report.winRate * 100)}%` : '—'} />
        <Stat label="Total net" value={pct(report.totalNetReturn, 2)} color={tone(report.totalNetReturn)} />
      </div>
      <LegBars report={report} />
      <div style={{ padding: '10px 12px' }}>
        <div style={{ color: C.dim, fontSize: 12, marginBottom: 5 }}>Recent closed baskets</div>
        <BasketRows baskets={closed} />
        {!!open.length && <><div style={{ color: C.dim, fontSize: 12, margin: '10px 0 5px' }}>Open baskets</div><BasketRows baskets={open} open /></>}
      </div>
      {config && <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.border}`, color: C.dim, fontSize: 11, lineHeight: 1.5 }}>
        <strong style={{ color: C.text }}>Filtered rules:</strong> long {config.longAllowlist.join(', ')} · short {config.shortAllowlist.join(', ')} · blocked short {config.shortBlocklist.join(', ')}
      </div>}
    </> : <div style={{ padding: 16, color: C.dim }}>{error ? 'No report data available.' : 'Loading…'}</div>}
  </section>;
}
