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
type FilteredConfig = {
  minScoreGap: number;
  targetGrossReturn: number;
  longAllowlist: string[];
  shortAllowlist: string[];
  shortBlocklist: string[];
  executionLongAllowlist: string[];
  executionShortAllowlist: string[];
  executionShortBlocklist: string[];
  executionUniverse?: string[];
  executionExcludedSymbols?: string[];
  adaptiveDemotionActive: boolean;
};
type AdaptiveSymbolFilters = {
  longAllowlist: string[];
  shortAllowlist: string[];
  longBlocklist: string[];
  shortBlocklist: string[];
  executionUsesThis: boolean;
  provenance: {
    closedBaskets: number;
    demotedLong: string[];
    demotedShort: string[];
  };
};
type XSecResponse = {
  reportStartAt?: string | null;
  report: XSecReport;
  filteredReport?: XSecReport;
  filteredConfig?: FilteredConfig;
  adaptiveSymbolFilters?: AdaptiveSymbolFilters;
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
  unrealizedExtrema?: LegUnrealizedExtrema | null;
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
  unrealizedExtrema?: UnrealizedExtrema | null;
  legs: ClosedLeg[];
};
type ClosedLane = { lane: string; laneId: string; closedBaskets: number; baskets: ClosedBasket[] };
type UnrealizedExtrema = {
  grossHighUsd: number;
  grossLowUsd: number;
  afterEstimatedCloseCostHighUsd: number;
  afterEstimatedCloseCostLowUsd: number;
  firstRecordedAt: string;
  lastRecordedAt: string;
  closedAt?: string;
};
type LegUnrealizedExtrema = {
  grossHighUsd: number;
  grossLowUsd: number;
  afterEstimatedCloseCostHighUsd: number;
  afterEstimatedCloseCostLowUsd: number;
  entryAt: string;
  firstRecordedAt: string;
  lastRecordedAt: string;
  closedAt?: string;
};
type OpenBasketUnrealized = {
  basketId: string;
  signal: string;
  variant: string;
  openedAt: string;
  legs: Array<{
    symbol: string;
    side: 'LONG' | 'SHORT';
    qty: number;
    entryPrice: number;
    markPrice: number | null;
    grossUnrealizedUsd: number | null;
    afterEstimatedCloseCostUsd: number | null;
    unrealizedExtrema?: LegUnrealizedExtrema | null;
  }>;
  grossUnrealizedUsd: number | null;
  unrealizedAfterEstimatedCloseCostUsd: number | null;
  unrealizedExtrema: UnrealizedExtrema | null;
};
type CrossSectionalPnl = {
  openBasketCount: number;
  openLegCount: number;
  grossUnrealizedUsd: number | null;
  unrealizedAfterSlippageUsd: number | null;
  estimatedSlippageUsd: number | null;
  realizedBeforeSlippageUsd: number;
  netRealizedProfitUsd: number;
  estimatedCloseCostPct: number;
  slippageCaveat: string;
};
type ClosedResponse = {
  generatedAt: string;
  reportStartAt?: string | null;
  source: string;
  feeCaveat?: string;
  totalClosed: number;
  reason: string | null;
  crossSectionalPnl?: CrossSectionalPnl;
  openBaskets?: OpenBasketUnrealized[];
  lanes: ClosedLane[];
};
type DirectionalPick = { symbol: string; sideScore: number; relativeEdge: number; confidence: number };
type DirectionalExecutor = { openPositions?: unknown[]; dailyMaxLossUsd?: number; lastError?: string | null };
type DirectionalRegimeResponse = {
  enabled: boolean;
  mode: 'BEAR_SHORT_3' | 'BULL_LONG_3' | 'BALANCED_3X3' | 'NO_TRADE';
  marketRegime: string | null;
  canonicalRegimeFamily: 'BULLISH' | 'BEARISH' | 'MIXED' | 'UNKNOWN';
  canonicalAllowed: boolean | null;
  canonicalReason: string | null;
  reason: string;
  scanFinishedAt: string | null;
  longPicks: DirectionalPick[];
  shortPicks: DirectionalPick[];
  longExecutor: DirectionalExecutor | null;
  shortExecutor: DirectionalExecutor | null;
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

function SymbolList({ symbols, color = C.dim, empty = 'Tidak ada' }: { symbols: string[]; color?: string; empty?: string }) {
  return <div style={{ display: 'grid', gap: 2, paddingLeft: 12, marginTop: 3 }}>
    {symbols.length ? symbols.map((symbol) => <div key={symbol} style={{ color }}>{symbol}</div>) : <div style={{ color: C.dim }}>{empty}</div>}
  </div>;
}

function InlineSymbolList({ symbols, color = C.dim, empty = 'Tidak ada' }: { symbols: string[]; color?: string; empty?: string }) {
  return <div style={{ color, paddingLeft: 12, marginTop: 3, lineHeight: 1.5 }}>{symbols.length ? symbols.join(', ') : empty}</div>;
}

function BasketRows({ baskets, open }: { baskets: XSecBasket[]; open?: boolean }) {
  if (!baskets.length) return <div style={{ color: C.dim, fontSize: 12 }}>No {open ? 'open' : 'closed'} baskets yet.</div>;
  return <>{baskets.slice(-6).reverse().map((basket, index) => <div key={`${basket.openedAt}-${index}`} style={{ display: 'flex', gap: 12, fontSize: 12, padding: '4px 0', borderTop: index ? `1px solid ${C.border}` : undefined, flexWrap: 'wrap' }}>
    <span style={{ color: open ? C.measure : tone(basket.netReturnPct), fontWeight: 600, width: 64 }}>{open ? 'OPEN' : pctRaw(basket.netReturnPct)}</span>
    <span style={{ color: C.good }}>L: {basket.long.join(', ')}</span>
    <span style={{ color: C.bad }}>S: {basket.short.join(', ')}</span>
    <span style={{ color: C.dim, marginLeft: 'auto' }}>Dibuat: {formatDate(basket.openedAt)}{open ? '' : ` · Ditutup: ${formatDate(basket.resolvedAt)}`}</span>
  </div>)}</>;
}

function formatDate(ts: string | null | undefined) {
  return ts ? new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Taipei',
  }).format(new Date(ts)) : '—';
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

