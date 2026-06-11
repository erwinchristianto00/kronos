// Portfolio-heat SHADOW recorder (measurement only — never mutates the book, never trades,
// never affects admission/resolution). It re-prices the SAME admitted paper trades under a
// portfolio-heat sizing cap and records the resulting equity/risk/drawdown curve, so a future
// live size cap can be chosen from an accumulating sample instead of a guess.
//
// This is NOT a gate: nothing here rejects a trade. It only answers "how would bounding total
// simultaneous risk have traded profit against drawdown and risk-of-ruin?" — persisted once per
// Taiwan day so the curve's evolution (especially across bad regimes) becomes visible over time.
//
// Persisted to data/portfolio-heat-shadow-snapshots.json. The CLI viewer is
// scripts/portfolio-heat-shadow.mjs. Keep the math here in sync with that viewer's HONEST READ.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Minimal shape of the fields we read off a paper order (decoupled from the full PaperOrder type).
interface HeatOrderLike {
  paperOrderId: string;
  paperStatus: string;
  openedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  netR?: number | null;
  netPnlAmount?: number | null;
  plannedRiskAmount?: number | null;
}

export interface HeatSweepRow {
  heatCapPct: number; // cap on Σ open risk as % of equity (Infinity-coded as -1 => UNCAPPED)
  terminalEq: number;
  peakRiskPct: number; // realized peak Σ-open-risk as % of equity
  maxDrawdownPct: number; // realized peak-to-trough drawdown
}

export interface HeatShadowSnapshot {
  capturedAt: string;
  twDate: string;
  reportOnly: true;
  measurementOnly: true;
  bookClosed: number;
  equityStart: number;
  realizedNT: number;
  twDays: number;
  peakConcurrentRiskR: number;
  peakRiskPctOfEquity: number;
  worstDayR: number;
  bestDayR: number;
  ruinCliffPerTradePct: number | null; // per-trade risk % at which the worst observed day = total wipeout
  sampleSufficientForLiveSizing: boolean;
  heatSweep: HeatSweepRow[];
}

const DEFAULT_HEAT_CAPS = [0.1, 0.2, 0.3, 0.5, 1, 2, 5, Infinity];
const NT_PER_R = 20; // 1R = 1% of the 2000 NT start; matches the book's plannedRiskAmount basis

const twDayOf = (iso: string): string =>
  new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);

function openMs(o: HeatOrderLike): number {
  return new Date(o.openedAt || o.createdAt || "").getTime();
}
function closeMs(o: HeatOrderLike): number {
  return new Date(o.updatedAt || "").getTime();
}

