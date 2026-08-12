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
  reportStartAt?: string | null;
  report: XSecReport;
  filteredReport?: XSecReport;
  filteredConfig?: { minScoreGap: number; targetGrossReturn: number; longAllowlist: string[]; shortAllowlist: string[]; shortBlocklist: string[] };
  openBaskets: XSecBasket[];
  filteredOpenBaskets?: XSecBasket[];
  recentClosed: XSecBasket[];
  filteredRecentClosed?: XSecBasket[];
};
type ClosedLeg = {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  exitPrice: number;
  notionalTouchedUsd: number;
  grossPnlUsd: number;
  feeAllocatedUsd: number;
  netPnlUsd: number;
  priceConfirmed: boolean;
};
type ClosedBasket = {
  basketId: string;
  variant: string;
  signal: string;
  openedAt: string;
  closedAt: string;
  holdHours: number;
  closeReason: string | null;
  grossPnlUsd: number | null;
  feeEstimateUsd: number | null;
  feeSource: string | null;
  netPnlUsd: number | null;
  allPricesConfirmed: boolean;
  legs: ClosedLeg[];
};
type ClosedLane = { lane: string; laneId: string; closedBaskets: number; baskets: ClosedBasket[] };
type ClosedResponse = {
  generatedAt: string;
  reportStartAt?: string | null;
  source: string;
  feeCaveat?: string;
  totalClosed: number;
  reason: string | null;
  lanes: ClosedLane[];
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

function formatDate(ts: string | null | undefined) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function sideReturn(basket: ClosedBasket, side: 'LONG' | 'SHORT') {
  const legs = basket.legs.filter((leg) => leg.side === side && leg.entryPrice > 0);
  if (!legs.length) return null;
  return legs.reduce((sum, leg) => sum + (side === 'LONG'
    ? (leg.exitPrice - leg.entryPrice) / leg.entryPrice
    : (leg.entryPrice - leg.exitPrice) / leg.entryPrice), 0) / legs.length;
}

function money(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(4)} USDT`;
}

function ClosedBasketBlock({ basket, lane }: { basket: ClosedBasket; lane: string }) {
  const longReturn = sideReturn(basket, 'LONG');
  const shortReturn = sideReturn(basket, 'SHORT');
  return <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, marginTop: 10, overflow: 'hidden' }}>
    <div style={{ padding: '9px 12px', background: C.sub, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
      <strong style={{ color: C.text }}>{basket.basketId}</strong>
      <span style={{ color: C.dim }}>{lane} · {basket.variant} · {basket.signal}</span>
      <span style={{ color: C.dim }}>hold {basket.holdHours.toFixed(2)}h</span>
      <span style={{ color: basket.allPricesConfirmed ? C.good : C.accent }}>{basket.allPricesConfirmed ? 'fills confirmed' : 'unconfirmed fill price'}</span>
    </div>
    <div style={{ padding: '8px 12px', display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, borderBottom: `1px solid ${C.border}` }}>
      <span>Open: <strong>{formatDate(basket.openedAt)}</strong></span>
      <span>Close: <strong>{formatDate(basket.closedAt)}</strong></span>
      <span>Gross: <strong style={{ color: tone(basket.grossPnlUsd) }}>{money(basket.grossPnlUsd)}</strong></span>
      <span>Fee/cost: <strong style={{ color: C.accent }}>{money(basket.feeEstimateUsd)}</strong> <small style={{ color: C.dim }}>({basket.feeSource ?? 'unknown'})</small></span>
      <span>Realized net: <strong style={{ color: tone(basket.netPnlUsd) }}>{money(basket.netPnlUsd)}</strong></span>
      <span>Long return: <strong style={{ color: tone(longReturn) }}>{pct(longReturn)}</strong></span>
      <span>Short return: <strong style={{ color: tone(shortReturn) }}>{pct(shortReturn)}</strong></span>
    </div>
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr style={{ color: C.dim, textAlign: 'left' }}>
          <th style={{ padding: 7 }}>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Close</th><th>Return</th><th>Gross</th><th>Fee allocated</th><th>Realized</th>
        </tr></thead>
        <tbody>{basket.legs.map((leg) => {
          const ret = leg.entryPrice > 0 ? (leg.side === 'LONG' ? leg.exitPrice - leg.entryPrice : leg.entryPrice - leg.exitPrice) / leg.entryPrice : null;
          return <tr key={`${basket.basketId}-${leg.symbol}`} style={{ borderTop: `1px solid ${C.border}` }}>
            <td style={{ padding: 7, color: C.text, fontWeight: 600 }}>{leg.symbol}</td>
            <td style={{ color: leg.side === 'LONG' ? C.good : C.bad }}>{leg.side}</td>
            <td>{leg.qty}</td><td>{leg.entryPrice}</td><td>{leg.exitPrice}</td>
            <td style={{ color: tone(ret) }}>{pct(ret)}</td>
            <td style={{ color: tone(leg.grossPnlUsd) }}>{money(leg.grossPnlUsd)}</td>
            <td style={{ color: C.accent }}>{money(leg.feeAllocatedUsd)}</td>
            <td style={{ color: tone(leg.netPnlUsd) }}>{money(leg.netPnlUsd)} {!leg.priceConfirmed && <span title="Entry or close fill price was not exchange-confirmed">⚠</span>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div style={{ padding: '7px 12px', color: C.dim, fontSize: 11 }}>Close reason: {basket.closeReason ?? '—'}</div>
  </div>;
}

function ClosedCrossBasketReport({ apiPrefix }: { apiPrefix: string }) {
  const [data, setData] = useState<ClosedResponse | null>(null);
  const [error, setError] = useState(false);
  async function load() {
    try {
      const response = await fetch(`${apiPrefix}/live/cross-sectional-closed-baskets`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData(await response.json() as ClosedResponse);
      setError(false);
    } catch { setError(true); }
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer); }, [apiPrefix]);
  const lanes = (data?.lanes ?? []).filter((lane) => lane.laneId.startsWith('CROSS_SECTIONAL_'));
  const baskets = lanes.flatMap((lane) => lane.baskets.map((basket) => ({ lane: lane.lane, basket }))).sort((a, b) => new Date(b.basket.closedAt).getTime() - new Date(a.basket.closedAt).getTime());
  return <section className="testnet-panel testnet-wide-panel" id="cross-sectional-closed-report">
    <header><div><span>Closed cross-basket realized report</span><strong>{baskets.length} closed basket{baskets.length === 1 ? '' : 's'}</strong></div><span className="tone-measure">grouped per basket · real fills</span></header>
    <div style={{ padding: '8px 12px', color: C.dim, fontSize: 11, lineHeight: 1.5 }}>
      Scope: {data?.reportStartAt ? `baskets opened from ${formatDate(data.reportStartAt)} onward` : 'all stored history'}. Gross profit, fee/cost, long/short return, realized net per symbol, and open/close timestamps. Fee/cost comes from the basket ledger; separate slippage is not currently stored independently. Per-symbol fee is allocated by notional touched.
    </div>
    {error ? <div style={{ padding: 12, color: C.bad }}>Closed-basket report fetch failed.</div> : baskets.length ? <div style={{ padding: '0 12px 12px' }}>
      {baskets.map(({ lane, basket }) => <ClosedBasketBlock key={basket.basketId} lane={lane} basket={basket} />)}
    </div> : <div style={{ padding: 12, color: C.dim }}>{data?.reason ? 'Belum ada cross-sectional basket yang sudah open dan close di exchange.' : 'Loading closed basket history…'}</div>}
  </section>;
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

  return <>
  <section className="testnet-panel testnet-wide-panel" id="cross-sectional-definitions">
    <header><div><span>Cross-basket terms</span><strong>How to read this report</strong></div><span className="tone-measure">testnet only</span></header>
    <div style={{ padding: '10px 12px', display: 'grid', gap: 8, color: C.dim, fontSize: 12, lineHeight: 1.5 }}>
      <div><strong style={{ color: C.text }}>RAW</strong> = baseline signal universe. It ranks the full eligible basket pool without the measured per-symbol FILTERED allow/block rules. It is the comparison baseline, not automatically the live execution choice.</div>
      <div><strong style={{ color: C.text }}>FILTERED</strong> = the same cross-sectional momentum idea after liquidity, score-gap, operator allow/block, and measured symbol filters. The live market-neutral executor currently consumes this variant.</div>
      <div><strong style={{ color: C.text }}>MOM36_FILTERED</strong> = FILTERED signal using momentum over the last 36 completed 1-hour bars. The <strong style={{ color: C.accent }}>36</strong> is the lookback, not the holding time; the current basket horizon is shown beside the report title and is configured separately.</div>
    </div>
  </section>
  <section className="testnet-panel testnet-wide-panel" id="cross-sectional-report">
    <header>
      <div>
        <span>Cross-sectional horizon report</span>
        <strong>{report ? `${report.horizonBars}h horizon · ${report.signal}` : 'loading…'}</strong>
      </div>
      <span className="tone-measure">testnet measurement</span>
    </header>
    <div style={{ padding: '8px 12px', color: C.dim, fontSize: 12 }}>
      {error ? 'Report fetch failed — showing last available data.' : report ? `${report.lastCycleAt ? `last cycle ${ago(report.lastCycleAt)} ago` : 'no cycle yet'} · next resolution ${duration(report.nextResolveInMs)} · scope from ${data?.reportStartAt ? formatDate(data.reportStartAt) : 'all history'}` : 'Loading cross-sectional report…'}
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
  </section>
  <ClosedCrossBasketReport apiPrefix={apiPrefix} />
  </>;
}
