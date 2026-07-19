import { Component, useEffect, useState, type ReactNode } from 'react';
import { CortexCollectionStatusCard } from './CortexCollectionStatusCard';

// Simple but rich monitoring page for the report-only research lanes (cross-sectional market-neutral).
// Self-contained: own fetches + 10s auto-refresh + inline-styled dark cards.
// Served at /research. Surfaces LIVENESS (cycle ran when, funnel, countdowns) so "all 0" is obviously
// "alive but waiting", not "broken". These lanes accrue slowly — empty/thin is normal until mature.

type XSecReport = {
  signal: string; variant?: 'RAW' | 'FILTERED'; horizonBars: number; k: number; open: number; closed: number; expired: number;
  netAvgReturn: number; grossAvgReturn: number; winRate: number; totalNetReturn: number;
  sharpeLike: number | null; longLegAvgReturn: number; shortLegAvgReturn: number;
  targetGrossReturn?: number; edgeReady?: boolean;
  lastCycleAt: string | null; nextResolveInMs: number | null; recentNetReturns: number[];
};
type XSecBasket = { openedAt: string; resolvedAt?: string | null; signal: string; scoreGap?: number | null; netReturnPct?: number | null; grossReturnPct?: number | null; long: string[]; short: string[] };
type XSec = {
  report: XSecReport;
  filteredReport?: XSecReport;
  filteredConfig?: { minScoreGap: number; targetGrossReturn: number; longAllowlist: string[]; shortAllowlist: string[]; shortBlocklist: string[] };
  openBaskets: XSecBasket[];
  filteredOpenBaskets?: XSecBasket[];
  recentClosed: XSecBasket[];
  filteredRecentClosed?: XSecBasket[];
};
type LanePerf = { n: number; netAvgR: number; winRate: number; profitFactor: number | null };
type RGL = {
  totalObs: number; totalGateEligible?: number; totalGatedOut: number;
  deltaBookRAllLanes?: number; deltaBookRTradeableLanes?: number;
  gateReasonCounts?: Array<{ reason: string; count: number }>;
  lanes: Array<{
    variantId: string; raw: LanePerf; gated: LanePerf; dropped?: LanePerf; gateEligible?: number; filteredOut: number; deltaNetAvgR: number;
    deltaBookR?: number; gatedTradeable?: boolean;
    gateReasonCounts?: Array<{ reason: string; count: number }>;
    verdict: 'IMPROVED' | 'WORSENED' | 'FLAT' | 'INSUFFICIENT';
  }>;
};
type PsleCell = {
  laneId: string; symbol: string; direction: 'LONG' | 'SHORT' | 'MIXED' | null; bucket: 'MAJOR' | 'ALT';
  closed: number; headlineClosed: number; netAvgR: number | null; pf: number | null; wr: number | null;
  executable: boolean; suspiciousFill: boolean;
  verdict: string; confirmation: string; promotable: boolean; testnetCandidate: boolean;
};
type PSLE = {
  minClosed: number;
  cells: PsleCell[];
  summary: {
    testnetCandidateCells: number; promotableCells: number;
    byDirection: Record<'LONG' | 'SHORT' | 'MIXED', { measured: number; bookPositive: number; testnetCandidate: number; promotable: number }>;
  };
};
const C = {
  bg: '#0b1418', card: '#14222a', sub: '#0f1c23', border: '#20313a', text: '#dbe7ec', dim: '#7d97a3',
  good: '#46d39a', bad: '#ff6b6b', measure: '#6fb3d6', accent: '#f0b54b', track: '#1c2c34',
};
const pct = (x: number | null | undefined, d = 3) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const pctRaw = (x: number | null | undefined, d = 2) => (x == null ? '—' : `${x.toFixed(d)}%`);
const tone = (x: number | null | undefined) => (x == null ? C.measure : x > 0 ? C.good : x < 0 ? C.bad : C.dim);
const ago = (ts: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const dur = (ms: number) => {
  // A basket overdue for resolution (resolver runs on a 7-min cycle) yields a negative
  // countdown — clamp to "due" instead of rendering "0h -12m".
  if (ms <= 0) return 'due';
  const h = Math.floor(ms / 3600000); const m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

/** The research page is the operator's decision surface — a single render exception must never
 *  white-screen the whole thing. Shows the error inline instead so the failure itself is visible. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ background: C.bg, minHeight: '100vh', color: C.bad, padding: 24, fontFamily: 'ui-monospace, monospace' }}>
          <h2 style={{ color: C.text }}>Research dashboard render error</h2>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.error?.stack ?? this.state.error)}</pre>
          <div style={{ color: C.dim, marginTop: 12 }}>The API data is unaffected — this is a display failure. Reload to retry.</div>
        </div>
      );
    }
    return this.props.children;
  }
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: '8px 14px', borderRight: `1px solid ${C.border}`, minWidth: 0 }}>
      <div style={{ color: C.dim, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ color: color ?? C.text, fontSize: 18, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}
function Card({ title, subtitle, right, children }: { title: string; subtitle?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 18 }}>
      <header style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div><h2 style={{ margin: 0, fontSize: 16, color: C.text }}>{title}</h2>{subtitle && <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>{subtitle}</div>}</div>
        {right && <div style={{ fontSize: 12, color: C.dim }}>{right}</div>}
      </header>
      {children}
    </section>
  );
}
function HBar({ label, value, max, color, valueText }: { label: string; value: number; max: number; color: string; valueText?: string }) {
  const frac = max > 0 ? Math.abs(value) / max : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, padding: '3px 0' }}>
      <span style={{ width: 150, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <div style={{ flex: 1, height: 14, background: C.track, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, frac * 100)}%`, height: '100%', background: color }} />
      </div>
      <span style={{ width: 64, textAlign: 'right', color, fontWeight: 600 }}>{valueText ?? value}</span>
    </div>
  );
}
function Spark({ values }: { values: number[] }) {
  if (!values.length) return <span style={{ color: C.dim, fontSize: 12 }}>no closed baskets yet</span>;
  const max = Math.max(0.0001, ...values.map((v) => Math.abs(v)));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 40 }}>
      {values.map((v, i) => (
        <div key={i} title={pct(v)} style={{ width: 8, height: `${(Math.abs(v) / max) * 18 + 2}px`, background: v >= 0 ? C.good : C.bad, alignSelf: v >= 0 ? 'flex-end' : 'flex-start', borderRadius: 1 }} />
      ))}
    </div>
  );
}
const rfmt = (x: number | null | undefined) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}`);
const VERDICT_COLOR: Record<RGL['lanes'][number]['verdict'], string> = {
  IMPROVED: C.good, WORSENED: C.bad, FLAT: C.dim, INSUFFICIENT: C.measure,
};

type WinnersCf = {
  variant: string; closedCompleteBaskets: number; costReturnPct: number;
  fullBasket: { baskets: number; meanNetReturnPct: number | null; winRatePct: number | null };
  oracle: { baskets: number; meanNetReturnPct: number | null; winRatePct: number | null; note: string };
  checkpoints: Array<{
    checkpointLabel: string; evaluatedBaskets: number; noTradeBaskets: number;
    meanNetReturnPct: number | null; medianNetReturnPct: number | null; winRatePct: number | null;
    fullBasketMeanNetReturnPctSameSubset: number | null;
    persistencePct: number | null; baselineLegPositivePct: number | null;
  }>;
  verdict: string;
};

type RadarCoin = {
  symbol: string;
  baseAsset: string;
  onboardDate: string;
  ageDays: number;
  volume24hUsd: number | null;
  lastPrice: number | null;
  score: number | null;
  flags: string[];
  fundamentals: {
    name: string;
    description: string | null;
    categories: string[];
    marketCapRank: number | null;
    marketCapUsd: number | null;
    fdvUsd: number | null;
    circulatingRatio: number | null;
    homepage: string | null;
    github: string | null;
    commits4w: number | null;
  } | null;
};
type NewCoinRadar = {
  enabled: boolean;
  fetchedAt: string | null;
  lastError: string | null;
  staleHours: number | null;
  maxAgeDays: number;
  coins: RadarCoin[];
};

type Moonshot = {
  daily: { dateUtc: string; tradesToday: number; trades100xToday: number; trades50xPlusToday: number; dailyRealizedLossUsdt: number; activePositions: number };
  defaultMaxLeverage: number;
  totalLogged: number;
  signals24h: number;
  rejects24h: number;
  lastCycle: { ts: string; scanned: number; prefiltered: number; signals: number; rejects: number; universe?: string[] } | null;
  marketCalm: boolean;
  rejectReasons: Array<{ reason: string; count: number }>;
  scoreHistogram: number[];
  recent: Array<{ ts: string; symbol: string; decision: 'SIGNAL' | 'REJECT'; moonshotScore: number; riskScore: number; finalLeverage: number; isSniper: boolean; reasons: string[] }>;
};
export default function ResearchDashboard() {
  return (
    <ErrorBoundary>
      <ResearchDashboardInner />
    </ErrorBoundary>
  );
}

function ResearchDashboardInner() {
  const [xsec, setXsec] = useState<XSec | null>(null);
  const [rgl, setRgl] = useState<RGL | null>(null);
  const [psle, setPsle] = useState<PSLE | null>(null);
  const [wcf, setWcf] = useState<WinnersCf | null>(null);
  const [moon, setMoon] = useState<Moonshot | null>(null);
  const [radar, setRadar] = useState<NewCoinRadar | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    // Each endpoint fails independently — one broken report must not freeze the others
    // (the old Promise.all rejected as a unit, so a single 502 stopped ALL cards updating).
    const grab = async <T,>(url: string): Promise<T | null> => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        return (await res.json()) as T;
      } catch { return null; }
    };
    const [a, c, d, m, r] = await Promise.all([
      grab<XSec>('/api/shadow/cross-sectional-report'),
      grab<RGL>('/api/shadow/regime-gated-lanes'),
      grab<PSLE>('/api/shadow/per-symbol-lane-edge'),
      grab<Moonshot>('/api/shadow/moonshot-report'),
      grab<NewCoinRadar>('/api/shadow/new-coin-radar'),
    ]);
    if (a) setXsec(a);
    if (c) setRgl(c);
    if (d) setPsle(d);
    if (m) setMoon(m);
    if (r) setRadar(r);
    const failed = [a === null && 'cross-sectional', c === null && 'regime-gated', d === null && 'per-symbol-edge', m === null && 'moonshot'].filter(Boolean);
    setErr(failed.length ? `unreachable: ${failed.join(', ')}` : null);
    if (failed.length < 4) setUpdated(Date.now());
  }
  // Winners counterfactual: own slower cadence — server caches it 10 min, and a cache-miss
  // recompute fetches real candles (seconds), so it must never sit inside the 10s loop.
  async function loadWcf() {
    try {
      const res = await fetch('/api/shadow/cross-sectional-winners-counterfactual', { cache: 'no-store' });
      const body = await res.json();
      if (body?.ok) setWcf(body as WinnersCf);
    } catch { /* keep last */ }
  }
  useEffect(() => { void load(); const t = window.setInterval(() => void load(), 10_000); return () => window.clearInterval(t); }, []);
  useEffect(() => { void loadWcf(); const t = window.setInterval(() => void loadWcf(), 60_000); return () => window.clearInterval(t); }, []);

  const r = xsec?.report;
  const rf = xsec?.filteredReport;
  const legMax = Math.max(0.0001, Math.abs(r?.longLegAvgReturn ?? 0), Math.abs(r?.shortLegAvgReturn ?? 0));
  const filteredLegMax = Math.max(0.0001, Math.abs(rf?.longLegAvgReturn ?? 0), Math.abs(rf?.shortLegAvgReturn ?? 0));

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.text, fontFamily: 'ui-sans-serif, system-ui, sans-serif', padding: '20px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Research Lanes <span style={{ fontSize: 13, color: C.dim, fontWeight: 400 }}>· report-only measurement</span></h1>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 4 }}>prove OOS (bull AND bear) before any read · not real money</div>
        </div>
        <div style={{ color: C.dim, fontSize: 12 }}>
          <span style={{ color: err ? C.bad : C.good }}>●</span> {err ? 'link error' : updated ? `updated ${ago(new Date(updated).toISOString())} ago` : 'loading…'} · auto-refresh 10s
        </div>
      </header>

      <CortexCollectionStatusCard />

      {(() => {
        if (!psle) return null;
        const tradeable = (psle.cells ?? [])
          .filter((c) => c.testnetCandidate || c.promotable)
          .sort((a, b) => (b.netAvgR ?? -9) - (a.netAvgR ?? -9));
        const stageBadge = (c: PsleCell) => c.promotable
          ? <span style={{ color: C.good, fontSize: 10, fontWeight: 700 }}>PROMOTABLE</span>
          : <span style={{ color: C.measure, fontSize: 10, fontWeight: 700 }}>testnet-cand</span>;
        const bd = psle.summary?.byDirection;
        const pcol = '1.1fr 0.6fr 1.6fr 0.7fr 0.6fr 0.6fr 0.5fr 0.5fr 1fr';
        const ph = (t: string, a: 'left' | 'right' = 'right') => <span style={{ textAlign: a, color: C.dim, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 }}>{t}</span>;
        return (
          <Card
            title="Per-symbol book edge — which symbols &amp; lanes are good for live"
            subtitle="Every (symbol × lane × direction) cell scored on the REALIZED paper book (not the optimistic sim). testnet-candidate = book-credible, drives the live auto-rotation; PROMOTABLE = also headline-confirmed. Mirages (MAKER, PF/WR too-good) are auto-excluded."
            right={psle.summary ? <>{psle.summary.testnetCandidateCells} tradeable · {psle.summary.promotableCells} promotable</> : null}
          >
            {bd && (
              <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, fontSize: 12, color: C.dim }}>
                by direction — LONG: <span style={{ color: C.text }}>{bd.LONG.testnetCandidate}</span> tradeable · SHORT: <span style={{ color: C.text }}>{bd.SHORT.testnetCandidate}</span> · MIXED: <span style={{ color: C.text }}>{bd.MIXED.testnetCandidate}</span>
                {psle.summary.promotableCells === 0 && <span style={{ color: C.measure }}> · none headline-confirmed yet (all diagnostic-only — testnet earns confirmation over time)</span>}
              </div>
            )}
            <div style={{ padding: '6px 16px 14px', overflowX: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: pcol, gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
                {ph('symbol', 'left')}{ph('dir')}{ph('lane', 'left')}{ph('book avgR')}{ph('PF')}{ph('WR')}{ph('n')}{ph('hl')}{ph('stage')}
              </div>
              {tradeable.length ? tradeable.map((c) => (
                <div key={`${c.laneId}:${c.symbol}:${c.direction}`} style={{ display: 'grid', gridTemplateColumns: pcol, gap: 8, alignItems: 'center', padding: '5px 0', borderTop: `1px solid ${C.sub}`, fontSize: 13 }}>
                  <span style={{ color: C.text, fontWeight: 600 }}>{c.symbol.replace(/USDT$/, '')}</span>
                  <span style={{ textAlign: 'right', color: c.direction === 'LONG' ? C.good : C.bad }}>{c.direction}</span>
                  <span style={{ color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.laneId}>{c.laneId.split(':').pop()?.replace(/^CG_/, '')}</span>
                  <span style={{ textAlign: 'right', color: tone(c.netAvgR ?? 0), fontWeight: 700 }}>{rfmt(c.netAvgR)}</span>
                  <span style={{ textAlign: 'right', color: C.dim }}>{c.pf == null ? '—' : c.pf.toFixed(2)}</span>
                  <span style={{ textAlign: 'right', color: C.dim }}>{c.wr == null ? '—' : `${Math.round(c.wr * 100)}%`}</span>
                  <span style={{ textAlign: 'right', color: C.dim }}>{c.closed}</span>
                  <span style={{ textAlign: 'right', color: c.headlineClosed > 0 ? C.good : C.dim }}>{c.headlineClosed}</span>
                  <span style={{ textAlign: 'right' }}>{stageBadge(c)}</span>
                </div>
              )) : <div style={{ padding: 12, color: C.dim }}>no book-proven symbols yet — accruing</div>}
              <div style={{ fontSize: 11, color: C.dim, marginTop: 10 }}>
                Bar: n≥{psle.minClosed} closed, book netAvgR≥+0.03, PF&gt;1, executable, non-suspicious. <span style={{ color: C.text }}>hl</span> = headline closes (0 = diagnostic-only, not yet promotable). Each instance reads its OWN book — live (mainnet) shows what mainnet has traded.
              </div>
            </div>
          </Card>
        );
      })()}

      {(() => {
        const lanes = (rgl?.lanes ?? []).filter((l) => l.raw.n >= 5);
        const tally = { IMPROVED: 0, WORSENED: 0, FLAT: 0, INSUFFICIENT: 0 };
        lanes.forEach((l) => { tally[l.verdict] += 1; });
        const verdictTag = (v: keyof typeof tally) => (
          <span style={{ color: VERDICT_COLOR[v], marginRight: 12 }}>{tally[v]} {v.toLowerCase()}</span>
        );
        const col = '1.7fr 0.5fr 0.8fr 0.6fr 0.5fr 0.8fr 0.6fr 0.8fr 0.95fr 1fr';
        const head = (t: string, align: 'left' | 'right' = 'right') => (
          <span style={{ textAlign: align, color: C.dim, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 }}>{t}</span>
        );
        return (
          <Card
            title="Regime-gated lane comparison"
            subtitle="VM lanes re-scored with captured EXTENDED regime direction only; tactical/mixed/legacy rows are kept — does the stricter gate improve each lane?"
            right={rgl ? <>{rgl.totalObs} resolved obs · {rgl.totalGateEligible ?? 0} gate-eligible · {rgl.totalGatedOut} gated-out</> : null}
          >
            {rgl ? (
              lanes.length ? (
                <>
                  <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                    Verdict (book-R, gated n≥15): {verdictTag('IMPROVED')}{verdictTag('WORSENED')}{verdictTag('FLAT')}{verdictTag('INSUFFICIENT')}
                    {typeof rgl.deltaBookRTradeableLanes === 'number' && (
                      <div style={{ marginTop: 6, fontSize: 12, color: rgl.deltaBookRTradeableLanes >= 0 ? C.good : C.bad, fontWeight: 600 }}>
                        Book-R impact of blanket-gating the lanes you'd actually run (still net-positive after gating): {rfmt(rgl.deltaBookRTradeableLanes)}R
                        {rgl.deltaBookRTradeableLanes < 0 && <span style={{ color: C.dim, fontWeight: 400 }}> — gating would DISCARD realized edge (it drops winners on the profitable lanes). Do not wire it.</span>}
                      </div>
                    )}
                  </div>
                  <div style={{ padding: '6px 16px 14px', overflowX: 'auto' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: col, gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
                      {head('Lane', 'left')}{head('raw n')}{head('raw avgR')}{head('raw WR')}{head('gt n')}{head('gated avgR')}{head('gt WR')}{head('Δ avgR')}{head('Δ book R')}{head('verdict')}
                    </div>
                    {lanes.map((l) => (
                      <div key={l.variantId} style={{ display: 'grid', gridTemplateColumns: col, gap: 8, alignItems: 'center', padding: '5px 0', borderTop: `1px solid ${C.sub}`, fontSize: 13 }}>
                        <span style={{ color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={l.variantId}>{l.variantId.replace(/^CG_/, '')}</span>
                        <span style={{ textAlign: 'right', color: C.dim }}>{l.raw.n}</span>
                        <span style={{ textAlign: 'right', color: tone(l.raw.netAvgR), fontWeight: 600 }}>{rfmt(l.raw.netAvgR)}</span>
                        <span style={{ textAlign: 'right', color: C.dim }}>{Math.round(l.raw.winRate * 100)}%</span>
                        <span style={{ textAlign: 'right', color: C.dim }}>{l.gated.n}</span>
                        <span style={{ textAlign: 'right', color: tone(l.gated.netAvgR), fontWeight: 600 }}>{rfmt(l.gated.netAvgR)}</span>
                        <span style={{ textAlign: 'right', color: C.dim }}>{Math.round(l.gated.winRate * 100)}%</span>
                        <span style={{ textAlign: 'right', color: C.dim, fontWeight: 600 }}>{rfmt(l.deltaNetAvgR)}</span>
                        <span style={{ textAlign: 'right', color: tone(l.deltaBookR ?? 0), fontWeight: 700 }} title="book-R gained/lost by gating this lane (= −dropped totalR)">{typeof l.deltaBookR === 'number' ? `${l.deltaBookR >= 0 ? '+' : ''}${l.deltaBookR.toFixed(1)}R` : '—'}</span>
                        <span style={{ textAlign: 'right', color: VERDICT_COLOR[l.verdict], fontSize: 11, fontWeight: 600 }} title={l.gatedTradeable === false ? 'lane still net-negative after gating — not tradeable either way' : ''}>{l.verdict}{l.gatedTradeable === false ? '*' : ''}</span>
                      </div>
                    ))}
                    <div style={{ fontSize: 11, color: C.dim, marginTop: 10 }}>
                      Gate drops only captured EXTENDED counter-regime rows. <strong style={{ color: C.text }}>Verdict is now BOOK-R based</strong> (Δ book R = gated − raw totalR = the realized edge gating adds/removes), NOT the per-trade average.
                      <span style={{ color: C.dim }}> Δ avgR (greyed) rises whenever a below-average tail is dropped — even if those trades were winners, which is why it read a misleading “19 improved.”</span>
                      {' '}<span style={{ color: C.bad }}>Negative Δ book R = gating discards realized profit (drops winners).</span> <span title="lane still net-negative after gating">* = lane still net-negative after gating (not tradeable either way).</span>
                    </div>
                  </div>
                </>
              ) : <div style={{ padding: 16, color: C.dim }}>no resolved observations yet</div>
            ) : <div style={{ padding: 16, color: C.dim }}>loading…</div>}
          </Card>
        );
      })()}

      <Card
        title="Cross-sectional market-neutral"
        subtitle={r ? `${r.signal} · long-top-${r.k} / short-bottom-${r.k} · ${r.horizonBars}-bar horizon · beta-cancelled dispersion` : 'loading…'}
        right={r ? <>{r.lastCycleAt ? `cycle ${ago(r.lastCycleAt)} ago` : 'no cycle yet'}{r.nextResolveInMs != null && <> · <span style={{ color: C.accent }}>first resolves in {dur(r.nextResolveInMs)}</span></>}</> : null}
      >
        {r ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: `1px solid ${C.border}` }}>
              <Stat label="Closed" value={`${r.closed}`} />
              <Stat label="Open" value={`${r.open}`} />
              <Stat label="Net avg return" value={pct(r.netAvgReturn)} color={tone(r.netAvgReturn)} />
              <Stat label="Win rate" value={r.closed ? `${Math.round(r.winRate * 100)}%` : '—'} />
              <Stat label="Sharpe-like" value={r.sharpeLike == null ? '—' : r.sharpeLike.toFixed(2)} color={tone(r.sharpeLike)} />
              <Stat label="Total net" value={pct(r.totalNetReturn, 2)} color={tone(r.totalNetReturn)} />
            </div>
            <div style={{ display: 'flex', gap: 24, padding: '14px 16px', flexWrap: 'wrap', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ flex: '1 1 280px', minWidth: 240 }}>
                <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>Leg contribution (the dispersion = both legs winning)</div>
                <HBar label="Long leg avg" value={r.longLegAvgReturn} max={legMax} color={tone(r.longLegAvgReturn)} valueText={pct(r.longLegAvgReturn)} />
                <HBar label="Short leg avg" value={r.shortLegAvgReturn} max={legMax} color={tone(r.shortLegAvgReturn)} valueText={pct(r.shortLegAvgReturn)} />
              </div>
              <div style={{ flex: '1 1 240px', minWidth: 200 }}>
                <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>Closed-basket net returns</div>
                <Spark values={r.recentNetReturns} />
              </div>
            </div>
            <div style={{ padding: '12px 16px' }}>
              <div style={{ color: C.dim, fontSize: 12, marginBottom: 6 }}>
                {r.closed === 0 ? `${r.open} open baskets accruing — none matured yet (each resolves after the ${r.horizonBars}h horizon)` : 'Recent closed baskets'}
              </div>
              {(xsec.recentClosed ?? []).slice(-6).reverse().map((b, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, fontSize: 13, padding: '4px 0', borderTop: i ? `1px solid ${C.border}` : undefined }}>
                  <span style={{ color: tone(b.netReturnPct), fontWeight: 600, width: 64 }}>{pctRaw(b.netReturnPct)}</span>
                  <span style={{ color: C.good }}>L: {b.long.join(', ')}</span>
                  <span style={{ color: C.bad }}>S: {b.short.join(', ')}</span>
                  <span style={{ color: C.dim, marginLeft: 'auto' }}>{b.resolvedAt ? `${ago(b.resolvedAt)} ago` : ''}</span>
                </div>
              ))}
              {(xsec.openBaskets ?? []).slice(-3).reverse().map((b, i) => (
                <div key={`o${i}`} style={{ display: 'flex', gap: 12, fontSize: 13, padding: '4px 0', borderTop: `1px solid ${C.border}`, opacity: 0.65 }}>
                  <span style={{ color: C.measure, width: 64 }}>OPEN</span>
                  <span style={{ color: C.good }}>L: {b.long.join(', ')}</span>
                  <span style={{ color: C.bad }}>S: {b.short.join(', ')}</span>
                  <span style={{ color: C.dim, marginLeft: 'auto' }}>{ago(b.openedAt)} ago</span>
                </div>
              ))}
            </div>
          </>
        ) : <div style={{ padding: 16, color: C.dim }}>loading…</div>}
      </Card>

      <Card
        title="Cross-sectional filtered"
        subtitle={rf ? `${rf.signal} · symbol-filtered · score gap >= ${pctRaw((xsec?.filteredConfig?.minScoreGap ?? 0) * 100, 2)} · target gross ${pct(xsec?.filteredConfig?.targetGrossReturn ?? rf.targetGrossReturn ?? 0, 2)}` : 'loading…'}
        right={rf ? <span style={{ color: rf.edgeReady ? C.good : C.accent }}>{rf.edgeReady ? 'edge ready' : 'collecting filtered OOS'}</span> : null}
      >
        {rf ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: `1px solid ${C.border}` }}>
              <Stat label="Closed" value={`${rf.closed}`} />
              <Stat label="Open" value={`${rf.open}`} />
              <Stat label="Net avg return" value={pct(rf.netAvgReturn)} color={tone(rf.netAvgReturn)} />
              <Stat label="Gross avg return" value={pct(rf.grossAvgReturn)} color={tone(rf.grossAvgReturn)} />
              <Stat label="Win rate" value={rf.closed ? `${Math.round(rf.winRate * 100)}%` : '—'} />
              <Stat label="Total net" value={pct(rf.totalNetReturn, 2)} color={tone(rf.totalNetReturn)} />
            </div>
            <div style={{ display: 'flex', gap: 24, padding: '12px 16px', flexWrap: 'wrap', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ flex: '1 1 280px', minWidth: 240 }}>
                <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>Filtered leg contribution</div>
                <HBar label="Long leg avg" value={rf.longLegAvgReturn} max={filteredLegMax} color={tone(rf.longLegAvgReturn)} valueText={pct(rf.longLegAvgReturn)} />
                <HBar label="Short leg avg" value={rf.shortLegAvgReturn} max={filteredLegMax} color={tone(rf.shortLegAvgReturn)} valueText={pct(rf.shortLegAvgReturn)} />
              </div>
              <div style={{ flex: '1 1 300px', minWidth: 260, fontSize: 12, color: C.dim, lineHeight: 1.55 }}>
                <div><span style={{ color: C.good }}>Long allow:</span> {(xsec?.filteredConfig?.longAllowlist ?? []).join(', ')}</div>
                <div><span style={{ color: C.bad }}>Short allow:</span> {(xsec?.filteredConfig?.shortAllowlist ?? []).join(', ')}</div>
                <div><span style={{ color: C.accent }}>Short blocked:</span> {(xsec?.filteredConfig?.shortBlocklist ?? []).join(', ')}</div>
              </div>
            </div>
            <div style={{ padding: '12px 16px' }}>
              <div style={{ color: C.dim, fontSize: 12, marginBottom: 6 }}>
                {rf.closed === 0 ? `${rf.open} filtered baskets accruing — first resolved sample needs the ${rf.horizonBars}h horizon` : 'Recent filtered baskets'}
              </div>
              {(xsec.filteredRecentClosed ?? []).slice(-6).reverse().map((b, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, fontSize: 13, padding: '4px 0', borderTop: i ? `1px solid ${C.border}` : undefined }}>
                  <span style={{ color: tone(b.netReturnPct), fontWeight: 600, width: 64 }}>{pctRaw(b.netReturnPct)}</span>
                  <span style={{ color: C.good }}>L: {b.long.join(', ')}</span>
                  <span style={{ color: C.bad }}>S: {b.short.join(', ')}</span>
                  <span style={{ color: C.dim, marginLeft: 'auto' }}>{b.resolvedAt ? `${ago(b.resolvedAt)} ago` : ''}</span>
                </div>
              ))}
              {(xsec.filteredOpenBaskets ?? []).slice(-3).reverse().map((b, i) => (
                <div key={`fo${i}`} style={{ display: 'flex', gap: 12, fontSize: 13, padding: '4px 0', borderTop: `1px solid ${C.border}`, opacity: 0.7 }}>
                  <span style={{ color: C.measure, width: 64 }}>OPEN</span>
                  <span style={{ color: C.good }}>L: {b.long.join(', ')}</span>
                  <span style={{ color: C.bad }}>S: {b.short.join(', ')}</span>
                  <span style={{ color: C.dim, marginLeft: 'auto' }}>{ago(b.openedAt)} ago</span>
                </div>
              ))}
            </div>
          </>
        ) : <div style={{ padding: 16, color: C.dim }}>loading…</div>}
      </Card>

      <Card
        title="Winners-only counterfactual"
        subtitle='Tests "open only the good legs" against closed-basket history: hindsight oracle vs realistic late-entry checkpoints (enter at the checkpoint price after a leg proves positive). Persistence = P(still positive at exit | positive at checkpoint).'
        right={wcf ? <>{wcf.closedCompleteBaskets} baskets · {wcf.variant} · refreshes 10m</> : null}
      >
        {wcf ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: `1px solid ${C.border}` }}>
              <Stat label="Full basket" value={pctRaw(wcf.fullBasket.meanNetReturnPct)} color={tone(wcf.fullBasket.meanNetReturnPct)} />
              <Stat label="Oracle (hindsight)" value={pctRaw(wcf.oracle.meanNetReturnPct)} color={C.measure} />
              {wcf.checkpoints.map((c) => (
                <Stat key={c.checkpointLabel} label={`pick @ ${c.checkpointLabel.split(' ')[0]}`} value={pctRaw(c.meanNetReturnPct)} color={tone(c.meanNetReturnPct)} />
              ))}
            </div>
            <div style={{ padding: '10px 16px' }}>
              {wcf.checkpoints.map((c) => (
                <div key={c.checkpointLabel} style={{ display: 'flex', gap: 14, fontSize: 12, color: C.dim, padding: '3px 0', flexWrap: 'wrap' }}>
                  <span style={{ color: C.text, width: 90 }}>{c.checkpointLabel}</span>
                  <span>strategy <span style={{ color: tone(c.meanNetReturnPct), fontWeight: 600 }}>{pctRaw(c.meanNetReturnPct)}</span></span>
                  <span>vs full <span style={{ color: tone(c.fullBasketMeanNetReturnPctSameSubset), fontWeight: 600 }}>{pctRaw(c.fullBasketMeanNetReturnPctSameSubset)}</span></span>
                  <span>WR {c.winRatePct == null ? '—' : `${Math.round(c.winRatePct)}%`}</span>
                  <span>persistence <span style={{ color: C.text }}>{c.persistencePct == null ? '—' : `${Math.round(c.persistencePct)}%`}</span> vs base {c.baselineLegPositivePct == null ? '—' : `${Math.round(c.baselineLegPositivePct)}%`}</span>
                  <span>n={c.evaluatedBaskets}{c.noTradeBaskets > 0 ? ` (${c.noTradeBaskets} no-trade)` : ''}</span>
                </div>
              ))}
              <div style={{ fontSize: 11, color: C.dim, marginTop: 8 }}>{wcf.verdict}</div>
            </div>
          </>
        ) : <div style={{ padding: 16, color: C.dim }}>computing (fetches real candles on first load)…</div>}
      </Card>

      <Card
        title="Moonshot lottery — burst hunter (fokus MEME)"
        subtitle="Measurement-only: scan universe MEME COIN tiap cycle untuk mover yang lagi meledak (1m volume/price surge), skor 0–100, LOG signal-atau-reject. Universe = seed meme divalidasi runtime ke exchangeInfo Binance (simbol delisted/typo dibuang otomatis). Tetap NOL order — eksekusi live (kalau nanti) build terpisah yang lu trigger sendiri."
        right={moon ? <>{moon.signals24h} signals 24h · lev cap {moon.defaultMaxLeverage}x · report-only</> : null}
      >
        {moon ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: `1px solid ${C.border}` }}>
              <Stat label="Last cycle" value={moon.lastCycle ? `${ago(moon.lastCycle.ts)} ago` : 'never'} color={moon.lastCycle ? C.text : C.bad} />
              <Stat label="Funnel (last cycle)" value={moon.lastCycle ? `${moon.lastCycle.scanned} → ${moon.lastCycle.prefiltered} → ${moon.lastCycle.signals}✓ / ${moon.lastCycle.rejects}✗` : '—'} color={C.dim} />
              <Stat label="Signals 24h" value={String(moon.signals24h)} color={moon.signals24h > 0 ? C.good : C.dim} />
              <Stat label="Rejects 24h" value={String(moon.rejects24h)} color={C.dim} />
              <Stat label="Logged total" value={String(moon.totalLogged)} color={C.dim} />
              <Stat label="Trades today" value={`${moon.daily.tradesToday} (100x: ${moon.daily.trades100xToday})`} color={C.dim} />
            </div>
            <div style={{ padding: '10px 16px' }}>
              {moon.lastCycle?.universe && moon.lastCycle.universe.length > 0 && (
                <div style={{ fontSize: 11, color: C.dim, marginBottom: 8 }}>
                  universe meme ({moon.lastCycle.universe.length}): {moon.lastCycle.universe.map((s) => s.replace(/USDT$/, '').replace(/^1000|^1M/, '')).join(' · ')}
                </div>
              )}
              {moon.marketCalm && (
                <div style={{ fontSize: 12, color: C.measure, marginBottom: 8 }}>
                  market calm — cycle jalan normal tapi tidak ada mover yang lolos prefilter (bukan lane mati, memang belum ada yang meledak)
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 46, marginBottom: 4 }}>
                {moon.scoreHistogram.map((count, i) => {
                  const max = Math.max(1, ...moon.scoreHistogram);
                  return <div key={i} title={`score ${i * 10}–${i * 10 + 9}: ${count}`} style={{ width: 22, height: `${(count / max) * 40 + 2}px`, background: i >= 8 ? C.good : i >= 6 ? C.measure : C.sub, borderRadius: 2 }} />;
                })}
              </div>
              <div style={{ fontSize: 10, color: C.dim, marginBottom: 10 }}>score histogram 0–100 (semua kandidat yang pernah discore — hijau = zona signal)</div>
              {moon.rejectReasons.length > 0 && (
                <div style={{ fontSize: 12, color: C.dim, marginBottom: 10 }}>
                  top reject: {moon.rejectReasons.slice(0, 5).map((r) => `${r.reason} (${r.count})`).join(' · ')}
                </div>
              )}
              {moon.recent.length > 0 ? (
                <div>
                  {moon.recent.slice(-8).reverse().map((e, idx) => (
                    <div key={`${e.ts}-${e.symbol}-${idx}`} style={{ display: 'flex', gap: 12, fontSize: 12, padding: '3px 0', borderTop: `1px solid ${C.sub}`, flexWrap: 'wrap' }}>
                      <span style={{ color: C.dim, width: 70 }}>{ago(e.ts)} ago</span>
                      <span style={{ color: C.text, fontWeight: 600, width: 80 }}>{e.symbol.replace(/USDT$/, '')}</span>
                      <span style={{ color: e.decision === 'SIGNAL' ? C.good : C.bad, fontWeight: 700, width: 60 }}>{e.decision}</span>
                      <span style={{ color: C.dim }}>score {e.moonshotScore}</span>
                      <span style={{ color: C.dim }}>lev {e.finalLeverage}x{e.isSniper ? ' · sniper' : ''}</span>
                      <span style={{ color: C.dim, flex: 1, minWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={e.reasons.join('; ')}>{e.reasons[0] ?? ''}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: C.dim }}>belum ada kandidat yang discore — log terisi begitu ada mover yang lolos prefilter</div>
              )}
            </div>
          </>
        ) : <div style={{ padding: 16, color: C.dim }}>loading moonshot report…</div>}
      </Card>

      <Card
        title="New-coin radar — listing baru + profil fundamental"
        subtitle={`Perpetual USDT yang baru listing di Binance (≤${radar?.maxAgeDays ?? 120} hari, dari onboardDate resmi exchange), di luar universe lama. Tiap coin diprofil dari CoinGecko: apa proyeknya, teknologi/kategori, mcap vs FDV (risiko dilusi), aktivitas developer. Report-only — promosi ke universe tetap keputusan operator.`}
        right={radar ? <>{radar.coins.length} coin · refresh 12 jam{radar.staleHours != null ? ` · ${radar.staleHours}h lalu` : ''}</> : null}
      >
        {radar ? (
          radar.coins.length > 0 ? (
            <div style={{ padding: '6px 16px 14px' }}>
              {radar.lastError && <div style={{ color: C.bad, fontSize: 12, padding: '6px 0' }}>radar error: {radar.lastError}</div>}
              {radar.coins.map((c) => (
                <div key={c.symbol} style={{ borderTop: `1px solid ${C.sub}`, padding: '10px 0' }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>{c.symbol.replace(/USDT$/, '')}</span>
                    <span style={{ color: C.dim, fontSize: 12 }}>umur {Math.round(c.ageDays)} hari</span>
                    <span style={{ color: c.score == null ? C.dim : c.score >= 60 ? C.good : c.score >= 35 ? C.measure : C.bad, fontWeight: 700, fontSize: 13 }}>
                      skor {c.score ?? '—'}
                    </span>
                    {c.fundamentals?.categories?.slice(0, 3).map((cat) => (
                      <span key={cat} style={{ color: C.measure, fontSize: 11, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 6px' }}>{cat}</span>
                    ))}
                    {c.flags.map((f) => (
                      <span key={f} style={{ color: C.bad, fontSize: 10, fontWeight: 700 }}>{f}</span>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 16, fontSize: 12, color: C.dim, marginTop: 4, flexWrap: 'wrap' }}>
                    <span>vol 24h {c.volume24hUsd == null ? '—' : `$${(c.volume24hUsd / 1e6).toFixed(1)}M`}</span>
                    <span>mcap {c.fundamentals?.marketCapUsd == null ? '—' : `$${(c.fundamentals.marketCapUsd / 1e6).toFixed(0)}M`}{c.fundamentals?.marketCapRank != null ? ` (#${c.fundamentals.marketCapRank})` : ''}</span>
                    <span>FDV {c.fundamentals?.fdvUsd == null ? '—' : `$${(c.fundamentals.fdvUsd / 1e6).toFixed(0)}M`}</span>
                    <span>circulating {c.fundamentals?.circulatingRatio == null ? '—' : `${Math.round(c.fundamentals.circulatingRatio * 100)}%`}</span>
                    <span>commits 4w {c.fundamentals?.commits4w ?? '—'}</span>
                    {c.fundamentals?.homepage && <a href={c.fundamentals.homepage} target="_blank" rel="noreferrer" style={{ color: C.measure }}>web</a>}
                    {c.fundamentals?.github && <a href={c.fundamentals.github} target="_blank" rel="noreferrer" style={{ color: C.measure }}>github</a>}
                  </div>
                  {c.fundamentals?.description && (
                    <div style={{ fontSize: 12, color: C.text, opacity: 0.85, marginTop: 6, lineHeight: 1.5, maxWidth: 900 }}>
                      {c.fundamentals.description.length > 300 ? `${c.fundamentals.description.slice(0, 300)}…` : c.fundamentals.description}
                    </div>
                  )}
                </div>
              ))}
              <div style={{ fontSize: 11, color: C.dim, marginTop: 10 }}>
                Skor = likuiditas (log vol 24h) + circulating ratio + rank mcap + aktivitas dev + kelengkapan identitas. Skor — / flag NO_FUNDAMENTAL_DATA = datanya belum ada, bukan nol.
              </div>
            </div>
          ) : (
            <div style={{ padding: 16, color: C.dim }}>
              {radar.lastError ? `radar error: ${radar.lastError}` : radar.fetchedAt ? `tidak ada listing baru ≤${radar.maxAgeDays} hari di luar universe` : 'cycle pertama belum jalan (nunggu scan berikutnya)…'}
            </div>
          )
        ) : <div style={{ padding: 16, color: C.dim }}>loading new-coin radar…</div>}
      </Card>

    </div>
  );
}
