import { useEffect, useRef, useState } from 'react';
import { C, ago, Disclosure } from './LaneMaturityTable';

// Crisis Mode card (2026-07-22, TESTNET/RESEARCH REPORT-ONLY) — /research only. Mirrors
// InnovationLanesCard.tsx's fetch conventions exactly: testnet (3102) preferred via the /testnet
// Caddy prefix, local fallback, keep-last-good on transient failure, seq-guarded against a stale
// slow response overwriting a newer one. This feature ships OFF by default (CRISIS_MODE_DISABLED
// unset on every instance) — the card renders honestly either way: "cycle belum jalan" when
// cycleDisabled is true, live status once an operator explicitly opts an instance in.
//
// No black-box number: every field shown here traces back to inspectable evidence — the escalation
// score's own per-component reasoning[], the market-confirmation evidence (BTC shock z-score /
// direction + RCS axis score vs their thresholds), and the underlying conflict events (CAMEO code +
// Goldstein score + actors + source link) behind the aggregate count.
//
// 2026-07-23 declutter: header badge + disabled-notice + event evidence stay always visible;
// escalation-stats / market-confirmation / reasoning / audit-log fold into one collapsed
// `<Disclosure>` (shared primitive, also used by InnovationLanesCard/CortexReadinessCard/
// FourBrainDashboardCard — this file's own inline reasoning <details> is replaced by it too, for
// consistency). The gates-footer line (cycleDisabled/controllerDisabled/actionEnabled/
// liveExecutionAllowed/canApplyActions) is no longer always-rendered (it duplicated the badge +
// disabled-notice above); the 5 booleans stay reachable via a small (i) tooltip inside the
// Disclosure instead of being deleted outright.
//
// IMPORTANT: crisis-event-evidence (`conflictFeedReport.topRecent`) renders independent of
// cycleDisabled/status — it only depends on `data` + topRecent.length > 0 — so it stays OUTSIDE
// the collapsed Disclosure, always visible, same as before.

type ConflictIntensity = { eventCount: number; meanGoldstein: number | null; highSeverityCount: number; windowMs: number };
type EscalationClassification = {
  quantitativeScore: number;
  llmSeverity: number | null;
  llmAvailable: boolean;
  llmConfidence: 'low' | 'medium' | 'high' | null;
  finalScore: number;
  reasoning: string[];
};
type CrisisModeEvidence = {
  escalationFinalScore: number;
  escalationThreshold: number;
  escalationGatePassed: boolean;
  btcShockIsShock: boolean | null;
  btcShockDirection: 'LONG' | 'SHORT' | null;
  btcShockZScore: number | null;
  btcShockConfirmed: boolean;
  regimeAxisScore: number | null;
  regimeAxisScoreMax: number;
  regimeAxisConfirmed: boolean;
  marketConfirmationPassed: boolean;
};
type CrisisModeEvaluation = {
  active: boolean;
  reason: string;
  allocationTiltPct: number;
  exitToleranceOverride: { baseRetraceFrac: number; minRetraceFrac: number; roundTripGuardR: number } | null;
  reasoning: string[];
  evidence: CrisisModeEvidence;
};
type CrisisModeStatusSnapshot = {
  atIso: string;
  conflictIntensity: ConflictIntensity;
  escalation: EscalationClassification;
  crisisMode: CrisisModeEvaluation;
  feedFetchError: string | null;
  llmAvailable: boolean;
};
type ConflictEvent = {
  id: string;
  dateMs: number;
  cameoCode: string;
  goldsteinScale: number | null;
  isHighSeverity: boolean;
  isMassViolence: boolean;
  actor1: string | null;
  actor2: string | null;
  sourceUrl: string | null;
};
type GeopoliticalFeedReport = {
  intensity: ConflictIntensity;
  massViolenceCount: number;
  storedEventCount: number;
  topRecent: ConflictEvent[];
};
type CrisisModeAuditLogEntry = {
  id: string;
  atIso: string;
  active: boolean;
  reason: string;
  escalationFinalScore: number;
  allocationTiltPct: number;
};
type CrisisModeReport = {
  generatedAt: string;
  cycleDisabled: boolean;
  controllerDisabled: boolean;
  instanceId: string;
  isLiveInstance: boolean;
  actionEnabled: boolean;
  liveExecutionAllowed: boolean;
  canApplyActions: boolean;
  status: CrisisModeStatusSnapshot | null;
  conflictFeedReport: GeopoliticalFeedReport;
  recentAuditLog: CrisisModeAuditLogEntry[];
  cycleMeta: { lastCycleAt: string | null; cycles: number; flipsTotal: number; lastFeedFetchError: string | null; lastError: string | null };
};

