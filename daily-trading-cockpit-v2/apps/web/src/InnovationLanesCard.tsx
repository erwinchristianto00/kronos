import { useEffect, useRef, useState } from 'react';
import { C, fmtR, toneR, ago, laneEdgeBadge, LaneMaturityTable, type LaneMaturityRow } from './LaneMaturityTable';

// Inovasi (shadow lanes) progress card (2026-07-22 operator ask) — /research only. Watches the
// original five measurements plus four lineage-preserving V2 siblings and one new L2 signal lane.
// Testnet (3102) is the proving ground, so each row
// prefers TESTNET's numbers via a browser-side fetch through the /testnet Caddy prefix (same
// cross-instance precedent as CortexReadinessCard), falling back to this instance's local endpoint.
// Polls 60s (all five stores only advance on the ~7min shadow cycle anyway). Per-endpoint
// independent failure: one dead endpoint marks its own row unreachable, the other rows keep
// updating. Every fetch checks res.ok BEFORE parsing (a proxy error page parsing as JSON is
// exactly the bug just fixed in ResearchDashboard's grab helper) and keeps the last good value on
// transient failure, with a seq-guard against a stale slow response overwriting a newer one (same
// pattern as loadCortexDecisionAlpha in TestnetExchangeDashboard).
//
// 2026-07-23 declutter: the original lanes used to each render as a full-width always-visible block
// (LaneRow). None of them has traded or proven anything yet (all pending edgeReady thresholds), so
// they're now one compact LaneMaturityTable — click a row to expand its rich detail. C / fmtR /
// toneR / ago / laneEdgeBadge are the shared helpers (same values this file used to duplicate
// locally) — see LaneMaturityTable.tsx.

/** One evidence tier's self-contained block (backend: exit-brain-shadow.ts ExitBrainTierBlock).
 *  MEASURED = path nyata yang benar-benar terekam. SIMULATED = rekonstruksi candle-walk dari paper
 *  order. Keduanya SELALU dirender terpisah dan TIDAK PERNAH dijumlahkan — sengaja tidak ada satu
 *  angka gabungan di sini, persis seperti disiplin Tier 1 / Tier 2 milik Entry Brain. */
export type ExitBrainTierBlock = {
  tier: 'MEASURED' | 'SIMULATED';
  note: string;
  processed: number;
  evaluated: number;
  insufficientPathData: number;
  coverageRatio: number | null;
  n: number;
  meanDeltaR: number | null;
  cumDeltaR: number;
  policyBetterShare: number | null;
  policyBetter: number;
  policyWorse: number;
  ties: number;
  banked: number;
};