function price(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  const decimals = value >= 1_000 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 6 : 8;
  return value.toFixed(decimals);
}

function UnrealizedExtremaBlock({ extrema }: { extrema: UnrealizedExtrema | null | undefined }) {
  if (!extrema) return <div style={{ padding: '7px 12px', color: C.dim, fontSize: 11 }}>ATH/ATL unrealized mulai direkam saat report ini aktif.</div>;
  return <div style={{ padding: '8px 12px', display: 'grid', gap: 5, fontSize: 12, borderBottom: `1px solid ${C.border}` }}>
    <strong style={{ color: C.text }}>ATH / ATL unrealized terekam</strong>
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <span>Gross high: <strong style={{ color: tone(extrema.grossHighUsd) }}>{money(extrema.grossHighUsd)}</strong></span>
      <span>Gross low: <strong style={{ color: tone(extrema.grossLowUsd) }}>{money(extrema.grossLowUsd)}</strong></span>
      <span>Setelah biaya close high: <strong style={{ color: tone(extrema.afterEstimatedCloseCostHighUsd) }}>{money(extrema.afterEstimatedCloseCostHighUsd)}</strong></span>
      <span>Setelah biaya close low: <strong style={{ color: tone(extrema.afterEstimatedCloseCostLowUsd) }}>{money(extrema.afterEstimatedCloseCostLowUsd)}</strong></span>
    </div>
    <small style={{ color: C.dim }}>Direkam sejak {formatDate(extrema.firstRecordedAt)} · sampel terakhir {formatDate(extrema.lastRecordedAt)}. Saat basket masih open, biaya close adalah estimasi; setelah close, angka ATH/ATL tetap disimpan sebagai histori mark-to-market.</small>
  </div>;
}

