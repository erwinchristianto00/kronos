import { C } from './LaneMaturityTable';

// Shared readiness verdict (backend: four-brain-readiness.ts). Lived inside FourBrainDashboardCard
// and rendered Direction and Entry only, so Exit — the one brain whose headline most needs a verdict
// beside it — showed its numbers with nothing to judge them by. Moved here so both cards render the
// SAME component: two verdict widgets that drift apart is how a panel starts lying quietly.
//
// The shared palette has no `track`, so it is defined locally at the value the four-brain card used.
const TRACK = '#1c2c34';

export type FourBrainReadinessGate = {
  gate: 'EVIDENCE' | 'EDGE' | 'SELECTION' | 'CALIBRATION';
  passed: boolean | null;
  value: number | null;
  detail: string;
};
export type FourBrainReadinessScope = {
  brain?: string;
  scope: string;
  verdict: 'READY' | 'NOT_READY' | 'NOT_READY_SIMULATED_ONLY' | 'INSUFFICIENT_EVIDENCE';
  summary: string;
  measuredBasis?: 'REAL' | 'SIMULATED';
  gates: FourBrainReadinessGate[];
};
export type FourBrainReadinessBlock = {
  verdict: FourBrainReadinessScope['verdict'];
  summary: string;
  perScope: FourBrainReadinessScope[];
};

/** READY is the only green. NOT_READY_SIMULATED_ONLY is deliberately NOT neutral — a brain whose
 *  numbers look excellent but come entirely from a counterfactual walk is the single most dangerous
 *  thing on this card, so it reads as a warning, not as "still collecting". */
export const readinessColor = (v: FourBrainReadinessScope['verdict']): string =>
  v === 'READY' ? C.good : v === 'NOT_READY' ? C.bad : v === 'NOT_READY_SIMULATED_ONLY' ? C.accent : C.dim;
export const readinessLabel = (v: FourBrainReadinessScope['verdict']): string =>
  v === 'READY' ? 'SIAP' : v === 'NOT_READY' ? 'BELUM SIAP' : v === 'NOT_READY_SIMULATED_ONLY' ? 'SIMULASI SAJA' : 'BUKTI KURANG';

export function ReadinessVerdict({ block, title }: { block: FourBrainReadinessBlock | null | undefined; title: string }) {
  if (!block) return null;
  return (
    <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 6, background: TRACK, border: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.4 }}>{title}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: readinessColor(block.verdict) }}>{readinessLabel(block.verdict)}</span>
        <span style={{ fontSize: 12, color: C.sub }}>{block.summary}</span>
      </div>
      <div style={{ marginTop: 6, display: 'grid', gap: 2 }}>
        {block.perScope.map((s) => (
          <div key={s.scope} style={{ fontSize: 11, color: C.dim, display: 'flex', gap: 6 }}>
            <span style={{ minWidth: 150, color: C.sub }}>{s.scope}</span>
            <span style={{ minWidth: 92, color: readinessColor(s.verdict) }}>{readinessLabel(s.verdict)}</span>
            <span>{s.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