export type ExitBrainReport = {
  coverage: {
    processed: number;
    evaluated: number;
    insufficientPathData: number;
    coverageRatio: number | null;
    note: string;
  };
  performance: {
    n: number;
    meanDeltaR: number | null;
    cumDeltaR: number;
    meanActualExitR: number | null;
    meanPolicyExitR: number | null;
    policyBetterShare: number | null;
    policyBetter: number;
    policyWorse: number;
    /** deltaR === 0 — genuine statistical ties (shadow policy and actual exit produced identical R),
     *  NOT "unmeasured". Backend-computed (exit-brain-shadow.ts), was silently dropped by this type. */
    ties: number;
    /** Evaluated trades where the shadow policy actually banked mid-path (vs held through to the
     *  same close as the real trade). Same already-computed-but-unrendered class as `ties`. */
    banked: number;
  };
  cycleMeta: { lastRunAtIso: string | null; lastProcessed: number; lastError: string | null } | null;
  /** Optional: absent when the instance being polled (testnet is preferred, see useShadowReport)
   *  still runs a build from before the tier split. The card then falls back to the legacy single
   *  unlabeled row — which was ALWAYS measured-only, so nothing is mislabeled either way. */
  measured?: ExitBrainTierBlock;
  simulated?: ExitBrainTierBlock;
};
type FundingCarryReport = {
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  wr: number | null;
  pf: number | null;
  totalNetR: number;
  avgFundingR: number | null;
  avgDivergenceR: number | null;
  avgCostR: number | null;
  edgeReady: boolean;
  cycleMeta: {
    lastCycleAt: string | null;
    pairsEvaluatedTotal: number;
    belowBreakevenTotal: number;
    lastCycleError: string | null;
  } | null;
};
type BtcLeadLagReport = {
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  wr: number | null;
  pf: number | null;
  edgeReady: boolean;
  avgDetectionLatencyMs: number | null;
  avgLagToConvergenceMs: number | null;
  cycleMeta: {
    lastCycleAt: string | null;
    shocksDetectedTotal: number;
    entriesRecordedTotal: number;
    lastCycleError: string | null;
  } | null;
};
type MetaLabelReport = {
  model: { ready: boolean; version: number | null; nTrain: number | null; minExamples: number; lastFitStatus: string | null };
  counts: { records: number; pendingLabel: number; labeled: number; scored: number };
  cohorts: Array<{
    tau: number;
    n: number;
    retained: number;
    retainedPct: number | null;
    gatedNetAvgR: number | null;
    ungatedNetAvgR: number | null;
    lift: number | null;
  }>;
  cycleMeta: { lastCycleAt: string | null; lastCycleError: string | null; lastFitAtIso: string | null } | null;
};
type LiqRecoilReport = {
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  wr: number | null;
  pf: number | null;
  edgeReady: boolean;
  signalSource: string;
  cycleMeta: {
    lastCycleAt: string | null;
    eventsDetectedTotal: number;
    skippedNoFlowDataTotal: number;
    lastCycleError: string | null;
  } | null;
};
type InnovationVariantReport = {
  laneId: string;
  parentLaneId?: string | null;
  version?: 'V1' | 'V2';
  thesis?: string;
  signalSource: string;
  openCount: number;
  resolvedCount: number;
  netAvgR: number | null;
  wr: number | null;
  pf: number | null;
  totalNetR?: number;
  edgeReady: boolean;
  details?: Record<string, unknown>;
  v2Gate?: Record<string, unknown>;
  cycleMeta: {
    lastCycleAt: string | null;
    lastCycleError: string | null;
    cycles?: number;
    candidatesTotal?: number;
    recordedTotal?: number;
    rejectedTotal?: number;
  } | null;
};

type Source = 'testnet' | 'local';
export type LaneFetchState<T> = { data: T | null; source: Source | null; unreachable: boolean };

/** Per-endpoint fetch: testnet (3102) via /testnet Caddy prefix first, local fallback, keep-last-good,
 *  res.ok discipline, seq-guarded. Each endpoint fails independently of its siblings. Exported so other
 *  report-only cards (e.g. FourBrainDashboardCard) reuse this exact fetch/fallback/seq-guard logic
 *  instead of re-implementing it. */
export function useShadowReport<T>(endpoint: string): LaneFetchState<T> {
  const [state, setState] = useState<LaneFetchState<T>>({ data: null, source: null, unreachable: false });
  const seqRef = useRef(0);
  useEffect(() => {
    const grab = async (url: string): Promise<T | null> => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        // A non-200 with a JSON error body would parse fine and land in state as a truthy object —
        // the field accesses below would then throw. Same bug class just fixed in ResearchDashboard.
        if (!res.ok) return null;
        return (await res.json()) as T;
      } catch {
        return null;
      }
    };
    const load = async () => {
      const seq = ++seqRef.current;
      let source: Source = 'testnet';
      let data = await grab(`/testnet/api/shadow/${endpoint}`);
      if (data == null) {
        source = 'local';
        data = await grab(`/api/shadow/${endpoint}`);
      }
      if (seq !== seqRef.current) return; // a newer load already ran — this response is stale
      if (data != null) setState({ data, source, unreachable: false });
      else setState((prev) => ({ ...prev, unreachable: true })); // keep last good value, flag the row
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [endpoint]);
  return state;
}

const fmtMs = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : v < 60_000 ? `${Math.round(v / 1000)}s` : `${(v / 60_000).toFixed(1)}m`;

function Mini({ label, value, color, title }: { label: string; value: string; color?: string; title?: string }) {
  return (
    <span title={title} style={{ fontSize: 12, color: C.dim, whiteSpace: 'nowrap', cursor: title ? 'help' : undefined }}>
      {label} <b style={{ color: color ?? C.text }}>{value}</b>
    </span>
  );
}

const statRow: React.CSSProperties = { display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6, alignItems: 'baseline' };