function LegUnrealizedExtremaLine({ extrema }: { extrema: LegUnrealizedExtrema | null | undefined }) {
  if (!extrema) return <small style={{ display: 'block', padding: '0 12px 7px', color: C.dim }}>ATH/ATL simbol mulai direkam setelah report ini aktif.</small>;
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(150px, 1fr))', gap: 5, padding: '0 12px 8px', color: C.dim, fontSize: 11 }}>
    <span>ATH gross <strong style={{ color: tone(extrema.grossHighUsd) }}>{money(extrema.grossHighUsd)}</strong></span>
    <span>ATH setelah biaya <strong style={{ color: tone(extrema.afterEstimatedCloseCostHighUsd) }}>{money(extrema.afterEstimatedCloseCostHighUsd)}</strong></span>
    <span>ATL gross <strong style={{ color: tone(extrema.grossLowUsd) }}>{money(extrema.grossLowUsd)}</strong></span>
    <span>ATL setelah biaya <strong style={{ color: tone(extrema.afterEstimatedCloseCostLowUsd) }}>{money(extrema.afterEstimatedCloseCostLowUsd)}</strong></span>
  </div>;
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
    <UnrealizedExtremaBlock extrema={basket.unrealizedExtrema} />
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr style={{ color: C.dim, textAlign: 'left' }}>
          <th style={{ padding: 7 }}>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Close</th><th>Return</th><th>Gross</th><th>Fee allocated</th><th>Realized</th>
        </tr></thead>
        <tbody>{basket.legs.map((leg) => {
          const ret = leg.entryPrice > 0 ? (leg.side === 'LONG' ? leg.exitPrice - leg.entryPrice : leg.entryPrice - leg.exitPrice) / leg.entryPrice : null;
          return <>
            <tr key={`${basket.basketId}-${leg.symbol}`} style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={{ padding: 7, color: C.text, fontWeight: 600 }}>{leg.symbol}</td>
              <td style={{ color: leg.side === 'LONG' ? C.good : C.bad }}>{leg.side}</td>
              <td>{leg.qty}</td><td>{leg.entryPrice}</td><td>{leg.exitPrice}</td>
              <td style={{ color: tone(ret) }}>{pct(ret)}</td>
              <td style={{ color: tone(leg.grossPnlUsd) }}>{money(leg.grossPnlUsd)}</td>
              <td style={{ color: C.accent }}>{money(leg.feeAllocatedUsd)}</td>
              <td style={{ color: tone(leg.netPnlUsd) }}>{money(leg.netPnlUsd)} {!leg.priceConfirmed && <span title="Entry or close fill price was not exchange-confirmed">⚠</span>}</td>
            </tr>
            <tr key={`${basket.basketId}-${leg.symbol}-extrema`}><td colSpan={9}><LegUnrealizedExtremaLine extrema={leg.unrealizedExtrema} /></td></tr>
          </>;
        })}</tbody>
      </table>
    </div>
    <div style={{ padding: '7px 12px', color: C.dim, fontSize: 11 }}>Close reason: {basket.closeReason ?? '—'}</div>
  </div>;
}

