/**
 * Cross-sectional TP-threshold sweep (report-only).
 *
 * Operator question (2026-07-07): "keep the 0.6% profit-bank, or bank smaller/more often (e.g.
 * every ~$2 unrealized) and reopen?" The honest way to answer is per-basket path replay: walk each
 * CLOSED basket's real 1h candle path and find, for each candidate threshold, WHEN the basket's
 * net return first touched it. Exit there (threshold value, since the executor's TP check banks at
 * the touch) or ride to the stored horizon outcome if never touched.
 *
 * The decisive metric is NOT mean net per basket (a lower threshold trivially wins less per
 * basket) — it is EV PER SLOT-DAY: meanNet% × (24h / meanHoldHours). Banking early frees the slot
 * for the next hourly signal, so a small-frequent TP can beat a bigger-rare one only if the
 * per-day compounding outruns the per-basket giveback. Same honesty caveats as the winners
 * counterfactual: hourly closes (no intrabar), standard cost model, no extra slippage.
 */
import {
  CROSS_SECTIONAL_ROUNDTRIP_BPS,
  type CrossSectionalStore,
} from "./cross-sectional-edge.js";
import { spotSymbolForCandles, type CandleRangeFetcher } from "./cross-sectional-winners-counterfactual.js";
import type { Candle } from "@dtc/shared";

const HOUR_MS = 3_600_000;

export interface TpSweepRow {
  thresholdPct: number;
  /** Approx USDT on the standard 6-leg × $25 basket, for operator intuition. */
  approxUsdOnStandardBasket: number;
  baskets: number;
  touched: number;
  touchRatePct: number | null;
  meanNetReturnPct: number | null;
  winRatePct: number | null;
  meanHoldHours: number | null;
  /** meanNet% × (24 / meanHoldHours): what one slot earns per day at this threshold. */
  evPerSlotDayPct: number | null;
}

