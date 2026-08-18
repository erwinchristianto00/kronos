import { useEffect, useState, type ReactNode } from 'react';

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
  entryLiquidity?: { makerQty: number; takerQty: number; reason: string } | null;
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
type ClosedAuditHistory = {
  excludedFromActiveCohort: boolean;
  reason: string;
  totalClosed: number;
  totalNetPnlUsd: number;
  lanes: ClosedLane[];
};
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
    entryLiquidity?: { makerQty: number; takerQty: number; reason: string } | null;
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
  auditHistory?: ClosedAuditHistory | null;
};
type XSecExecStatus = {
  allowed: boolean;
  enabled: boolean;
  signalAgeMs: number | null;
  signalMaxAgeMs: number | null;
  signalStale: boolean;
  openHalted?: string | null;
  entryAdmission?: { tier?: string; allowed?: boolean; reason?: string; maxLearningOpen?: number } | null;
  entryAttemptAudit?: { latest?: { at: string; stage: string; outcome: string; reason: string; longSymbols?: string[]; shortSymbols?: string[] } | null } | null;
};
type RegimeBreadth = {
  advancersPct: number | null;
  altAdvancersPct?: number | null;
  percentAboveEma20: number | null;
  btcReturn24h: number | null;
  unavailableReason?: string | null;
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

type EntryLiquidity = { makerQty: number; takerQty: number; reason: string } | null | undefined;

/**
 * How a leg's ENTRY was filled, split by liquidity.
 *
 * EXACT, not an estimate. Binance rejects a GTX order outright if it would cross, so it can only
 * ever fill as maker; a MARKET order can only ever fill as taker. Which order filled which quantity
 * therefore IS the split — no per-fill lookup needed to make it true.
 *
 * An ABSENT field is not unknown: legs opened before 2026-08-16 could only be placed as MARKET, so
 * absence means taker and is rendered as taker. Rendering it as "—" would turn a code-level
 * certainty into a mystery. Exits are still MARKET on every path, so there is no exit badge —
 * that fact is stated once per panel instead of repeated on every row.
 */
/** Modal yang benar-benar dipakai basket: jumlah notional entry seluruh kakinya.
 *
 *  Returns null unless EVERY leg is priced. A partial sum would understate the denominator and
 *  quietly inflate every percentage built on it — better to show no percentage than a flattering
 *  one. Margin is notional/leverage, so this is exposure, not cash locked; the label says so. */
function basketNotionalUsd(legs: ReadonlyArray<{ qty: number; entryPrice: number }>): number | null {
  let total = 0;
  for (const l of legs) {
    if (!(l.qty > 0) || !(l.entryPrice > 0)) return null;
    total += l.qty * l.entryPrice;
  }
  return total > 0 ? total : null;
}

/** The six gross/after-cost figures as ONE horizontal strip, each with its share of basket capital.
 *
 *  Was two separate copies — six wide tiles in the closed panel, six wrapping cells in the open one
 *  — which pushed everything else below the fold and gave the numbers no scale: "+0.72 USDT" says
 *  nothing until you know it sits on $105. Same component both places now, so the two can no longer
 *  drift apart, and the percentage is always against the same denominator. */
function ExtremaStrip({ rows, capitalUsd }: {
  rows: ReadonlyArray<readonly [string, number | null | undefined]>;
  capitalUsd: number | null;
}) {
  const pct = (v: number | null | undefined) =>
    capitalUsd && capitalUsd > 0 && v != null && Number.isFinite(v)
      ? `${v >= 0 ? '+' : ''}${(v / capitalUsd * 100).toFixed(3)}%`
      : null;
  return <div style={{
    display: 'grid', gridTemplateColumns: `repeat(${rows.length}, minmax(84px, 1fr))`,
    borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, overflowX: 'auto',
  }}>
    {rows.map(([label, value], i) => (
      <div key={label} style={{ padding: '5px 8px', borderLeft: i ? `1px solid ${C.border}` : undefined }}>
        <small style={{ display: 'block', color: C.dim, fontSize: 9.5, lineHeight: 1.3, whiteSpace: 'nowrap' }}>{label}</small>
        <strong style={{ color: tone(value), fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{money(value)}</strong>
        {pct(value) && <small style={{ display: 'block', color: C.dim, fontSize: 9.5, fontVariantNumeric: 'tabular-nums' }}>{pct(value)}</small>}
      </div>
    ))}
  </div>;
}

/** Modal line for a basket header. */
function CapitalNote({ legs }: { legs: ReadonlyArray<{ qty: number; entryPrice: number }> }) {
  const n = basketNotionalUsd(legs);
  if (n === null) return <span style={{ color: C.dim, fontSize: 11 }}>modal — (ada kaki tanpa harga)</span>;
  return <span style={{ color: C.dim, fontSize: 11 }}>
    modal <strong style={{ color: C.text }}>${n.toFixed(2)}</strong> · {legs.length} kaki · ~${(n / legs.length).toFixed(2)}/kaki
  </span>;
}

function LiquidityBadge({ liq, compact = false }: { liq: EntryLiquidity; compact?: boolean }) {
  const label = (text: string, color: string, title: string) => (
    <span title={title} style={{
      color, border: `1px solid ${color}`, borderRadius: 3, padding: '0 4px',
      fontSize: compact ? 9.5 : 10, letterSpacing: 0.3, whiteSpace: 'nowrap',
    }}>{text}</span>
  );
  if (!liq) return label('TAKER', C.dim, 'Leg dibuka sebelum mode maker — saat itu kode hanya bisa memasang MARKET, jadi pasti taker');
  const total = liq.makerQty + liq.takerQty;
  if (total <= 0) return label('TAKER', C.dim, liq.reason);
  const makerPct = (liq.makerQty / total) * 100;
  if (makerPct >= 99.9) return label('MAKER', C.good, `Terisi penuh sebagai maker (GTX post-only). ${liq.reason}`);
  if (makerPct <= 0.1) return label('TAKER', C.accent, `Post-only tidak terisi, disilang ke MARKET. ${liq.reason}`);
  return label(`${makerPct.toFixed(0)}% MAKER`, C.measure, `Sebagian maker, sisanya disilang ke MARKET. ${liq.reason}`);
}

/** Basket-level roll-up: what share of the ENTRY notional was added rather than taken. */
function BasketLiquiditySummary({ legs }: { legs: ReadonlyArray<{ qty: number; entryPrice: number; entryLiquidity?: EntryLiquidity }> }) {
  let makerNotional = 0;
  let total = 0;
  for (const l of legs) {
    const px = l.entryPrice;
    if (!(px > 0) || !(l.qty > 0)) continue;
    total += px * l.qty;
    const liq = l.entryLiquidity;
    if (liq && liq.makerQty + liq.takerQty > 0) makerNotional += px * liq.makerQty;
  }
  if (total <= 0) return null;
  const pctMaker = (makerNotional / total) * 100;
  // Commission is the only part that is certain: 2.00 bps maker vs 4.00 taker, measured on this
  // account. The spread saved and the adverse selection paid are NOT included and never claimed.
  const entryBps = 2 * (pctMaker / 100) + 4 * (1 - pctMaker / 100);
  return <span style={{ color: C.dim, fontSize: 10.5 }}>
    entry <strong style={{ color: pctMaker >= 99.9 ? C.good : pctMaker > 0 ? C.measure : C.dim }}>{pctMaker.toFixed(0)}% maker</strong>
    {' · komisi masuk ~'}{entryBps.toFixed(2)} bps{' · exit MARKET = taker 4,00 bps'}
  </span>;
}

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

/* ── Pool panel ───────────────────────────────────────────────────────────────────────────────
   This used to read "POOL LONG OPERATOR" / "POOL SHORT OPERATOR", which stopped being true the
   moment the list became criteria-derived, and it named exclusions without ever saying why. A pool
   view that cannot answer "why is this symbol in, and that one out" is how a hand-picked list
   survives for months without anyone being able to question it.

   Every number below is MEASURED and comes from /api/live/cross-sectional-pool, not typed in here.
   The one list that genuinely has no criterion — the short blocklist — is labelled as exactly that
   rather than sharing a heading with the criteria-derived pools. */
type PoolReport = {
  measured: boolean;
  leg: { baseUsd: number; multiplier: number; effectiveUsd: number | null; oneLotCeilingUsd: number | null };
  thresholds: { minLiquidityUsdPerHour: number; maxLotFractionOfLeg: number; minListedDays: number; maxFundingCarryBps: number; maxCorrelation: number };
  counts: { universe: number; passesEvaluated: number; poolLong: number; poolShort: number; shortBlocked: number; shortEligible: number };
  rows: Array<{ symbol: string; passesEvaluated: boolean; inPool: boolean; shortBlocked: boolean; agreesWithCriteria: boolean; failures: Array<{ code: string; detail: string }> }>;
  mismatch: string[];
  /** The actionable verdict, hysteresis-aware. `mismatch` above is the RAW threshold comparison —
   *  true per symbol, but not a reason to change anything on its own. */
  reconciliation?: { changed: boolean; adds: string[]; drops: string[]; held: Array<{ symbol: string; action: string; reason: string }>; unmeasured: boolean };
  blockedInPool: string[];
  btc: { oneLotUsd: number | null; legNeededUsd: number | null };
  unevaluatedCriteria: Array<{ code: string; why: string }>;
};

const usd = (v: number | null | undefined, dp = 2) => (v == null ? '—' : `$${v.toFixed(dp)}`);

function Banner({ tone, children }: { tone: 'warn' | 'ok'; children: ReactNode }) {
  return <div style={{
    color: tone === 'warn' ? C.accent : C.good, background: tone === 'warn' ? '#2a2110' : 'transparent',
    border: `1px solid ${tone === 'warn' ? C.accent : 'transparent'}`, borderRadius: 4,
    padding: tone === 'warn' ? '6px 9px' : '2px 0', fontSize: 11.5, lineHeight: 1.5,
  }}>{children}</div>;
}

function PoolPanel({ apiPrefix, executionLong, executionShort, executionShortBlocked, executionExcluded }: {
  apiPrefix: string;
  executionLong: string[]; executionShort: string[]; executionShortBlocked: string[]; executionExcluded: string[];
}) {
  const [pool, setPool] = useState<PoolReport | null>(null);
  const [poolError, setPoolError] = useState(false);

  useEffect(() => {
    let alive = true;
    async function loadPool() {
      try {
        const response = await fetch(`${apiPrefix}/live/cross-sectional-pool`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = await response.json() as PoolReport;
        if (alive) { setPool(parsed); setPoolError(false); }
      } catch {
        if (alive) setPoolError(true);
      }
    }
    void loadPool();
    // The report is cached 15 min on the API; polling faster only burns requests for the same bytes.
    const timer = window.setInterval(() => void loadPool(), 5 * 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [apiPrefix]);

  const activeShort = executionShort.filter((symbol) => !executionShortBlocked.includes(symbol));
  const poolsIdentical = executionLong.length === executionShort.length
    && executionLong.every((symbol) => executionShort.includes(symbol));
  // The executor reads its allowlists from env; so does the criteria report. If the two disagree the
  // panel is describing a pool the executor is not using, which must never pass silently.
  const countDrift = pool && (pool.counts.poolLong !== executionLong.length || pool.counts.poolShort !== executionShort.length);

  const label = (text: string, n: number, color: string) => <strong style={{ color }}>{text} ({n})</strong>;

  return <div style={{ display: 'grid', gap: 8, marginTop: 2, padding: '8px 10px', border: `1px solid ${C.border}`, background: C.sub }}>
    <div>
      <strong style={{ color: C.text }}>Pool FILTERED yang dipakai sekarang</strong>
      <div style={{ color: C.dim, fontSize: 11.5, marginTop: 2, lineHeight: 1.5 }}>
        Daftar long dan short <b style={{ color: C.text }}>diturunkan dari kriteria</b>, bukan dipilih tangan.
        {pool?.measured && <> Leg efektif <b style={{ color: C.text }}>{usd(pool.leg.effectiveUsd)}</b> ({usd(pool.leg.baseUsd, 0)} × {pool.leg.multiplier}) ·
        C1 likuiditas ≥ ${Math.round(pool.thresholds.minLiquidityUsdPerHour / 1000)}k/jam ·
        C2 satu lot ≤ {usd(pool.leg.oneLotCeilingUsd)} ({(pool.thresholds.maxLotFractionOfLeg * 100).toFixed(0)}% leg)</>}
      </div>
    </div>

    {poolError && <Banner tone="warn">Kriteria tidak bisa dibaca (endpoint pool gagal). Daftar di bawah tetap yang dipakai executor, tapi belum diuji terhadap kriteria apa pun.</Banner>}
    {pool && !pool.measured && <Banner tone="warn">⚠ Kriteria tidak bisa diukur sekarang — pembacaan exchange gagal. Ini <b>bukan</b> berarti simbol-simbolnya gagal kriteria; belum ada yang diuji.</Banner>}
    {/* Reads the RECONCILIATION, not the raw mismatch. This panel used to compute its own verdict
        from `mismatch` and cried wolf over WIF — $199,118 against a $200,000 floor, 0.44% under —
        while the API page's hysteresis said nothing needed changing. Two surfaces, two answers,
        same symbol. The decision now lives in one place and both read it. */}
    {pool?.measured && pool.reconciliation?.changed && <Banner tone="warn">
      ⚠ Pool perlu diubah: {[
        ...pool.reconciliation.adds.map((s) => `tambah ${s.replace('USDT', '')}`),
        ...pool.reconciliation.drops.map((s) => `keluarkan ${s.replace('USDT', '')}`),
      ].join(' · ')}. Penerapan manual — allowlist dibaca sekali saat proses start.
    </Banner>}
    {pool?.measured && pool.reconciliation && !pool.reconciliation.changed && pool.reconciliation.held.length > 0 && <Banner tone="ok">
      ● Tidak ada yang perlu diubah. {pool.reconciliation.held.map((d) => d.symbol.replace('USDT', '')).join(', ')} di bawah ambang mentah tetapi <strong style={{ color: C.text }}>di dalam pita histeresis ±10%</strong>, jadi keanggotaannya sengaja dipertahankan — tanpa pita, simbol di garis batas keluar-masuk tiap beberapa jam dan menulis ulang pool yang dibandingkan overlap guard.
    </Banner>}
    {pool?.measured && pool.reconciliation && !pool.reconciliation.changed && pool.reconciliation.held.length === 0 && <Banner tone="ok">✓ Ke-{pool.counts.poolLong} simbol pool sama persis dengan hasil kriteria C1 &amp; C2.</Banner>}
    {countDrift && <Banner tone="warn">⚠ Kriteria menghitung {pool.counts.poolLong} long / {pool.counts.poolShort} short, executor memakai {executionLong.length} / {executionShort.length}. Panel ini dan executor tidak membaca daftar yang sama.</Banner>}

    <div>{label('POOL LONG — hasil kriteria C1 & C2', executionLong.length, C.good)}<InlineSymbolList symbols={executionLong} color={C.good} /></div>
    <div>
      {label('POOL SHORT — hasil kriteria C1 & C2', executionShort.length, C.good)}
      {poolsIdentical
        ? <div style={{ color: C.dim, paddingLeft: 12, marginTop: 3, fontSize: 11.5 }}>Sama persis dengan pool long — satu-satunya beda sisi short adalah blocklist di bawah.</div>
        : <InlineSymbolList symbols={executionShort} color={C.good} />}
    </div>

    <div>
      {label('BLOCKED SHORT — daftar tangan, TANPA kriteria', executionShortBlocked.length, C.bad)}
      <InlineSymbolList symbols={executionShortBlocked} color={C.bad} />
      <div style={{ color: C.dim, paddingLeft: 12, marginTop: 3, fontSize: 11.5, lineHeight: 1.5 }}>
        Satu-satunya daftar yang masih dipilih manual. Tidak ada alasan tercatat kenapa simbol ini tidak boleh di-short,
        dan tidak ada aturan untuk menambah atau mengeluarkan anggotanya. Diukur 2026-08-16 pada pool 20 simbol,
        biayanya <b style={{ color: C.text }}>−0,8 bps median</b> — jadi pertanyaannya konsistensi, bukan biaya.
        {!!pool?.blockedInPool.length && <> Saat ini {pool.blockedInPool.length} di antaranya ada di pool aktif, jadi hanya bisa dipakai di sisi long.</>}
      </div>
    </div>

    <div>{label('SHORT ELIGIBLE SEKARANG', activeShort.length, C.measure)}<InlineSymbolList symbols={activeShort} color={C.measure} /></div>

    {!!executionExcluded.length && <div>
      {label('DIKELUARKAN DARI EXECUTOR', executionExcluded.length, C.accent)}
      <InlineSymbolList symbols={executionExcluded} color={C.accent} />
    </div>}

    {pool?.measured && <div style={{ color: C.dim, fontSize: 11.5, lineHeight: 1.5, borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
      {pool.btc.oneLotUsd !== null && <>
        <b style={{ color: C.text }}>BTC di luar pool secara permanen pada leg ini</b>, bukan &ldquo;sementara&rdquo;: satu lot minimumnya {usd(pool.btc.oneLotUsd)} vs plafon {usd(pool.leg.oneLotCeilingUsd)}.
        Baru bisa masuk kalau leg dinaikkan ke sekitar {usd(pool.btc.legNeededUsd, 0)} — itu keputusan ukuran posisi, bukan sesuatu yang hilang sendiri.<br />
      </>}
      <b style={{ color: C.text }}>C3 umur listing, C4 carry funding, C5 korelasi tidak diukur</b> di panel ini ({pool.unevaluatedCriteria.map((c) => c.code.split('_')[0]).join(', ')}),
      jadi ketiganya tidak ikut menentukan status di atas — dinyatakan, bukan disembunyikan. Pada universe {pool.counts.universe} simbol saat ini hanya C1 dan C2 yang menyaring.
      {' '}<a href={`${apiPrefix}/live/cross-sectional-pool/view`} target="_blank" rel="noreferrer" style={{ color: C.measure }}>Rincian per simbol →</a>
    </div>}
    {/* 2026-08-17: both recorders installed today answer questions that were previously
        unanswerable because the data was never created — the basket the gate refuses was written
        nowhere, and OI/depth have no usable history. Linked, not inlined: both are still
        ACCUMULATING and putting them in a results panel would invite reading them as findings. */}
    <div style={{ marginTop: 10, paddingTop: 9, borderTop: `1px solid ${C.border}`, fontSize: 11.5, color: C.dim }}>
      Pencatatan baru (masih mengumpul, belum bisa disimpulkan): basket yang <b style={{ color: C.text }}>ditolak gerbang</b> dan
      {' '}<b style={{ color: C.text }}>open interest + kedalaman orderbook</b>.
      {' '}<a href={`${apiPrefix}/live/instrumentation/view`} target="_blank" rel="noreferrer" style={{ color: C.measure }}>Lihat pencatatan →</a>
    </div>
  </div>;
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
  const long = basket.legs.filter((leg) => leg.side === 'LONG').map((leg) => leg.symbol);
  const short = basket.legs.filter((leg) => leg.side === 'SHORT').map((leg) => leg.symbol);
  const extrema = basket.unrealizedExtrema;
  return <details style={{ border: `1px solid ${C.border}`, borderRadius: 6, marginTop: 10, overflow: 'hidden' }}>
    <summary style={{ padding: '9px 12px', background: C.sub, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline', cursor: 'pointer' }}>
      <strong style={{ color: C.text }}>{basket.basketId}</strong>
      <span style={{ color: C.dim }}>{lane} · {basket.variant} · {basket.signal}</span>
      <span style={{ color: tone(basket.netPnlUsd), fontWeight: 700 }}>net {money(basket.netPnlUsd)}</span>
      <span style={{ color: C.dim }}>close {formatDate(basket.closedAt)}</span>
      <span style={{ color: C.accent }}>buka detail</span>
    </summary>
    <div style={{ padding: '8px 12px', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 12, borderBottom: `1px solid ${C.border}` }}>
      <span style={{ color: C.dim }}>open {formatDate(basket.openedAt)} · close {formatDate(basket.closedAt)}</span>
      <span style={{ color: basket.allPricesConfirmed ? C.good : C.accent }}>{basket.allPricesConfirmed ? 'fills confirmed' : 'unconfirmed fill price'}</span>
    </div>
    <div style={{ padding: '8px 12px', display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, borderBottom: `1px solid ${C.border}` }}>
      <span style={{ color: C.good }}>Long: {long.join(', ')}</span>
      <span style={{ color: C.bad }}>Short: {short.join(', ')}</span>
      <span style={{ color: C.dim }}>hold {basket.holdHours.toFixed(2)}h · reason {basket.closeReason ?? '—'}</span>
      <CapitalNote legs={basket.legs} />
      <BasketLiquiditySummary legs={basket.legs} />
    </div>
    <ExtremaStrip capitalUsd={basketNotionalUsd(basket.legs)} rows={[
      ['Gross realized', basket.grossPnlUsd],
      ['Setelah biaya', basket.netPnlUsd],
      ['ATH gross', extrema?.grossHighUsd],
      ['ATH stlh biaya', extrema?.afterEstimatedCloseCostHighUsd],
      ['ATL gross', extrema?.grossLowUsd],
      ['ATL stlh biaya', extrema?.afterEstimatedCloseCostLowUsd],
    ]} />
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr style={{ color: C.dim, textAlign: 'left' }}>
          <th style={{ padding: 7 }}>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Close</th><th>Return</th><th>Gross realized</th><th>Setelah biaya</th><th>ATH gross</th><th>ATH setelah biaya</th><th>ATL gross</th><th>ATL setelah biaya</th><th>Fee allocated</th>
        </tr></thead>
        <tbody>{basket.legs.map((leg) => {
          const ret = leg.entryPrice > 0 ? (leg.side === 'LONG' ? leg.exitPrice - leg.entryPrice : leg.entryPrice - leg.exitPrice) / leg.entryPrice : null;
          const path = leg.unrealizedExtrema;
          return <tr key={`${basket.basketId}-${leg.symbol}`} style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={{ padding: 7, color: C.text, fontWeight: 600 }}>
                {leg.symbol}{' '}<LiquidityBadge liq={leg.entryLiquidity} compact />
              </td>
              <td style={{ color: leg.side === 'LONG' ? C.good : C.bad }}>{leg.side}</td>
              <td>{leg.qty}</td><td>{leg.entryPrice}</td><td>{leg.exitPrice}</td>
              <td style={{ color: tone(ret) }}>{pct(ret)}</td>
              <td style={{ color: tone(leg.grossPnlUsd) }}>{money(leg.grossPnlUsd)}</td>
              <td style={{ color: tone(leg.netPnlUsd) }}>{money(leg.netPnlUsd)} {!leg.priceConfirmed && <span title="Entry or close fill price was not exchange-confirmed">⚠</span>}</td>
              <td style={{ color: tone(path?.grossHighUsd) }}>{money(path?.grossHighUsd)}</td>
              <td style={{ color: tone(path?.afterEstimatedCloseCostHighUsd) }}>{money(path?.afterEstimatedCloseCostHighUsd)}</td>
              <td style={{ color: tone(path?.grossLowUsd) }}>{money(path?.grossLowUsd)}</td>
              <td style={{ color: tone(path?.afterEstimatedCloseCostLowUsd) }}>{money(path?.afterEstimatedCloseCostLowUsd)}</td>
              <td style={{ color: C.accent }}>{money(leg.feeAllocatedUsd)}</td>
            </tr>
        })}</tbody>
      </table>
    </div>
    <div style={{ padding: '7px 12px', color: C.dim, fontSize: 11 }}>Fee/cost: {money(basket.feeEstimateUsd)} ({basket.feeSource ?? 'unknown'}) · long return {pct(longReturn)} · short return {pct(shortReturn)}</div>
  </details>;
}

function OpenBasketUnrealizedBlock({ basket }: { basket: OpenBasketUnrealized }) {
  const long = basket.legs.filter((leg) => leg.side === 'LONG').map((leg) => leg.symbol);
  const short = basket.legs.filter((leg) => leg.side === 'SHORT').map((leg) => leg.symbol);
  const extrema = basket.unrealizedExtrema;
  const summary = [
    ['Gross sekarang', basket.grossUnrealizedUsd],
    ['Setelah biaya', basket.unrealizedAfterEstimatedCloseCostUsd],
    ['ATH gross', extrema?.grossHighUsd],
    ['ATH stlh biaya', extrema?.afterEstimatedCloseCostHighUsd],
    ['ATL gross', extrema?.grossLowUsd],
    ['ATL stlh biaya', extrema?.afterEstimatedCloseCostLowUsd],
  ] as const;
  return <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, marginTop: 10, overflow: 'hidden' }}>
    <div style={{ padding: '9px 12px', background: C.sub, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
      <strong style={{ color: C.text }}>{basket.basketId}</strong>
      <span style={{ color: C.dim }}>{basket.variant} · {basket.signal}</span>
      <span style={{ color: C.dim }}>open {formatDate(basket.openedAt)}</span>
      <CapitalNote legs={basket.legs} />
      <BasketLiquiditySummary legs={basket.legs} />
    </div>
    <div style={{ padding: '8px 12px 4px', display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
      <span style={{ color: C.good }}>Long: {long.join(', ')}</span>
      <span style={{ color: C.bad }}>Short: {short.join(', ')}</span>
    </div>
    <ExtremaStrip capitalUsd={basketNotionalUsd(basket.legs)} rows={summary} />
    {!extrema && <small style={{ display: 'block', padding: '6px 10px', color: C.dim }}>ATH/ATL mulai direkam sejak report ini aktif.</small>}
    <div style={{ overflowX: 'auto' }}>
      <table className="cross-open-basket-table" style={{ width: '100%', minWidth: 1180, borderCollapse: 'collapse', fontSize: 11 }}>
        <thead><tr style={{ color: C.dim, textAlign: 'left' }}>
          <th style={{ padding: 7 }}>Symbol</th><th>Side</th><th>Entry</th><th>Mark</th><th>Gross sekarang</th><th>Setelah biaya</th><th>ATH gross</th><th>ATH setelah biaya</th><th>ATL gross</th><th>ATL setelah biaya</th>
        </tr></thead>
        <tbody>{basket.legs.map((leg) => {
          const path = leg.unrealizedExtrema;
          return <tr key={`${basket.basketId}-${leg.symbol}-${leg.side}`} style={{ borderTop: `1px solid ${C.border}` }}>
            <td style={{ padding: 7, color: C.text, fontWeight: 600 }}>
              {leg.symbol}{' '}<LiquidityBadge liq={leg.entryLiquidity} compact />
            </td>
            <td style={{ color: leg.side === 'LONG' ? C.good : C.bad }}>{leg.side}</td>
            <td>{price(leg.entryPrice)}</td>
            <td>{price(leg.markPrice)}</td>
            <td style={{ color: tone(leg.grossUnrealizedUsd) }}>{money(leg.grossUnrealizedUsd)}</td>
            <td style={{ color: tone(leg.afterEstimatedCloseCostUsd) }}>{money(leg.afterEstimatedCloseCostUsd)}</td>
            <td style={{ color: tone(path?.grossHighUsd) }}>{money(path?.grossHighUsd)}</td>
            <td style={{ color: tone(path?.afterEstimatedCloseCostHighUsd) }}>{money(path?.afterEstimatedCloseCostHighUsd)}</td>
            <td style={{ color: tone(path?.grossLowUsd) }}>{money(path?.grossLowUsd)}</td>
            <td style={{ color: tone(path?.afterEstimatedCloseCostLowUsd) }}>{money(path?.afterEstimatedCloseCostLowUsd)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </div>;
}

function directionalModeLabel(mode: DirectionalRegimeResponse['mode'], directionalPickCount = 3): string {
  if (mode === 'BEAR_SHORT_3') return `BEARISH KUAT → SHORT ${directionalPickCount}`;
  if (mode === 'BULL_LONG_3') return `BULLISH KUAT → LONG ${directionalPickCount}`;
  if (mode === 'BALANCED_3X3') return 'SEIMBANG → BASKET 3 LONG × 3 SHORT';
  return 'NO TRADE';
}

function directionalModeColor(mode: DirectionalRegimeResponse['mode']): string {
  if (mode === 'BEAR_SHORT_3') return C.bad;
  if (mode === 'BULL_LONG_3') return C.good;
  return mode === 'BALANCED_3X3' ? C.accent : C.measure;
}

/** Keputusan executor yang aktual, terpisah dari histori basket FILTERED di bawahnya. */
/**
 * The ACTUAL breadth numbers.
 *
 * The tile beside this used to be labelled "Scanner breadth" while displaying `marketRegime` — a
 * discrete PATTERN name ("Mixed rotation"), not breadth at all. Sitting next to "Canonical regime:
 * BEARISH" it read like the two disagreed, when they were answering different questions and the one
 * number that reconciles them was not on the page: breadth itself, which is what the canonical
 * engine reads. At 21% advancers, BEARISH is exactly what breadth says.
 *
 * Fetched separately rather than threaded through the directional-regime route, so no API shape
 * changes and a failure here can never take the regime panel down with it.
 */
function BreadthRow({ apiPrefix }: { apiPrefix: string }) {
  const [b, setB] = useState<RegimeBreadth | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch(`${apiPrefix}/shadow/regime-engine-report`, { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json() as { latest?: { breadth?: RegimeBreadth } };
        if (alive) { setB(j.latest?.breadth ?? null); setFailed(false); }
      } catch { if (alive) setFailed(true); }
    }
    void load();
    const t = window.setInterval(() => void load(), 30_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [apiPrefix]);

  const pct = (v: number | null | undefined, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
  const tint = (v: number | null | undefined) => (v == null ? C.dim : v >= 0.5 ? C.good : v <= 0.35 ? C.bad : C.measure);

  if (failed) return <div style={{ padding: '7px 12px', color: C.bad, fontSize: 11, borderBottom: `1px solid ${C.border}` }}>Breadth tidak terbaca.</div>;
  if (!b) return <div style={{ padding: '7px 12px', color: C.dim, fontSize: 11, borderBottom: `1px solid ${C.border}` }}>Memuat breadth…</div>;
  if (b.unavailableReason) return <div style={{ padding: '7px 12px', color: C.accent, fontSize: 11, borderBottom: `1px solid ${C.border}` }}>Breadth tidak tersedia: {b.unavailableReason}</div>;

  return <div style={{ padding: '7px 12px', color: C.dim, fontSize: 11.5, lineHeight: 1.6, borderBottom: `1px solid ${C.border}` }}>
    <strong style={{ color: C.text }}>Breadth</strong>{' — angka yang dibaca canonical: '}
    <strong style={{ color: tint(b.advancersPct) }}>{pct(b.advancersPct)}</strong> advancers
    {b.altAdvancersPct != null && <> · <strong style={{ color: tint(b.altAdvancersPct) }}>{pct(b.altAdvancersPct)}</strong> advancers alt</>}
    {' · '}<strong style={{ color: tint(b.percentAboveEma20) }}>{pct(b.percentAboveEma20)}</strong> di atas EMA20
    {' · BTC 24j '}<strong style={{ color: tone(b.btcReturn24h) }}>{b.btcReturn24h == null ? '—' : `${(b.btcReturn24h * 100).toFixed(2)}%`}</strong>
  </div>;
}

function DirectionalRegimeStatus({ apiPrefix }: { apiPrefix: string }) {
  // sama seperti CrossSectionalReportCard: apiPrefix sudah membedakan halaman, jangan hardcode 'testnet'.
  const isLiveDR = apiPrefix.startsWith('/live');
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
  return <section className="testnet-panel testnet-wide-panel cross-sectional-report" id="cross-sectional-directional-decision">
    <header><div><span>Keputusan arah cross-sectional</span><strong>{data ? directionalModeLabel(data.mode, picks.length) : 'Memuat keputusan…'}</strong></div><span className="tone-measure">khusus {isLiveDR ? 'mainnet' : 'testnet'} · executor source of truth</span></header>
    {error && <div style={{ padding: '9px 12px', color: C.bad, borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
      <strong>{isStale ? 'DATA TERAKHIR — BUKAN DATA LIVE. ' : 'DATA TIDAK TERSEDIA. '}</strong>
      Fetch keputusan executor gagal; jangan gunakan card ini untuk menilai arah atau membuka entry.{lastGoodAt ? ` Terakhir berhasil dimuat ${ago(lastGoodAt)} lalu.` : ''}
    </div>}
    {data && <>
      <div style={{ padding: '10px 12px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', borderBottom: `1px solid ${C.border}` }}>
        <strong style={{ color: directionalModeColor(data.mode), fontSize: 16 }}>{directionalModeLabel(data.mode, picks.length)}</strong>
        <span style={{ color: C.dim }}>scan selesai {data.scanFinishedAt ? formatDate(data.scanFinishedAt) : 'belum ada'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(180px, 1fr))', borderBottom: `1px solid ${C.border}` }}>
        {/* Was labelled "Scanner breadth" and showed a PATTERN name, which is not breadth. The
            dashboard's own tooltip calls these patterns "BUKAN penilaian arah" — so the label now
            says what the value is, and the real breadth appears in BreadthRow below. */}
        <Stat label="Pola scanner (bukan arah)" value={data.marketRegime ?? '—'} color={C.measure} />
        <Stat label="Canonical regime" value={data.canonicalRegimeFamily} color={data.canonicalRegimeFamily === 'BEARISH' ? C.bad : data.canonicalRegimeFamily === 'BULLISH' ? C.good : C.measure} />
        <Stat label="Canonical gate" value={data.canonicalAllowed ? 'VALID' : data.canonicalAllowed === false ? 'BLOCKED' : 'MENUNGGU'} color={data.canonicalAllowed ? C.good : data.canonicalAllowed === false ? C.bad : C.measure} />
      </div>
      <BreadthRow apiPrefix={apiPrefix} />
      <div style={{ padding: '10px 12px', fontSize: 12, lineHeight: 1.55 }}>
        <strong style={{ color: C.text }}>Mengapa:</strong> <span style={{ color: C.dim }}>{data.reason}</span>
        {data.canonicalReason && <div style={{ color: C.dim, marginTop: 4 }}>Canonical detail: {data.canonicalReason}</div>}
      </div>
      {picks.length > 0 && <div style={{ padding: '0 12px 12px', overflowX: 'auto' }}>
        <div style={{ color: C.dim, fontSize: 12, margin: '4px 0 6px' }}>{picks.length} simbol yang akan dieksekusi bila mode ini tetap valid</div>
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

/**
 * Kapan basket baru bisa dibuka.
 *
 * DELIBERATELY NOT A COUNTDOWN TO A NEW BASKET. Only ONE part of this is on a clock: the current
 * signal's expiry (signalAgeMs vs signalMaxAgeMs). Whether the next signal actually OPENS anything
 * is decided by the overlap guard against the basket that came before it, which depends on how the
 * ranking moved and cannot be predicted from a timestamp — measured, consecutive baskets share
 * 4.94 of 6 symbols and the guard skips ~55% of attempts, so the lane averages one new basket every
 * 2-3 days. Printing "next basket at HH:MM" would be a number the system cannot honour.
 *
 * So it shows the three things that ARE knowable: when the signal goes stale, what the last attempt
 * actually did and why it stopped, and whether admission would even allow an open right now.
 */
function NextSignalNote({ apiPrefix }: { apiPrefix: string }) {
  const [st, setSt] = useState<XSecExecStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch(`${apiPrefix}/live/cross-sectional-executor`, { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json() as XSecExecStatus;
        if (alive) { setSt(j); setFailed(false); }
      } catch { if (alive) setFailed(true); }
    }
    void load();
    const t = window.setInterval(() => void load(), 15_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [apiPrefix]);

  if (failed) return <div style={{ padding: '8px 12px', color: C.bad, fontSize: 11 }}>Status executor tidak terbaca — jadwal sinyal tidak diketahui.</div>;
  if (!st) return <div style={{ padding: '8px 12px', color: C.dim, fontSize: 11 }}>Memuat jadwal sinyal…</div>;

  const remainMs = st.signalMaxAgeMs != null && st.signalAgeMs != null ? st.signalMaxAgeMs - st.signalAgeMs : null;
  const expiresAt = remainMs != null ? new Date(Date.now() + remainMs) : null;
  const last = st.entryAttemptAudit?.latest ?? null;
  const admission = st.entryAdmission ?? null;

  return <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, background: C.sub, color: C.dim, fontSize: 11, lineHeight: 1.6 }}>
    <div>
      <strong style={{ color: C.text }}>Sinyal berikutnya</strong>
      {' · '}
      {st.signalStale
        ? <span style={{ color: C.accent }}>sinyal sekarang SUDAH kedaluwarsa — menunggu siklus berikutnya</span>
        : expiresAt
          ? <>sinyal ini berlaku {duration(remainMs)} lagi, sampai <strong style={{ color: C.text }}>{expiresAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</strong></>
          : <span>umur sinyal tidak dilaporkan</span>}
      {admission ? <>{' · admission '}<span style={{ color: admission.allowed ? C.good : C.bad }}>{admission.tier ?? (admission.allowed ? 'OK' : 'BLOK')}</span></> : null}
      {st.openHalted ? <> · <span style={{ color: C.bad }}>open dihentikan: {st.openHalted}</span></> : null}
    </div>
    {last && <div>
      {/* "berhenti di" was wrong for a PASSING attempt: BASKET_RESERVED/ADMITTED means it went all
          the way through and a basket was created, but the wording read as a failure and was
          reported as one. The verb now follows the outcome. */}
      Percobaan terakhir <strong style={{ color: C.text }}>{formatDate(last.at)}</strong>{' '}
      {last.outcome === 'ADMITTED' || last.outcome === 'OPENED' ? (
        <>lolos sampai <strong style={{ color: C.text }}>{last.stage}</strong>{' → '}
          <span style={{ color: C.good }}>{last.outcome}</span> — basket dibuat{last.reason ? `: ${last.reason}` : ''}</>
      ) : (
        <>berhenti di <strong style={{ color: C.text }}>{last.stage}</strong>{' → '}
          <span style={{ color: C.accent }}>{last.outcome}</span>{last.reason ? `: ${last.reason}` : ''}</>
      )}
    </div>}
    {admission?.reason && <div style={{ opacity: 0.85 }}>{admission.reason}</div>}
    <div style={{ opacity: 0.7 }}>
      Hanya kedaluwarsa sinyal yang bisa dijadwalkan. Apakah sinyal berikutnya benar-benar MEMBUKA basket ditentukan
      overlap guard terhadap basket sebelumnya — terukur, basket berurutan berbagi 4,94 dari 6 simbol dan guard menolak
      ~55% percobaan, jadi rata-ratanya <strong style={{ color: C.text }}>1 basket baru per 2-3 hari</strong>. Jam pasti tidak bisa dijanjikan.
    </div>
  </div>;
}

function OpenCrossBasketReport({ apiPrefix }: { apiPrefix: string }) {
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
  const openBaskets = data?.openBaskets ?? [];
  return <section className="testnet-panel testnet-wide-panel cross-sectional-report" id="cross-sectional-open-report">
    <header><div><span>Open cross-basket · unrealized P&amp;L path</span><strong>{openBaskets.length} open basket{openBaskets.length === 1 ? '' : 's'}</strong></div><span className="tone-measure">grouped per basket · live marks</span></header>
    <NextSignalNote apiPrefix={apiPrefix} />
    {error ? <div style={{ padding: 12, color: C.bad }}>Open-basket report fetch failed.</div> : data?.crossSectionalPnl ? <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(150px, 1fr))', borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <Stat label="Gross unrealized" value={money(data.crossSectionalPnl.grossUnrealizedUsd)} color={tone(data.crossSectionalPnl.grossUnrealizedUsd)} />
        <Stat label="Unrealized setelah slippage" value={money(data.crossSectionalPnl.unrealizedAfterSlippageUsd)} color={tone(data.crossSectionalPnl.unrealizedAfterSlippageUsd)} />
      </div>
      <div style={{ padding: '7px 12px', color: C.dim, fontSize: 11 }}>{data.crossSectionalPnl.openLegCount} leg aktif · {data.crossSectionalPnl.slippageCaveat}</div>
      {openBaskets.length ? <div style={{ padding: '0 12px 12px' }}>
        {openBaskets.map((basket) => <OpenBasketUnrealizedBlock key={basket.basketId} basket={basket} />)}
      </div> : <div style={{ padding: 12, color: C.dim }}>Tidak ada basket aktif.</div>}
    </> : <div style={{ padding: 12, color: C.dim }}>Loading open basket…</div>}
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
  const auditLanes = (data?.auditHistory?.lanes ?? []).filter((lane) => lane.laneId.startsWith('CROSS_SECTIONAL_'));
  const auditBaskets = auditLanes
    .flatMap((lane) => lane.baskets.map((basket) => ({ lane: lane.lane, basket })))
    .sort((a, b) => new Date(b.basket.closedAt).getTime() - new Date(a.basket.closedAt).getTime());
  // 2026-08-16: ONE chronological history. The audit rows used to sit in a collapsed section below
  // the cohort, so the same lane's baskets appeared in two places ordered by a cutoff rather than
  // by time, and the operator had to open a details pane to see half their own fills. Provenance is
  // not lost — every pre-cutoff row still carries its `audit` marker inline, and the totals below
  // still separate what the cohort counts from what the exchange actually did.
  const allBaskets = [
    ...baskets.map((b) => ({ ...b, audit: false })),
    ...auditBaskets.map((b) => ({ ...b, audit: true })),
  ].sort((a, b) => new Date(b.basket.closedAt).getTime() - new Date(a.basket.closedAt).getTime());
  const cohortNet = data?.crossSectionalPnl?.netRealizedProfitUsd;
  const auditNet = data?.auditHistory?.totalNetPnlUsd;
  const allTimeNet = cohortNet != null || auditNet != null ? (cohortNet ?? 0) + (auditNet ?? 0) : undefined;
  return <section className="testnet-panel testnet-wide-panel cross-sectional-report" id="cross-sectional-closed-report">
    <header><div><span>Closed cross-basket realized report</span><strong>{allBaskets.length} basket{allBaskets.length === 1 ? '' : 's'}{auditBaskets.length ? ` · ${auditBaskets.length} pra-cohort` : ''}</strong></div><span className="tone-measure">grouped per basket · real fills</span></header>
    <div style={{ padding: '8px 12px', color: C.dim, fontSize: 11, lineHeight: 1.5 }}>
      Scope: {data?.reportStartAt ? `baskets opened from ${formatDate(data.reportStartAt)} onward` : 'all stored history'}. Gross profit, fee/cost, long/short return, realized net per symbol, and open/close timestamps. Fee/cost comes from the basket ledger; separate slippage is not currently stored independently. Per-symbol fee is allocated by notional touched.
    </div>
    {data?.crossSectionalPnl && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(150px, 1fr))', borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
      <Stat label="Net cohort aktif" value={money(cohortNet)} color={tone(cohortNet)} />
      <Stat label="Net pra-cohort (audit)" value={money(auditNet)} color={tone(auditNet)} />
      <Stat label="Net semua histori" value={money(allTimeNet)} color={tone(allTimeNet)} />
    </div>}
    <div style={{ padding: '6px 12px', color: C.dim, fontSize: 11, lineHeight: 1.5 }}>
      Daftar di bawah satu urutan waktu, cohort dan pra-cohort digabung. Baris bertanda <span style={{ color: C.accent }}>audit</span> adalah
      fill exchange nyata dari sebelum batas cohort: tetap bisa diaudit, tapi <strong style={{ color: C.text }}>tidak</strong> masuk edge aktif,
      pembelajaran Four-Brain, atau P&amp;L hari ini — itulah kenapa ketiga angka di atas dipisah.
      {data?.auditHistory?.reason ? ` ${data.auditHistory.reason}` : ''}
    </div>
    {error ? <div style={{ padding: 12, color: C.bad }}>Closed-basket report fetch failed.</div> : <>
      {allBaskets.length ? <div style={{ padding: '0 12px 12px' }}>
        {allBaskets.map(({ lane, basket, audit }) => (
          <ClosedBasketBlock key={`${audit ? 'audit-' : ''}${basket.basketId}`} lane={audit ? `${lane} · audit` : lane} basket={basket} />
        ))}
      </div> : <div style={{ padding: 12, color: C.dim }}>{data?.reason ? 'Belum ada basket closed.' : 'Loading closed basket history…'}</div>}

    </>}
  </section>;
}

export default function CrossSectionalReportCard({ apiPrefix = '/testnet/api' }: { apiPrefix?: string }) {
  // 2026-08-18: apiPrefix IS the page discriminator ('/live/api' vs '/testnet/api'), so the card
  // can label itself correctly instead of hardcoding "testnet" on whichever page renders it.
  const isLive = apiPrefix.startsWith('/live');
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
  <section className="testnet-panel testnet-wide-panel cross-sectional-report" id="cross-sectional-definitions">
    <header><div><span>Istilah cross-basket</span><strong>Cara membaca report ini</strong></div><span className="tone-measure">khusus {isLive ? 'mainnet' : 'testnet'}</span></header>
    <div style={{ padding: '10px 12px', display: 'grid', gap: 8, color: C.dim, fontSize: 12, lineHeight: 1.5 }}>
      <div><strong style={{ color: C.text }}>RAW</strong> = universe sinyal dasar. Sistem merangking seluruh pool basket yang eligible tanpa aturan allow/block FILTERED per simbol yang sudah diukur. Ini adalah baseline pembanding, bukan otomatis pilihan eksekusi live.</div>
      <div><strong style={{ color: C.text }}>FILTERED</strong> = ide momentum cross-sectional yang sama setelah melewati filter likuiditas, selisih skor, serta allow/block operator. Executor market-neutral testnet saat ini memakai varian ini.</div>
      {config
        ? <PoolPanel
            apiPrefix={apiPrefix}
            executionLong={executionLong}
            executionShort={executionShort}
            executionShortBlocked={executionShortBlocked}
            executionExcluded={config.executionExcludedSymbols ?? []}
          />
        : <div style={{ display: 'grid', gap: 8, marginTop: 2, padding: '8px 10px', border: `1px solid ${C.border}`, background: C.sub }}>
            <strong style={{ color: C.text }}>Pool FILTERED yang dipakai sekarang</strong>
            <div>Memuat konfigurasi FILTERED…</div>
          </div>}
      <div><strong style={{ color: C.text }}>MOM36_FILTERED</strong> = sinyal FILTERED dengan momentum dari 36 candle 1 jam yang sudah selesai. Angka <strong style={{ color: C.accent }}>36</strong> adalah lookback, bukan durasi holding; horizon basket saat ini ditampilkan terpisah di sebelah judul report dan dikonfigurasi secara terpisah.</div>
    </div>
  </section>
  {/* 2026-08-18 (operator: "ga usah di live"): this card is the SHADOW measurement surface —
      report-only RAW/FILTERED observations, not executed baskets. On mainnet it reads all zeros
      and is labelled as a measurement, so it is testnet-only. The EXECUTED books stay on both
      pages: OpenCrossBasketReport / ClosedCrossBasketReport below. */}
  {!isLive && <section className="testnet-panel testnet-wide-panel cross-sectional-report" id="cross-sectional-report">
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
  </section>}
  <OpenCrossBasketReport apiPrefix={apiPrefix} />
  <ClosedCrossBasketReport apiPrefix={apiPrefix} />
  </>;
}