/** Satu baris tier bukti Exit Brain. Dirender satu per tier, tidak pernah dijumlahkan.
 *  Baris SIMULASI diberi label eksplisit + warna peringatan supaya operator tidak mungkin
 *  membacanya sebagai hasil terukur. */
function ExitBrainTierRow({ block }: { block: ExitBrainTierBlock }) {
  const simulated = block.tier === 'SIMULATED';
  return (
    <div
      style={{
        ...statRow,
        borderLeft: `3px solid ${simulated ? C.accent : C.measure}`,
        paddingLeft: 8,
        marginTop: 8,
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 700, color: simulated ? C.accent : C.measure, whiteSpace: 'nowrap' }} title={block.note}>
        {simulated ? '⚠ SIMULASI (paper candle-walk — BUKAN terukur)' : 'TERUKUR (path nyata terekam)'}
      </span>
      <Mini label="n evaluated" value={`${block.n}/${block.processed}`} title={block.note} />
      <Mini label="mean ΔR" value={fmtR(block.meanDeltaR)} color={toneR(block.meanDeltaR)} />
      <Mini label="kumulatif ΔR" value={fmtR(block.cumDeltaR)} color={toneR(block.cumDeltaR)} />
      <Mini
        label="policy lebih baik"
        value={block.policyBetterShare == null ? '—' : `${Math.round(block.policyBetterShare * 100)}% (${block.policyBetter}✓/${block.policyWorse}✗)`}
      />
      <Mini label="seri (tie)" value={String(block.ties)} title="ΔR = 0 — policy shadow dan exit aktual menghasilkan R yang identik (bukan berarti belum terukur)" />
      <Mini label="dibank policy" value={String(block.banked)} title="Dari trade yang evaluated, berapa yang policy shadow akan bank lebih awal (bukan hold sampai exit aktual)" />
    </div>
  );
}

/** Per-row source annotation (testnet/local/unreachable) — used to live always-visible next to each
 *  lane's badge in the old LaneRow; the shared LaneMaturityTable doesn't have a slot for it, so it
 *  moves into the expanded detail instead of being dropped outright. */
function sourceNote<T>(fs: LaneFetchState<T>): string | null {
  if (fs.source === 'testnet') return 'sumber: testnet (3102)';
  if (fs.source === 'local') return 'sumber: instance ini';
  return null;
}