export interface TpSweepReport {
  generatedAt: string;
  variant: string;
  closedCompleteBaskets: number;
  excludedNoCandleCoverage: number;
  costReturnPct: number;
  rows: TpSweepRow[];
  note: string;
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function closeAtOrBefore(candles: Candle[], tMs: number): number | null {
  let best: Candle | null = null;
  for (const c of candles) {
    if (c.openTime + HOUR_MS <= tMs && (best === null || c.openTime > best.openTime)) best = c;
  }
  return best !== null && best.close > 0 ? best.close : null;
}

export async function buildTpSweepReport(
  store: CrossSectionalStore,
  fetchCandles: CandleRangeFetcher,
  opts: { variant?: string; thresholdsPct?: number[]; nowIso?: () => string } = {},
): Promise<TpSweepReport> {
  const variant = opts.variant ?? "FILTERED";
  // Default sweep includes the current 0.6% and the operator's "$2 on a $150 basket" (≈1.33%).
  const thresholdsPct = opts.thresholdsPct ?? [0.3, 0.45, 0.6, 0.9, 1.33];
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const costReturn = CROSS_SECTIONAL_ROUNDTRIP_BPS / 10_000;

  const closed = store.all.filter(
    (o) =>
      o.status === "CLOSED" &&
      (o.variant ?? "RAW") === variant &&
      o.netReturn !== null &&
      o.longLeg.every((l) => l.entryPrice > 0) &&
      o.shortLeg.every((l) => l.entryPrice > 0),
  );

  const candlesBySymbol = new Map<string, Candle[]>();
  if (closed.length > 0) {
    const spanStart = Math.min(...closed.map((b) => b.openedAtMs)) - HOUR_MS;
    const spanEnd = Math.max(...closed.map((b) => b.openedAtMs + b.horizonMs)) + HOUR_MS;
    const symbols = new Set(closed.flatMap((b) => [...b.longLeg, ...b.shortLeg].map((l) => l.symbol)));
    for (const symbol of symbols) {
      try {
        candlesBySymbol.set(symbol, await fetchCandles(spotSymbolForCandles(symbol), spanStart, spanEnd));
      } catch {
        candlesBySymbol.set(symbol, []);
      }
    }
  }

  // Per basket: hourly net-return path; per threshold: first-touch hour or null.
  type BasketPath = { horizonNet: number; horizonHours: number; firstTouchHoursByThreshold: Array<number | null> };
  const paths: BasketPath[] = [];
  let excludedNoCandleCoverage = 0;
  for (const b of closed) {
    const horizonHours = Math.max(1, Math.round(b.horizonMs / HOUR_MS));
    const legs = [
      ...b.longLeg.map((l) => ({ ...l, dir: 1 as const })),
      ...b.shortLeg.map((l) => ({ ...l, dir: -1 as const })),
    ];
    const firstTouch: Array<number | null> = thresholdsPct.map(() => null);
    let covered = true;
    for (let h = 1; h <= horizonHours; h += 1) {
      const tMs = b.openedAtMs + h * HOUR_MS;
      const longReturns: number[] = [];
      const shortReturns: number[] = [];
      for (const leg of legs) {
        const price = closeAtOrBefore(candlesBySymbol.get(leg.symbol) ?? [], tMs);
        if (price === null) { covered = false; break; }
        const r = leg.dir === 1 ? price / leg.entryPrice - 1 : 1 - price / leg.entryPrice;
        (leg.dir === 1 ? longReturns : shortReturns).push(r);
      }
      if (!covered) break;
      const gross =
        (longReturns.length ? longReturns.reduce((a, c) => a + c, 0) / longReturns.length : 0) / 2 +
        (shortReturns.length ? shortReturns.reduce((a, c) => a + c, 0) / shortReturns.length : 0) / 2;
      const net = gross - costReturn;
      for (let i = 0; i < thresholdsPct.length; i += 1) {
        if (firstTouch[i] === null && net >= thresholdsPct[i]! / 100) firstTouch[i] = h;
      }
    }
    if (!covered) {
      excludedNoCandleCoverage += 1;
      continue;
    }
    paths.push({ horizonNet: b.netReturn!, horizonHours, firstTouchHoursByThreshold: firstTouch });
  }

  const rows: TpSweepRow[] = thresholdsPct.map((thresholdPct, i) => {
    const nets: number[] = [];
    const holds: number[] = [];
    let touched = 0;
    for (const p of paths) {
      const touch = p.firstTouchHoursByThreshold[i]!;
      if (touch !== null) {
        touched += 1;
        nets.push(thresholdPct / 100);
        holds.push(touch);
      } else {
        nets.push(p.horizonNet);
        holds.push(p.horizonHours);
      }
    }
    const meanNet = mean(nets);
    const meanHold = mean(holds);
    return {
      thresholdPct,
      approxUsdOnStandardBasket: Number(((thresholdPct / 100) * 150).toFixed(2)),
      baskets: paths.length,
      touched,
      touchRatePct: paths.length ? (touched / paths.length) * 100 : null,
      meanNetReturnPct: meanNet === null ? null : meanNet * 100,
      winRatePct: nets.length ? (nets.filter((n) => n > 0).length / nets.length) * 100 : null,
      meanHoldHours: meanHold,
      evPerSlotDayPct: meanNet !== null && meanHold !== null && meanHold > 0 ? meanNet * 100 * (24 / meanHold) : null,
    };
  });

  return {
    generatedAt: nowIso(),
    variant,
    closedCompleteBaskets: paths.length,
    excludedNoCandleCoverage,
    costReturnPct: costReturn * 100,
    rows,
    note:
      "exit = threshold value at first hourly touch, else the stored horizon outcome. Decisive metric is evPerSlotDayPct " +
      "(meanNet × 24/meanHold): banking early only wins if per-day compounding outruns the per-basket giveback. Hourly " +
      "closes (no intrabar), standard cost model, no extra slippage — live results would be slightly worse.",
  };
}