/** Event-driven heat-cap equity simulation over the realized (closed) trades. */
function simHeatCap(
  closed: HeatOrderLike[],
  heatCap: number,
  startEq: number,
  riskPct = 0.01,
): HeatSweepRow {
  const valid = closed.filter(
    (o) => Number.isFinite(openMs(o)) && Number.isFinite(closeMs(o)) && closeMs(o) >= openMs(o),
  );
  const events: Array<[number, 0 | 1, HeatOrderLike]> = [];
  for (const o of valid) {
    events.push([openMs(o), 1, o]); // open
    events.push([closeMs(o), 0, o]); // close — rank 0 so freed budget is available to same-instant opens
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const sized = new Map<string, number>();
  let eq = startEq;
  let heat = 0;
  let peakHeatPct = 0;
  let peakEq = startEq;
  let maxDD = 0;
  for (const [, type, o] of events) {
    if (type === 1) {
      const base = riskPct * eq;
      const remaining = Math.max(0, heatCap * eq - heat);
      const risk = Math.min(base, remaining);
      sized.set(o.paperOrderId, risk);
      heat += risk;
      peakHeatPct = Math.max(peakHeatPct, heat / eq);
    } else {
      const risk = sized.get(o.paperOrderId) || 0;
      heat -= risk;
      eq += (o.netR ?? 0) * risk;
      peakEq = Math.max(peakEq, eq);
      maxDD = Math.max(maxDD, (peakEq - eq) / peakEq);
    }
  }
  return {
    heatCapPct: heatCap === Infinity ? -1 : Math.round(heatCap * 100),
    terminalEq: eq,
    peakRiskPct: peakHeatPct * 100,
    maxDrawdownPct: maxDD * 100,
  };
}

/** Peak simultaneous open risk (R units) across the WHOLE book, open positions included. */
function peakConcurrentRiskR(orders: HeatOrderLike[]): number {
  const ev: Array<[number, number]> = [];
  for (const o of orders) {
    const r = (o.plannedRiskAmount ?? NT_PER_R) / NT_PER_R;
    const t0 = openMs(o);
    if (!Number.isFinite(t0)) continue;
    const live = o.paperStatus === "PAPER_SUBMITTED" || o.paperStatus === "CREATED";
    const t1 = live ? Infinity : closeMs(o);
    ev.push([t0, r]);
    if (Number.isFinite(t1)) ev.push([t1, -r]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of ev) {
    cur += d;
    peak = Math.max(peak, cur);
  }
  return peak;
}

/** Pure computation of a heat-shadow snapshot from the order book. Deterministic (no RNG). */
export function computeHeatShadowSnapshot(
  orders: HeatOrderLike[],
  equityStart: number,
  nowIso: string,
): HeatShadowSnapshot {
  const closed = orders.filter((o) => o.netPnlAmount != null && o.netR != null);
  const realized = closed.reduce((s, o) => s + (o.netPnlAmount ?? 0), 0);
  const equityNow = equityStart + realized;

  // daily edge in R units
  const byDay = new Map<string, number>();
  for (const o of closed) {
    const d = twDayOf(o.updatedAt || o.createdAt || nowIso);
    byDay.set(d, (byDay.get(d) ?? 0) + (o.netR ?? 0));
  }
  const dayRs = [...byDay.values()];
  const worstDayR = dayRs.length ? Math.min(...dayRs) : 0;
  const bestDayR = dayRs.length ? Math.max(...dayRs) : 0;
  // per-trade risk % at which the worst observed day becomes a -100% wipeout
  const ruinCliffPerTradePct = worstDayR < 0 ? (1 / Math.abs(worstDayR)) * 100 : null;

  // Re-price the sweep on current equity (equity-linked sizing).
  const heatSweep = DEFAULT_HEAT_CAPS.map((h) => simHeatCap(closed, h, equityNow, 0.01));

  const peakR = peakConcurrentRiskR(orders);
  const peakRiskPctOfEquity = equityNow > 0 ? (peakR / (equityNow / NT_PER_R)) * 100 : 0;

  // A sample is only credible for live sizing once it spans enough days AND has seen a genuinely
  // adverse day (a real down-regime), so the ruin cliff isn't estimated purely from up days.
  const sampleSufficientForLiveSizing = byDay.size >= 30 && worstDayR <= -40;

  return {
    capturedAt: nowIso,
    twDate: twDayOf(nowIso),
    reportOnly: true,
    measurementOnly: true,
    bookClosed: closed.length,
    equityStart,
    realizedNT: Math.round(realized),
    twDays: byDay.size,
    peakConcurrentRiskR: Math.round(peakR),
    peakRiskPctOfEquity: Math.round(peakRiskPctOfEquity),
    worstDayR: Math.round(worstDayR),
    bestDayR: Math.round(bestDayR),
    ruinCliffPerTradePct: ruinCliffPerTradePct == null ? null : Number(ruinCliffPerTradePct.toFixed(2)),
    sampleSufficientForLiveSizing,
    heatSweep,
  };
}

interface SnapshotFile {
  version: 1;
  measurementOnly: true;
  snapshots: HeatShadowSnapshot[];
}

/**
 * Upsert today's (Taiwan-day) heat-shadow snapshot into
 * data/portfolio-heat-shadow-snapshots.json. One row per TW day (latest wins, so end-of-day is
 * final). Pure measurement — never throws into the caller (wrap defensively at the call site too).
 * Returns the snapshot written, or null on any read/write failure.
 */
export function recordHeatShadowSnapshot(
  dataDir: string,
  orders: HeatOrderLike[],
  equityStart: number,
  nowIso: string,
): HeatShadowSnapshot | null {
  const file = resolve(dataDir, "portfolio-heat-shadow-snapshots.json");
  const snap = computeHeatShadowSnapshot(orders, equityStart, nowIso);

  let doc: SnapshotFile = { version: 1, measurementOnly: true, snapshots: [] };
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<SnapshotFile>;
      if (parsed && Array.isArray(parsed.snapshots)) doc.snapshots = parsed.snapshots;
    }
  } catch {
    // corrupt/unreadable existing file — start fresh rather than break the paper pass
    doc = { version: 1, measurementOnly: true, snapshots: [] };
  }

  const idx = doc.snapshots.findIndex((s) => s.twDate === snap.twDate);
  if (idx >= 0) doc.snapshots[idx] = snap;
  else doc.snapshots.push(snap);
  doc.snapshots.sort((a, b) => (a.twDate < b.twDate ? -1 : a.twDate > b.twDate ? 1 : 0));

  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(doc, null, 2), "utf-8");
  } catch {
    return null;
  }
  return snap;
}
