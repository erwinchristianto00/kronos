import { useState } from 'react';

// Shared dashboard UI primitives (2026-07-23 declutter). Two pieces, reused across both the
// Research dashboard (InnovationLanesCard's 5 shadow lanes) and the Exchange dashboard
// (TestnetExchangeDashboard's 3 R&D Tier-1-3 lanes):
//   - `LaneMaturityTable`: table-ifies the not-yet-proven/shadow lane rows that used to each be
//     their own full-width block (InnovationLanesCard.tsx's old per-lane LaneRow), so N lanes cost
//     one compact table instead of N stacked sections. Click a row to expand its rich detail.
//   - `Disclosure`: the one `<details>/<summary>` accordion primitive both dashboards should use,
//     lifted from CrisisModeCard.tsx's existing inline-styled reasoning disclosure.

export const C = {
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

export const fmtR = (v: number | null | undefined, d = 3): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}R`;
export const fmtWr = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
export const fmtPf = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '—' : v >= 999 ? '∞' : v.toFixed(2));
export const toneR = (v: number | null | undefined): string => (v == null ? C.measure : v > 0 ? C.good : v < 0 ? C.bad : C.dim);
export const ago = (ts: string): string => {
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

export type LaneMaturityBadge = { kind: 'ready' | 'pending' | 'error'; text: string; title?: string };

export function laneEdgeBadge(edgeReady: boolean | undefined, cycleError: string | null | undefined): LaneMaturityBadge {
  if (cycleError) return { kind: 'error', text: 'CYCLE ERROR', title: cycleError };
  if (edgeReady === true) return { kind: 'ready', text: 'EDGE READY' };
  return { kind: 'pending', text: 'belum terbukti' };
}

function Badge({ kind, text, title }: LaneMaturityBadge) {
  const color = kind === 'ready' ? C.good : kind === 'error' ? C.bad : C.dim;
  return (
    <span
      title={title}
      style={{ color, border: `1px solid ${color}`, borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700, letterSpacing: 0.3, whiteSpace: 'nowrap', cursor: title ? 'help' : undefined }}
    >
      {text}
    </span>
  );
}

/** One `<details>/<summary>` accordion primitive, styled consistently. `summary` is the always-visible
 *  clickable label (put counts/badges there so collapsed state still communicates something). */
export function Disclosure({ summary, children, defaultOpen }: { summary: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} style={{ marginTop: 6 }}>
      <summary style={{ fontSize: 11, color: C.measure, cursor: 'pointer', userSelect: 'none' }}>{summary}</summary>
      <div style={{ marginTop: 6 }}>{children}</div>
    </details>
  );
}

export type LaneMaturityRow = {
  key: string;
  name: string;
  detail: string;
  badge: LaneMaturityBadge | null;
  /** Precomputed "n" cell — callers own their own open/resolved shape (Exit Brain's
   *  processed/evaluated differs from the other 4 lanes' open/resolved), so this stays a plain
   *  string rather than forcing one schema. */
  nLabel: string;
  netAvgR: number | null;
  wr: number | null;
  pf: number | null;
  lastCycleLabel: string | null;
  unreachable?: boolean;
  loading?: boolean;
  /** Expanded row content. Omit (undefined/null) to render a non-expandable row. */
  expanded?: React.ReactNode;
};

const gridCols = '1fr 100px 90px 80px 60px 55px 90px';

/** Data-maturity table for not-yet-proven/shadow lanes: one compact row per lane (name, badge, n,
 *  netAvgR, WR, PF, last-cycle-ago), click a row to expand its full detail underneath. */
export function LaneMaturityTable({ title, subtitle, rows }: { title?: string; subtitle?: string; rows: LaneMaturityRow[] }) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div>
      {(title || subtitle) && (
        <div style={{ marginBottom: 8 }}>
          {title && <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{title}</div>}
          {subtitle && <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>{subtitle}</div>}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 640 }}>
          <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, fontSize: 11, color: C.dim, borderBottom: `1px solid ${C.border}`, paddingBottom: 4 }}>
            <span>Lane</span>
            <span>Status</span>
            <span style={{ textAlign: 'right' }}>n (res/open)</span>
            <span style={{ textAlign: 'right' }}>netAvgR</span>
            <span style={{ textAlign: 'right' }}>WR</span>
            <span style={{ textAlign: 'right' }}>PF</span>
            <span style={{ textAlign: 'right' }}>last cycle</span>
          </div>
          {rows.map((row) => {
            const isOpen = openKeys.has(row.key);
            const canExpand = row.expanded != null;
            return (
              <div key={row.key} style={{ borderBottom: `1px solid ${C.sub}` }}>
                <div
                  onClick={canExpand ? () => toggle(row.key) : undefined}
                  style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, fontSize: 12, padding: '7px 0', alignItems: 'center', cursor: canExpand ? 'pointer' : 'default' }}
                >
                  <span style={{ color: C.text, fontWeight: 600 }}>
                    {canExpand && <span style={{ display: 'inline-block', width: 12, color: C.dim }}>{isOpen ? '▾' : '▸'}</span>}
                    {row.name}
                    {row.unreachable && <span style={{ color: C.accent }} title="koneksi putus — data terakhir"> ⚠</span>}
                  </span>
                  <span>{row.badge ? <Badge {...row.badge} /> : row.loading ? <span style={{ fontSize: 11, color: C.dim }}>loading…</span> : null}</span>
                  <span style={{ textAlign: 'right', color: C.dim }}>{row.nLabel}</span>
                  <span style={{ textAlign: 'right', color: toneR(row.netAvgR), fontWeight: 600 }}>{fmtR(row.netAvgR)}</span>
                  <span style={{ textAlign: 'right', color: C.dim }}>{fmtWr(row.wr)}</span>
                  <span style={{ textAlign: 'right', color: C.dim }}>{fmtPf(row.pf)}</span>
                  <span style={{ textAlign: 'right', color: C.dim, whiteSpace: 'nowrap' }}>{row.lastCycleLabel ? `${row.lastCycleLabel} lalu` : 'belum jalan'}</span>
                </div>
                <div style={{ fontSize: 11, color: C.dim, marginTop: -4, marginBottom: isOpen ? 0 : 6 }}>{row.detail}</div>
                {isOpen && row.expanded && <div style={{ padding: '2px 0 10px 18px' }}>{row.expanded}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