function OpenBasketUnrealizedBlock({ basket }: { basket: OpenBasketUnrealized }) {
  const long = basket.legs.filter((leg) => leg.side === 'LONG').map((leg) => leg.symbol);
  const short = basket.legs.filter((leg) => leg.side === 'SHORT').map((leg) => leg.symbol);
  return <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, marginTop: 10, overflow: 'hidden' }}>
    <div style={{ padding: '9px 12px', background: C.sub, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
      <strong style={{ color: C.text }}>{basket.basketId}</strong>
      <span style={{ color: C.dim }}>{basket.variant} · {basket.signal}</span>
      <span style={{ color: C.dim }}>open {formatDate(basket.openedAt)}</span>
    </div>
    <div style={{ padding: '8px 12px', display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, borderBottom: `1px solid ${C.border}` }}>
      <span style={{ color: C.good }}>Long: {long.join(', ')}</span>
      <span style={{ color: C.bad }}>Short: {short.join(', ')}</span>
      <span>Gross sekarang: <strong style={{ color: tone(basket.grossUnrealizedUsd) }}>{money(basket.grossUnrealizedUsd)}</strong></span>
      <span>Setelah biaya close: <strong style={{ color: tone(basket.unrealizedAfterEstimatedCloseCostUsd) }}>{money(basket.unrealizedAfterEstimatedCloseCostUsd)}</strong></span>
    </div>
    <div style={{ fontSize: 12, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(105px, 1.2fr) minmax(72px, .7fr) repeat(3, minmax(92px, 1fr))', gap: 8, padding: '7px 12px', color: C.dim, fontSize: 11 }}>
        <span>Symbol</span><span>Arah</span><span>Entry</span><span>Mark sekarang</span><span>Unrealized P&amp;L</span>
      </div>
      {basket.legs.map((leg) => <div key={`${basket.basketId}-${leg.symbol}-${leg.side}`} style={{ borderTop: `1px solid ${C.border}` }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(105px, 1.2fr) minmax(72px, .7fr) repeat(3, minmax(92px, 1fr))', gap: 8, padding: '7px 12px' }}>
          <strong style={{ color: C.text }}>{leg.symbol}</strong>
          <span style={{ color: leg.side === 'LONG' ? C.good : C.bad }}>{leg.side}</span>
          <span>{price(leg.entryPrice)}</span>
          <span>{price(leg.markPrice)}</span>
          <strong style={{ color: tone(leg.grossUnrealizedUsd) }}>{money(leg.grossUnrealizedUsd)}</strong>
        </div>
        <LegUnrealizedExtremaLine extrema={leg.unrealizedExtrema} />
      </div>)}
    </div>
    <UnrealizedExtremaBlock extrema={basket.unrealizedExtrema} />
  </div>;
}

function directionalModeLabel(mode: DirectionalRegimeResponse['mode']): string {
  if (mode === 'BEAR_SHORT_3') return 'BEARISH KUAT → SHORT 3';
  if (mode === 'BULL_LONG_3') return 'BULLISH KUAT → LONG 3';
  if (mode === 'BALANCED_3X3') return 'SEIMBANG → BASKET 3 LONG × 3 SHORT';
  return 'NO TRADE';
}

function directionalModeColor(mode: DirectionalRegimeResponse['mode']): string {
  if (mode === 'BEAR_SHORT_3') return C.bad;
  if (mode === 'BULL_LONG_3') return C.good;
  return mode === 'BALANCED_3X3' ? C.accent : C.measure;
}

/** Keputusan executor yang aktual, terpisah dari histori basket FILTERED di bawahnya. */
function DirectionalRegimeStatus({ apiPrefix }: { apiPrefix: string }) {
  const [data, setData] = useState<DirectionalRegimeResponse | null>(null);
  const [error, setError] = useState(false);
  const [lastGoodAt, setLastGoodAt] = useState<string | null>(null);
  async function load() {
    try {
      const response = await fetch(`${apiPrefix}/live/cross-sectional-directional-regime`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData(await response.json() as DirectionalRegimeResponse);
      setLastGoodAt(new Date().toISOString());
      setError(false);
    } catch { setError(true); }
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 10_000); return () => window.clearInterval(timer); }, [apiPrefix]);
  const picks = data?.mode === 'BEAR_SHORT_3' ? data.shortPicks : data?.mode === 'BULL_LONG_3' ? data.longPicks : [];
  const isStale = error && data !== null;
  return <section className="testnet-panel testnet-wide-panel" id="cross-sectional-directional-decision">
    <header><div><span>Keputusan arah cross-sectional</span><strong>{data ? directionalModeLabel(data.mode) : 'Memuat keputusan…'}</strong></div><span className="tone-measure">khusus testnet · executor source of truth</span></header>
    {error && <div style={{ padding: '9px 12px', color: C.bad, borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
      <strong>{isStale ? 'DATA TERAKHIR — BUKAN DATA LIVE. ' : 'DATA TIDAK TERSEDIA. '}</strong>
      Fetch keputusan executor gagal; jangan gunakan card ini untuk menilai arah atau membuka entry.{lastGoodAt ? ` Terakhir berhasil dimuat ${ago(lastGoodAt)} lalu.` : ''}
    </div>}
    {data && <>
      <div style={{ padding: '10px 12px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', borderBottom: `1px solid ${C.border}` }}>
        <strong style={{ color: directionalModeColor(data.mode), fontSize: 16 }}>{directionalModeLabel(data.mode)}</strong>
        <span style={{ color: C.dim }}>scan selesai {data.scanFinishedAt ? formatDate(data.scanFinishedAt) : 'belum ada'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(180px, 1fr))', borderBottom: `1px solid ${C.border}` }}>
        <Stat label="Scanner breadth" value={data.marketRegime ?? '—'} color={data.marketRegime?.includes('Bearish') ? C.bad : data.marketRegime?.includes('Bullish') ? C.good : C.measure} />
        <Stat label="Canonical regime" value={data.canonicalRegimeFamily} color={data.canonicalRegimeFamily === 'BEARISH' ? C.bad : data.canonicalRegimeFamily === 'BULLISH' ? C.good : C.measure} />
        <Stat label="Canonical gate" value={data.canonicalAllowed ? 'VALID' : data.canonicalAllowed === false ? 'BLOCKED' : 'MENUNGGU'} color={data.canonicalAllowed ? C.good : data.canonicalAllowed === false ? C.bad : C.measure} />
      </div>
      <div style={{ padding: '10px 12px', fontSize: 12, lineHeight: 1.55 }}>
        <strong style={{ color: C.text }}>Mengapa:</strong> <span style={{ color: C.dim }}>{data.reason}</span>
        {data.canonicalReason && <div style={{ color: C.dim, marginTop: 4 }}>Canonical detail: {data.canonicalReason}</div>}
      </div>
      {picks.length > 0 && <div style={{ padding: '0 12px 12px', overflowX: 'auto' }}>
        <div style={{ color: C.dim, fontSize: 12, margin: '4px 0 6px' }}>Tiga simbol yang akan dieksekusi bila mode ini tetap valid</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}><thead><tr style={{ color: C.dim, textAlign: 'left' }}><th style={{ padding: 7 }}>Simbol</th><th>Skor sisi</th><th>Keunggulan relatif</th><th>Confidence</th></tr></thead>
          <tbody>{picks.map((pick) => <tr key={pick.symbol} style={{ borderTop: `1px solid ${C.border}` }}><td style={{ padding: 7, color: C.text, fontWeight: 600 }}>{pick.symbol}</td><td>{pick.sideScore.toFixed(1)}</td><td>{pick.relativeEdge.toFixed(1)}</td><td>{pick.confidence.toFixed(1)}</td></tr>)}</tbody>
        </table>
      </div>}
      <div style={{ padding: '8px 12px', borderTop: `1px solid ${C.border}`, color: C.dim, fontSize: 11 }}>
        Lane short: {data.shortExecutor?.openPositions?.length ?? 0} open · batas rugi harian ${data.shortExecutor?.dailyMaxLossUsd ?? '—'} &nbsp;|&nbsp; Lane long: {data.longExecutor?.openPositions?.length ?? 0} open · batas rugi harian ${data.longExecutor?.dailyMaxLossUsd ?? '—'}. Status `NO TRADE` berarti guard bekerja, bukan lane rusak.
      </div>
    </>}
  </section>;
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
    {data?.crossSectionalPnl && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(150px, 1fr))', borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
      <Stat label="Gross unrealized" value={money(data.crossSectionalPnl.grossUnrealizedUsd)} color={tone(data.crossSectionalPnl.grossUnrealizedUsd)} />
      <Stat label="Unrealized setelah slippage" value={money(data.crossSectionalPnl.unrealizedAfterSlippageUsd)} color={tone(data.crossSectionalPnl.unrealizedAfterSlippageUsd)} />
      <Stat label="Realized sebelum slippage" value={money(data.crossSectionalPnl.realizedBeforeSlippageUsd)} color={tone(data.crossSectionalPnl.realizedBeforeSlippageUsd)} />
      <Stat label="Net realized profit" value={money(data.crossSectionalPnl.netRealizedProfitUsd)} color={tone(data.crossSectionalPnl.netRealizedProfitUsd)} />
    </div>}
    {data?.crossSectionalPnl && <div style={{ padding: '7px 12px', color: C.dim, fontSize: 11 }}>{data.crossSectionalPnl.openBasketCount} basket aktif · {data.crossSectionalPnl.openLegCount} leg aktif · {data.crossSectionalPnl.slippageCaveat}</div>}
    {(data?.openBaskets?.length ?? 0) > 0 && <div style={{ padding: '0 12px 12px' }}>
      <div style={{ color: C.dim, fontSize: 12, marginTop: 10 }}>Open basket · unrealized P&amp;L path</div>
      {data!.openBaskets!.map((basket) => <OpenBasketUnrealizedBlock key={basket.basketId} basket={basket} />)}
    </div>}
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
  const executionLong = config?.executionLongAllowlist ?? config?.longAllowlist ?? [];
  const executionShort = config?.executionShortAllowlist ?? config?.shortAllowlist ?? [];
  const executionShortBlocked = config?.executionShortBlocklist ?? config?.shortBlocklist ?? [];
  const activeShort = executionShort.filter((symbol) => !executionShortBlocked.includes(symbol));

  return <>
  <DirectionalRegimeStatus apiPrefix={apiPrefix} />
  <section className="testnet-panel testnet-wide-panel" id="cross-sectional-definitions">
    <header><div><span>Istilah cross-basket</span><strong>Cara membaca report ini</strong></div><span className="tone-measure">khusus testnet</span></header>
    <div style={{ padding: '10px 12px', display: 'grid', gap: 8, color: C.dim, fontSize: 12, lineHeight: 1.5 }}>
      <div><strong style={{ color: C.text }}>RAW</strong> = universe sinyal dasar. Sistem merangking seluruh pool basket yang eligible tanpa aturan allow/block FILTERED per simbol yang sudah diukur. Ini adalah baseline pembanding, bukan otomatis pilihan eksekusi live.</div>
      <div><strong style={{ color: C.text }}>FILTERED</strong> = ide momentum cross-sectional yang sama setelah melewati filter likuiditas, selisih skor, serta allow/block operator. Executor market-neutral testnet saat ini memakai varian ini.</div>
      <div style={{ display: 'grid', gap: 8, marginTop: 2, padding: '8px 10px', border: `1px solid ${C.border}`, background: C.sub }}>
        <strong style={{ color: C.text }}>Pool FILTERED yang dipakai sekarang</strong>
        {config ? <>
          <div><strong style={{ color: C.good }}>POOL LONG OPERATOR ({executionLong.length})</strong><InlineSymbolList symbols={executionLong} color={C.good} /></div>
          <div><strong style={{ color: C.good }}>POOL SHORT OPERATOR ({executionShort.length})</strong><InlineSymbolList symbols={executionShort} color={C.good} /></div>
          <div><strong style={{ color: C.bad }}>BLOCKED SHORT EKSPLISIT ({executionShortBlocked.length})</strong><InlineSymbolList symbols={executionShortBlocked} color={C.bad} /></div>
          <div><strong style={{ color: C.measure }}>SHORT ELIGIBLE SEKARANG ({activeShort.length})</strong><InlineSymbolList symbols={activeShort} color={C.measure} /></div>
          {!!config.executionExcludedSymbols?.length && <div><strong style={{ color: C.accent }}>DIKELUARKAN SEMENTARA DARI EXECUTOR ({config.executionExcludedSymbols.length})</strong><InlineSymbolList symbols={config.executionExcludedSymbols} color={C.accent} /></div>}
        </> : <div>Memuat konfigurasi FILTERED…</div>}
      </div>
      <div><strong style={{ color: C.text }}>MOM36_FILTERED</strong> = sinyal FILTERED dengan momentum dari 36 candle 1 jam yang sudah selesai. Angka <strong style={{ color: C.accent }}>36</strong> adalah lookback, bukan durasi holding; horizon basket saat ini ditampilkan terpisah di sebelah judul report dan dikonfigurasi secara terpisah.</div>
    </div>
  </section>
  <section className="testnet-panel testnet-wide-panel" id="cross-sectional-report">
    <header>
      <div>
        <span>Cross-sectional horizon report</span>
        <strong>{report ? `${report.horizonBars}h horizon · ${report.signal}` : 'loading…'}</strong>
      </div>
      <span className="tone-measure">pengukuran testnet</span>
    </header>
    <div style={{ padding: '8px 12px', color: C.dim, fontSize: 12 }}>
      {error ? 'DATA TERAKHIR — bukan data live. Pengambilan report gagal; jangan gunakan angka ini untuk entry baru.' : report ? `${report.lastCycleAt ? `siklus terakhir ${ago(report.lastCycleAt)} lalu` : 'belum ada siklus'} · resolusi berikutnya ${duration(report.nextResolveInMs)} · cakupan mulai ${data?.reportStartAt ? formatDate(data.reportStartAt) : 'seluruh histori'}` : 'Memuat report cross-sectional…'}
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
        Pool yang dipakai executor: long {executionLong.length} · short {executionShort.length} · short eligible {activeShort.length}. Auto-demotion historis {config.adaptiveDemotionActive ? 'aktif' : 'nonaktif'}.
      </div>}
    </> : <div style={{ padding: 16, color: C.dim }}>{error ? 'No report data available.' : 'Loading…'}</div>}
  </section>
  <ClosedCrossBasketReport apiPrefix={apiPrefix} />
  </>;
}