export function InnovationLanesCard() {
  const exitBrain = useShadowReport<ExitBrainReport>('exit-brain');
  const fundingCarry = useShadowReport<FundingCarryReport>('funding-carry');
  const leadLag = useShadowReport<BtcLeadLagReport>('btc-leadlag-snap');
  const metaLabel = useShadowReport<MetaLabelReport>('meta-label');
  const liqRecoil = useShadowReport<LiqRecoilReport>('liq-recoil');
  const residualV2 = useShadowReport<InnovationVariantReport>('hedged-residual-short-v2');
  const fundingV2 = useShadowReport<InnovationVariantReport>('funding-carry-crowding-v2');
  const liqV2 = useShadowReport<InnovationVariantReport>('liq-recoil-strict-reclaim-v2');
  const compressionV2 = useShadowReport<InnovationVariantReport>('compression-retest-v2');
  const queueToxic = useShadowReport<InnovationVariantReport>('queue-imbalance-toxic-flow');

  const eb = exitBrain.data;
  const fc = fundingCarry.data;
  const bl = leadLag.data;
  const ml = metaLabel.data;
  const lq = liqRecoil.data;

  const ebCoveragePct = eb?.coverage.coverageRatio == null ? null : `${(eb.coverage.coverageRatio * 100).toFixed(1)}%`;
  const mlCohorts = (ml?.cohorts ?? []).filter((c) => c.n > 0);
  const variantRow = (
    key: string,
    name: string,
    detail: string,
    fetchState: LaneFetchState<InnovationVariantReport>,
  ): LaneMaturityRow => {
    const report = fetchState.data;
    const config = report?.v2Gate ?? report?.details ?? {};
    return {
      key,
      name,
      detail,
      badge: report ? laneEdgeBadge(report.edgeReady, report.cycleMeta?.lastCycleError) : null,
      nLabel: report ? `${report.resolvedCount} res / ${report.openCount} open` : '—',
      netAvgR: report?.netAvgR ?? null,
      wr: report?.wr ?? null,
      pf: report?.pf ?? null,
      lastCycleLabel: report?.cycleMeta?.lastCycleAt ? ago(report.cycleMeta.lastCycleAt) : null,
      loading: report == null,
      unreachable: fetchState.unreachable,
      expanded: report && (
        <>
          {sourceNote(fetchState) && <div style={{ fontSize: 10, color: C.measure, marginBottom: 4 }}>{sourceNote(fetchState)}</div>}
          <div style={statRow}>
            <Mini label="lane" value={report.laneId} />
            <Mini label="version" value={report.version ?? 'V2'} color={C.accent} />
            <Mini label="parent" value={report.parentLaneId ?? 'new family'} />
            <Mini label="total" value={fmtR(report.totalNetR ?? null)} color={toneR(report.totalNetR ?? null)} />
          </div>
          {report.thesis && <div style={{ fontSize: 12, color: C.text, marginTop: 7 }}>{report.thesis}</div>}
          <div style={{ fontSize: 11, color: C.dim, marginTop: 5 }}>source: {report.signalSource}</div>
          <div style={{ fontSize: 11, color: C.dim, marginTop: 5, overflowWrap: 'anywhere' }}>
            gate: {JSON.stringify(config)}
          </div>
          {report.cycleMeta && (
            <div style={statRow}>
              <Mini label="cycles" value={String(report.cycleMeta.cycles ?? '—')} />
              <Mini label="candidates" value={String(report.cycleMeta.candidatesTotal ?? '—')} />
              <Mini label="recorded" value={String(report.cycleMeta.recordedTotal ?? '—')} />
              <Mini label="rejected" value={String(report.cycleMeta.rejectedTotal ?? '—')} />
            </div>
          )}
        </>
      ),
    };
  };

  const rows: LaneMaturityRow[] = [
    // 1 — Exit Brain: policy-vs-actual counterfactual. Shape differs from the other 4 (processed/
    // evaluated, not open/resolved) and has no single netAvgR/WR/PF — those stay null/'—' honestly.
    {
      key: 'exit-brain',
      name: 'Exit Brain',
      detail: 'counterfactual exit policy vs exit aktual (Δ = policy − aktual, per trade resolved)',
      badge: eb
        ? eb.cycleMeta?.lastError
          ? { kind: 'error', text: 'CYCLE ERROR', title: eb.cycleMeta.lastError }
          : { kind: 'pending', text: 'shadow counterfactual' }
        : null,
      nLabel: eb ? `${eb.coverage.evaluated}/${eb.coverage.processed} evaluated` : '—',
      netAvgR: null,
      wr: null,
      pf: null,
      lastCycleLabel: eb?.cycleMeta?.lastRunAtIso ? ago(eb.cycleMeta.lastRunAtIso) : null,
      loading: eb == null,
      unreachable: exitBrain.unreachable,
      expanded: eb && (
        <>
          {sourceNote(exitBrain) && <div style={{ fontSize: 10, color: C.measure, marginBottom: 4 }}>{sourceNote(exitBrain)}</div>}
          {eb.measured && eb.simulated ? (
            // Dua tier bukti, DUA baris terpisah — tidak ada satu angka gabungan di mana pun.
            <>
              <ExitBrainTierRow block={eb.measured} />
              <ExitBrainTierRow block={eb.simulated} />
              <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>
                Baris SIMULASI berasal dari candle-walk paper order (walkVariantPath), bukan rekaman tick nyata — angkanya
                tidak pernah dijumlahkan atau dirata-ratakan dengan baris TERUKUR.
              </div>
            </>
          ) : (
            // Fallback: instance lama (belum ada pemisahan tier). Angka ini SELALU measured-only.
            <div style={statRow}>
              <Mini label="n evaluated" value={String(eb.performance.n)} />
              <Mini label="mean ΔR" value={fmtR(eb.performance.meanDeltaR)} color={toneR(eb.performance.meanDeltaR)} />
              <Mini label="kumulatif ΔR" value={fmtR(eb.performance.cumDeltaR)} color={toneR(eb.performance.cumDeltaR)} />
              <Mini
                label="policy lebih baik"
                value={eb.performance.policyBetterShare == null ? '—' : `${Math.round(eb.performance.policyBetterShare * 100)}% (${eb.performance.policyBetter}✓/${eb.performance.policyWorse}✗)`}
              />
              <Mini
                label="seri (tie)"
                value={String(eb.performance.ties)}
                title="ΔR = 0 — policy shadow dan exit aktual menghasilkan R yang identik (bukan berarti belum terukur)"
              />
              <Mini
                label="dibank policy"
                value={String(eb.performance.banked)}
                title="Dari trade yang evaluated, berapa yang policy shadow akan bank lebih awal (bukan hold sampai exit aktual)"
              />
            </div>
          )}
          <div style={{ ...statRow, background: C.sub, borderRadius: 6, padding: '6px 10px', marginTop: 8 }}>
            <Mini label="cakupan path (terukur)" value={`${eb.coverage.evaluated}/${eb.coverage.processed} (${ebCoveragePct ?? '—'})`} color={eb.coverage.evaluated > 0 ? C.text : C.accent} title={eb.coverage.note} />
            <Mini label="INSUFFICIENT_PATH_DATA" value={String(eb.coverage.insufficientPathData)} color={C.accent} />
            {(eb.coverage.coverageRatio ?? 0) === 0 && (
              <span style={{ fontSize: 12, color: C.accent }}>
                menunggu data path padat — recorder tick baru mulai mengisi, ~0% cakupan itu expected, bukan bug
              </span>
            )}
          </div>
        </>
      ),
    },
    // 2 — Funding carry: market-neutral pair, decomposisi funding vs divergence vs biaya.
    {
      key: 'funding-carry',
      name: 'Funding Carry',
      detail: 'pasangan market-neutral: kumpulkan funding, beta saling meniadakan',
      badge: fc ? laneEdgeBadge(fc.edgeReady, fc.cycleMeta?.lastCycleError) : null,
      nLabel: fc ? `${fc.resolvedCount} res / ${fc.openCount} open` : '—',
      netAvgR: fc?.netAvgR ?? null,
      wr: fc?.wr ?? null,
      pf: fc?.pf ?? null,
      lastCycleLabel: fc?.cycleMeta?.lastCycleAt ? ago(fc.cycleMeta.lastCycleAt) : null,
      loading: fc == null,
      unreachable: fundingCarry.unreachable,
      expanded: fc && (
        <>
          {sourceNote(fundingCarry) && <div style={{ fontSize: 10, color: C.measure, marginBottom: 4 }}>{sourceNote(fundingCarry)}</div>}
          <div style={statRow}>
            <Mini label="total" value={fmtR(fc.totalNetR)} color={toneR(fc.totalNetR)} />
            <Mini label="dekomposisi — funding" value={fmtR(fc.avgFundingR)} color={toneR(fc.avgFundingR)} title="rata-rata R yang benar-benar dibayar funding" />
            <Mini label="divergence" value={fmtR(fc.avgDivergenceR)} color={toneR(fc.avgDivergenceR)} title="rata-rata R dari harga kedua kaki yang melebar/menyempit" />
            <Mini label="biaya" value={fmtR(fc.avgCostR)} color={toneR(fc.avgCostR)} title="rata-rata R fees (4 kaki taker)" />
            {fc.cycleMeta && (
              <Mini label="pair dievaluasi" value={`${fc.cycleMeta.pairsEvaluatedTotal} (${fc.cycleMeta.belowBreakevenTotal} di bawah break-even)`} title="total kumulatif semua cycle — mayoritas di bawah break-even itu normal, entry butuh funding gap yang benar-benar bayar" />
            )}
          </div>
        </>
      ),
    },
    // 3 — BTC lead-lag residual snap.
    {
      key: 'btc-leadlag-snap',
      name: 'BTC Lead-Lag Snap',
      detail: 'shock BTC → laggard beta-tinggi belum ikut → tunggangi konvergensinya',
      badge: bl ? laneEdgeBadge(bl.edgeReady, bl.cycleMeta?.lastCycleError) : null,
      nLabel: bl ? `${bl.resolvedCount} res / ${bl.openCount} open` : '—',
      netAvgR: bl?.netAvgR ?? null,
      wr: bl?.wr ?? null,
      pf: bl?.pf ?? null,
      lastCycleLabel: bl?.cycleMeta?.lastCycleAt ? ago(bl.cycleMeta.lastCycleAt) : null,
      loading: bl == null,
      unreachable: leadLag.unreachable,
      expanded: bl && (
        <>
          {sourceNote(leadLag) && <div style={{ fontSize: 10, color: C.measure, marginBottom: 4 }}>{sourceNote(leadLag)}</div>}
          <div style={statRow}>
            <Mini label="shock terdeteksi" value={String(bl.cycleMeta?.shocksDetectedTotal ?? 0)} title="shock BTC unik (dedup per bar) sepanjang umur lane" />
            <Mini label="entry" value={String(bl.cycleMeta?.entriesRecordedTotal ?? 0)} />
            <Mini label="latensi deteksi rata-rata" value={fmtMs(bl.avgDetectionLatencyMs)} title="jeda shock-close → terdeteksi (handicap ticker ~7 menit, diukur jujur per entry)" />
          </div>
        </>
      ),
    },
    // 4 — Meta-label gate: model status + tabel kohort counterfactual per τ. Also a different n-shape
    // (records/labeled/scored, no open/resolved) and no single netAvgR/WR/PF (only per-τ cohorts) —
    // badge keeps the richer MODEL vN status instead of forcing a generic edgeReady badge, since this
    // lane has no edgeReady field at all.
    {
      key: 'meta-label',
      name: 'Meta-Label Gate',
      detail: 'skor per-sinyal (shadow) — kalau gate score ≥ τ dipakai, apa yang terjadi?',
      badge: ml
        ? ml.cycleMeta?.lastCycleError
          ? { kind: 'error', text: 'CYCLE ERROR', title: ml.cycleMeta.lastCycleError }
          : ml.model.ready
            ? { kind: 'ready', text: `MODEL v${ml.model.version ?? '?'}` }
            : { kind: 'pending', text: 'belum ada model' }
        : null,
      nLabel: ml ? `${ml.counts.labeled} labeled / ${ml.counts.scored} scored` : '—',
      netAvgR: null,
      wr: null,
      pf: null,
      lastCycleLabel: ml?.cycleMeta?.lastCycleAt ? ago(ml.cycleMeta.lastCycleAt) : null,
      loading: ml == null,
      unreachable: metaLabel.unreachable,
      expanded: ml && (
        <>
          {sourceNote(metaLabel) && <div style={{ fontSize: 10, color: C.measure, marginBottom: 4 }}>{sourceNote(metaLabel)}</div>}
          <div style={statRow}>
            <Mini
              label="model"
              value={
                ml.model.ready
                  ? `ready (train n=${ml.model.nTrain ?? '—'}${ml.model.lastFitStatus ? `, fit terakhir ${ml.model.lastFitStatus}` : ''})`
                  : `belum ada — butuh ${ml.model.minExamples} labeled, baru ${ml.counts.labeled}`
              }
              color={ml.model.ready ? C.good : C.accent}
            />
            <Mini label="labeled" value={String(ml.counts.labeled)} />
            <Mini label="pending label" value={String(ml.counts.pendingLabel)} />
            <Mini label="scored" value={String(ml.counts.scored)} />
          </div>
          {mlCohorts.length > 0 ? (
            <div style={{ marginTop: 8, overflowX: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '52px 62px 92px 92px 92px', gap: 6, fontSize: 11, color: C.dim, borderBottom: `1px solid ${C.border}`, paddingBottom: 3, minWidth: 400 }}>
                <span>τ</span><span style={{ textAlign: 'right' }}>retained</span><span style={{ textAlign: 'right' }}>gated R</span><span style={{ textAlign: 'right' }}>ungated R</span><span style={{ textAlign: 'right' }}>lift</span>
              </div>
              {mlCohorts.map((c) => (
                <div key={c.tau} style={{ display: 'grid', gridTemplateColumns: '52px 62px 92px 92px 92px', gap: 6, fontSize: 12, padding: '2px 0', borderTop: `1px solid ${C.sub}`, minWidth: 400 }}>
                  <span style={{ color: C.text }}>{c.tau.toFixed(2)}</span>
                  <span style={{ textAlign: 'right', color: C.dim }}>{c.retainedPct == null ? '—' : `${Math.round(c.retainedPct)}%`}</span>
                  <span style={{ textAlign: 'right', color: toneR(c.gatedNetAvgR), fontWeight: 600 }}>{fmtR(c.gatedNetAvgR)}</span>
                  <span style={{ textAlign: 'right', color: toneR(c.ungatedNetAvgR) }}>{fmtR(c.ungatedNetAvgR)}</span>
                  <span style={{ textAlign: 'right', color: toneR(c.lift), fontWeight: 700 }}>{fmtR(c.lift)}</span>
                </div>
              ))}
              <div style={{ fontSize: 10, color: C.dim, marginTop: 3 }}>
                counterfactual murni — tidak ada sinyal yang benar-benar di-gate; lift = gated − ungated netAvgR
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: C.dim, marginTop: 6 }}>tabel kohort kosong — nunggu record yang labeled + scored</div>
          )}
        </>
      ),
    },
    // 5 — Liquidation recoil: fade cascade yang sudah stall, sinyal proxy (bukan feed asli).
    {
      key: 'liq-recoil',
      name: 'Liq Recoil',
      detail: 'fade cascade likuidasi yang stall — sinyal proxy OI+taker, bukan feed likuidasi asli',
      badge: lq ? laneEdgeBadge(lq.edgeReady, lq.cycleMeta?.lastCycleError) : null,
      nLabel: lq ? `${lq.resolvedCount} res / ${lq.openCount} open` : '—',
      netAvgR: lq?.netAvgR ?? null,
      wr: lq?.wr ?? null,
      pf: lq?.pf ?? null,
      lastCycleLabel: lq?.cycleMeta?.lastCycleAt ? ago(lq.cycleMeta.lastCycleAt) : null,
      loading: lq == null,
      unreachable: liqRecoil.unreachable,
      expanded: lq && (
        <>
          {sourceNote(liqRecoil) && <div style={{ fontSize: 10, color: C.measure, marginBottom: 4 }}>{sourceNote(liqRecoil)}</div>}
          <div style={statRow}>
            <Mini label="event terdeteksi" value={String(lq.cycleMeta?.eventsDetectedTotal ?? 0)} title="deteksi cascade-stall mentah (cascade yang sama bisa ke-hitung ulang antar cycle — ini liveness, bukan statistik)" />
            <Mini label="skip tanpa data flow" value={String(lq.cycleMeta?.skippedNoFlowDataTotal ?? 0)} title="abstain karena belum ada sampel OI/taker untuk simbolnya — fail-closed, bukan asal entry" />
            <Mini label="sinyal" value={lq.signalSource === 'OI_TAKER_FLOW_PROXY' ? 'proxy OI+taker' : lq.signalSource} color={C.accent} title="repo ini tidak punya feed likuidasi asli — sinyal direkonstruksi dari kontraksi OI + taker imbalance" />
          </div>
        </>
      ),
    },
    variantRow(
      'hedged-residual-short-v2',
      'Hedged Residual Short V2',
      'short bottom-residual persisten + hedge beta BTC, basket after-cost',
      residualV2,
    ),
    variantRow(
      'funding-carry-crowding-v2',
      'Funding Carry + Crowding V2',
      'parent funding carry dengan absolute + percentile crowding gate',
      fundingV2,
    ),
    variantRow(
      'liq-recoil-strict-reclaim-v2',
      'Liq Recoil Strict Reclaim V2',
      'cascade forced-flow + event-VWAP reclaim + flow flip sebelum entry',
      liqV2,
    ),
    variantRow(
      'compression-retest-v2',
      'Compression Retest V2',
      'flow-confirmed ignition lalu bounded range-edge retest/reclaim',
      compressionV2,
    ),
    variantRow(
      'queue-imbalance-toxic-flow',
      'Queue Imbalance + Toxic Flow',
      'REST L2 + aggTrades markout; signal-only, tanpa asumsi queue fill',
      queueToxic,
    ),
  ];

  return (
    <section id="innovation-lanes" style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 18 }}>
      <header style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: C.text }}>Inovasi (shadow lanes)</h2>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>
            Semua lane di bawah shadow-only (belum eksekusi real) — promosi butuh edgeReady: n≥30, netAvgR≥0.05, PF&gt;1.1
          </div>
        </div>
        <span style={{ color: C.dim, fontSize: 12 }}>refresh 60s · prefer testnet (3102)</span>
      </header>
      <div style={{ padding: '0 16px 14px' }}>
        <LaneMaturityTable rows={rows} />
      </div>
    </section>
  );
}