type Source = 'testnet' | 'local';
type FetchState = { data: CrisisModeReport | null; source: Source | null; unreachable: boolean };

function useCrisisModeReport(): FetchState {
  const [state, setState] = useState<FetchState>({ data: null, source: null, unreachable: false });
  const seqRef = useRef(0);
  useEffect(() => {
    const grab = async (url: string): Promise<CrisisModeReport | null> => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        return (await res.json()) as CrisisModeReport;
      } catch {
        return null;
      }
    };
    const load = async () => {
      const seq = ++seqRef.current;
      let source: Source = 'testnet';
      let data = await grab('/testnet/api/shadow/crisis-mode');
      if (data == null) {
        source = 'local';
        data = await grab('/api/shadow/crisis-mode');
      }
      if (seq !== seqRef.current) return;
      if (data != null) setState({ data, source, unreachable: false });
      else setState((prev) => ({ ...prev, unreachable: true }));
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return state;
}

function Badge({ kind, text, title }: { kind: 'active' | 'inactive' | 'off' | 'error'; text: string; title?: string }) {
  const color = kind === 'active' ? C.bad : kind === 'error' ? C.bad : kind === 'off' ? C.dim : C.good;
  return (
    <span
      title={title}
      style={{ color, border: `1px solid ${color}`, borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700, letterSpacing: 0.3, whiteSpace: 'nowrap', cursor: title ? 'help' : undefined }}
    >
      {text}
    </span>
  );
}

function Mini({ label, value, color, title }: { label: string; value: string; color?: string; title?: string }) {
  return (
    <span title={title} style={{ fontSize: 12, color: C.dim, whiteSpace: 'nowrap', cursor: title ? 'help' : undefined }}>
      {label} <b style={{ color: color ?? C.text }}>{value}</b>
    </span>
  );
}

const statRow: React.CSSProperties = { display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6, alignItems: 'baseline' };

export function CrisisModeCard() {
  const { data, source, unreachable } = useCrisisModeReport();

  const sourceLabel = source === 'testnet' ? 'sumber: testnet (3102)' : source === 'local' ? 'sumber: instance ini' : null;
  const status = data?.status ?? null;
  const evidence = status?.crisisMode.evidence ?? null;

  const badge: { kind: 'active' | 'inactive' | 'off' | 'error'; text: string; title?: string } | null = !data
    ? null
    : data.cycleDisabled
      ? { kind: 'off', text: 'DISABLED', title: 'CRISIS_MODE_DISABLED belum di-set "0" di instance ini — fitur ini OFF by default' }
      : data.cycleMeta.lastError
        ? { kind: 'error', text: 'CYCLE ERROR', title: data.cycleMeta.lastError }
        : status?.crisisMode.active
          ? { kind: 'active', text: 'CRISIS MODE ACTIVE' }
          : { kind: 'inactive', text: 'inactive' };

  return (
    <section style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 18 }}>
      <header style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: C.text }}>Crisis Mode</h2>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>
            eskalasi geopolitik (GDELT) + konfirmasi market (BTC shock / RCS axis) — report-only, testnet/research; TIDAK menyentuh alokasi/eksekusi real
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 11, color: C.dim }}>
          <div>refresh 60s · {sourceLabel ?? 'menghubungkan…'}</div>
          {unreachable && data != null && <div style={{ color: C.accent }}>koneksi putus — data terakhir</div>}
        </div>
      </header>

      {!data ? (
        <div style={{ padding: '10px 16px', fontSize: 12, color: unreachable ? C.bad : C.dim, borderTop: `1px solid ${C.border}` }}>
          {unreachable ? 'unreachable — endpoint tidak terjangkau (testnet & lokal)' : 'loading…'}
        </div>
      ) : (
        <>
          {/* Always visible: header badge (one line) + a shrunk one-line caption when disabled. */}
          <div style={{ borderTop: `1px solid ${C.border}`, padding: '10px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              {badge && <Badge kind={badge.kind} text={badge.text} title={badge.title} />}
              <span style={{ color: C.dim, fontSize: 11 }}>
                instance {data.instanceId}{data.isLiveInstance ? ' (LIVE — application gate hard-blocked)' : ''}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: C.dim }}>
                {data.cycleMeta.lastCycleAt ? `cycle ${ago(data.cycleMeta.lastCycleAt)} lalu` : 'cycle belum jalan'}
              </span>
            </div>
            {data.cycleDisabled && (
              <div style={{ fontSize: 11, color: C.dim, marginTop: 6, fontStyle: 'italic' }}>
                OFF by default (CRISIS_MODE_DISABLED belum di-set "0" di instance ini) — operator harus eksplisit mengaktifkan; belum ada cycle yang jalan.
              </div>
            )}
          </div>

          {/* Event evidence — ALWAYS VISIBLE, independent of cycleDisabled/status (only depends on
              data + topRecent.length > 0) — do NOT move this inside the Disclosure below. */}
          {data.conflictFeedReport.topRecent.length > 0 && (
            <div style={{ borderTop: `1px solid ${C.border}`, padding: '10px 16px' }}>
              <div style={{ fontSize: 12, color: C.text, fontWeight: 700, marginBottom: 6 }}>
                Event evidence terbaru ({data.conflictFeedReport.storedEventCount} tersimpan, {data.conflictFeedReport.massViolenceCount} mass-violence di window)
              </div>
              {data.conflictFeedReport.topRecent.slice(0, 6).map((e) => (
                <div key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 11, padding: '3px 0', borderTop: `1px solid ${C.sub}`, flexWrap: 'wrap' }}>
                  <span style={{ color: C.dim, minWidth: 60 }}>{ago(new Date(e.dateMs).toISOString())} lalu</span>
                  {e.isMassViolence && <Badge kind="active" text="MASS VIOLENCE" />}
                  {!e.isMassViolence && e.isHighSeverity && <Badge kind="inactive" text="high sev" />}
                  <span style={{ color: C.text }}>{e.actor1 ?? '—'} ↔ {e.actor2 ?? '—'}</span>
                  <span style={{ color: C.dim }}>CAMEO {e.cameoCode} · Goldstein {e.goldsteinScale ?? '—'}</span>
                  {e.sourceUrl && (
                    <a href={e.sourceUrl} target="_blank" rel="noreferrer" style={{ color: C.measure }}>
                      sumber
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Collapsed by default: escalation-stats, market-confirmation, reasoning, audit-log.
              The 5 gate booleans (previously an always-rendered footer line duplicating the badge
              above) are reachable via the (i) tooltip on the summary instead of being deleted. */}
          <div style={{ borderTop: `1px solid ${C.border}`, padding: '10px 16px' }}>
            <Disclosure
              summary={
                <>
                  Details ({status?.crisisMode.active ? 'currently active' : 'currently inactive'}) ▸{' '}
                  <span
                    title={`gates — cycleDisabled: ${data.cycleDisabled} · controllerDisabled: ${data.controllerDisabled} · actionEnabled: ${data.actionEnabled} · liveExecutionAllowed: ${data.liveExecutionAllowed} · canApplyActions: ${data.canApplyActions} (allocationTiltPct/exitToleranceOverride tidak pernah diterapkan ke apa pun saat ini — tidak ada kode aplikasi real yang memanggil gate ini)`}
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, borderRadius: '50%', border: `1px solid ${C.border}`, fontSize: 9, cursor: 'help' }}
                  >
                    i
                  </span>
                </>
              }
            >
              {status ? (
                <>
                  <div style={statRow}>
                    <Mini label="escalation finalScore" value={`${status.escalation.finalScore.toFixed(1)}/100`} color={status.escalation.finalScore >= evidence!.escalationThreshold ? C.bad : C.text} title={`threshold ${evidence?.escalationThreshold}`} />
                    <Mini label="quantitativeScore" value={`${status.escalation.quantitativeScore.toFixed(1)}`} title="skor murni non-LLM (primary signal) — LLM hanya bisa MENURUNKAN, tidak pernah menaikkan" />
                    <Mini label="LLM corroboration" value={status.escalation.llmAvailable ? `tersedia (${status.escalation.llmConfidence ?? '—'})` : 'tidak aktif'} color={status.escalation.llmAvailable ? C.measure : C.dim} />
                    <Mini label="event count" value={String(status.conflictIntensity.eventCount)} />
                    <Mini label="high-severity" value={String(status.conflictIntensity.highSeverityCount)} />
                    <Mini label="mean Goldstein" value={status.conflictIntensity.meanGoldstein == null ? '—' : status.conflictIntensity.meanGoldstein.toFixed(2)} title="-10 = paling konfliktual, +10 = paling kooperatif; null = tidak ada event dengan skor di window ini" />
                  </div>

                  <div style={{ ...statRow, background: C.sub, borderRadius: 6, padding: '6px 10px', marginTop: 8 }}>
                    <Mini
                      label="BTC lead-lag shock"
                      value={evidence?.btcShockConfirmed ? `CONFIRMED (${evidence.btcShockDirection}, |z|=${evidence.btcShockZScore != null ? Math.abs(evidence.btcShockZScore).toFixed(2) : '—'})` : 'tidak konfirmasi'}
                      color={evidence?.btcShockConfirmed ? C.bad : C.dim}
                    />
                    <Mini
                      label="RCS bearish axis"
                      value={evidence?.regimeAxisConfirmed ? `CONFIRMED (score=${evidence.regimeAxisScore?.toFixed(2)} <= ${evidence.regimeAxisScoreMax})` : `tidak konfirmasi${evidence?.regimeAxisScore != null ? ` (score=${evidence.regimeAxisScore.toFixed(2)})` : ''}`}
                      color={evidence?.regimeAxisConfirmed ? C.bad : C.dim}
                    />
                    <Mini
                      label="allocationTiltPct"
                      value={`${status.crisisMode.allocationTiltPct.toFixed(1)}pp`}
                      title="data saja — TIDAK diterapkan ke alokasi real; lihat canApplyActions"
                    />
                  </div>

                  <div style={{ fontSize: 11, color: C.dim, marginTop: 8, lineHeight: 1.5 }}>
                    <b style={{ color: C.text }}>keputusan:</b> {status.crisisMode.reason}
                  </div>

                  <Disclosure summary={`reasoning lengkap (${status.escalation.reasoning.length + status.crisisMode.reasoning.length} baris)`}>
                    <div style={{ fontSize: 11, color: C.dim, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto' }}>
                      {[...status.escalation.reasoning, ...status.crisisMode.reasoning].join('\n')}
                    </div>
                  </Disclosure>

                  {status.feedFetchError && (
                    <div style={{ fontSize: 11, color: C.accent, marginTop: 6 }}>feed fetch error (fail-open, event lama tetap dipakai): {status.feedFetchError}</div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 12, color: C.dim }}>
                  {data.cycleDisabled ? 'Belum ada evaluasi — fitur ini OFF di instance ini.' : 'cycle belum pernah jalan — menunggu tick pertama'}
                </div>
              )}

              {data.recentAuditLog.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, color: C.text, fontWeight: 700, marginBottom: 6 }}>Audit log — perubahan active/inactive terakhir</div>
                  {data.recentAuditLog.slice(0, 8).map((e) => (
                    <div key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 11, padding: '3px 0', borderTop: `1px solid ${C.sub}`, flexWrap: 'wrap' }}>
                      <span style={{ color: C.dim, minWidth: 60 }}>{ago(e.atIso)} lalu</span>
                      <Badge kind={e.active ? 'active' : 'inactive'} text={e.active ? 'ACTIVE' : 'inactive'} />
                      <span style={{ color: C.dim }}>score {e.escalationFinalScore.toFixed(1)} · tilt {e.allocationTiltPct.toFixed(1)}pp</span>
                      <span style={{ color: C.dim, flex: 1, minWidth: 200 }}>{e.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </Disclosure>
          </div>
        </>
      )}
    </section>
  );
}
