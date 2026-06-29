/**
 * Hard-cut counterfactual analyzer (read-only).
 *
 * The anti-bull hard-cut closes a RED opposing position at market once a bull has opposed it for
 * `LIVE_TESTNET_REGIME_HARD_CUT_MS` (default 30 min). Whether that THRESHOLD is right is an
 * empirical question — so instead of guessing, we MEASURE it: for every hard-cut that already
 * happened, replay the price AFTER the cut and ask "what if we had instead ridden to the stop?".
 *
 *   delta = cutRealized − rideToStopRealized   (per position, in USD)
 *     delta > 0  → cutting SAVED money (the position would have hit its stop / fallen further)
 *     delta < 0  → cutting was a WHIPSAW (the bull faked out; holding would have recovered)
 *
 * Aggregate delta tells us if the hard-cut is net helping at the current threshold; bucketing by
 * how long the position was held also hints at where the optimal threshold sits. Pure function —
 * the caller injects the closed intents and a candle fetcher; never touches the live engine.
 */
import type { Candle } from "@dtc/shared";

export interface HardCutIntentInput {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  qty: number;
  cutRealizedUsd: number;
  cutAtMs: number;
}

export type HardCutCfOutcome = "RIDE_HIT_STOP" | "RIDE_RECOVERED" | "NO_CANDLES" | "PENDING";

export interface HardCutCounterfactualRecord {
  symbol: string;
  direction: "LONG" | "SHORT";
  cutAtMs: number;
  cutRealizedUsd: number;
  cfOutcome: HardCutCfOutcome;
  /** PnL if we had instead held to the stop (or marked at the window end). */
  cfRealizedUsd: number | null;
  /** cutRealized − cfRealized: positive ⇒ the cut beat riding to the stop. */
  deltaUsd: number | null;
}

export interface HardCutCounterfactualSummary {
  analyzed: number;
  resolved: number;
  pending: number;
  cutHelped: number;
  cutWhipsawed: number;
  rideHitStop: number;
  rideRecovered: number;
  totalDeltaUsd: number;
  avgDeltaUsd: number | null;
  /** Net verdict: > 0 ⇒ the hard-cut adds value at the current threshold. */
  verdict: "HARD_CUT_HELPS" | "HARD_CUT_HURTS" | "INSUFFICIENT_DATA";
}

export interface HardCutCounterfactualResult {
  windowMs: number;
  summary: HardCutCounterfactualSummary;
  records: HardCutCounterfactualRecord[];
}

/** Would a held position have hit its stop in the forward window? Returns the counterfactual PnL. */
function rideToStop(intent: HardCutIntentInput, candles: Candle[]): { outcome: HardCutCfOutcome; cfRealizedUsd: number } {
  const { direction, entryPrice, stopPrice, qty } = intent;
  for (const c of candles) {
    const hitStop = direction === "SHORT" ? c.high >= stopPrice : c.low <= stopPrice;
    if (hitStop) {
      const cf = direction === "SHORT" ? qty * (entryPrice - stopPrice) : qty * (stopPrice - entryPrice);
      return { outcome: "RIDE_HIT_STOP", cfRealizedUsd: cf };
    }
  }
  // Never hit the stop in the window → mark to the last close (the bull faded / it recovered).
  const lastClose = candles[candles.length - 1]!.close;
  const cf = direction === "SHORT" ? qty * (entryPrice - lastClose) : qty * (lastClose - entryPrice);
  return { outcome: "RIDE_RECOVERED", cfRealizedUsd: cf };
}

export async function analyzeHardCutCounterfactuals(
  intents: HardCutIntentInput[],
  fetchCandles: (symbol: string, startMs: number, endMs: number) => Promise<Candle[]>,
  opts: { windowMs: number; nowMs: number },
): Promise<HardCutCounterfactualResult> {
  const records: HardCutCounterfactualRecord[] = await Promise.all(
    intents.map(async (intent): Promise<HardCutCounterfactualRecord> => {
      const base = {
        symbol: intent.symbol,
        direction: intent.direction,
        cutAtMs: intent.cutAtMs,
        cutRealizedUsd: intent.cutRealizedUsd,
      };
      // Not enough forward time has elapsed to judge the ride-to-stop yet.
      if (opts.nowMs - intent.cutAtMs < opts.windowMs) {
        return { ...base, cfOutcome: "PENDING", cfRealizedUsd: null, deltaUsd: null };
      }
      let candles: Candle[] = [];
      try {
        candles = await fetchCandles(intent.symbol, intent.cutAtMs, intent.cutAtMs + opts.windowMs);
      } catch {
        candles = [];
      }
      if (!candles.length) return { ...base, cfOutcome: "NO_CANDLES", cfRealizedUsd: null, deltaUsd: null };
      const { outcome, cfRealizedUsd } = rideToStop(intent, candles);
      return { ...base, cfOutcome: outcome, cfRealizedUsd, deltaUsd: intent.cutRealizedUsd - cfRealizedUsd };
    }),
  );

  const resolved = records.filter((r) => r.deltaUsd !== null);
  const totalDelta = resolved.reduce((s, r) => s + (r.deltaUsd ?? 0), 0);
  const cutHelped = resolved.filter((r) => (r.deltaUsd ?? 0) > 0).length;
  return {
    windowMs: opts.windowMs,
    records,
    summary: {
      analyzed: records.length,
      resolved: resolved.length,
      pending: records.filter((r) => r.cfOutcome === "PENDING").length,
      cutHelped,
      cutWhipsawed: resolved.filter((r) => (r.deltaUsd ?? 0) < 0).length,
      rideHitStop: records.filter((r) => r.cfOutcome === "RIDE_HIT_STOP").length,
      rideRecovered: records.filter((r) => r.cfOutcome === "RIDE_RECOVERED").length,
      totalDeltaUsd: totalDelta,
      avgDeltaUsd: resolved.length ? totalDelta / resolved.length : null,
      verdict: resolved.length < 5 ? "INSUFFICIENT_DATA" : totalDelta > 0 ? "HARD_CUT_HELPS" : "HARD_CUT_HURTS",
    },
  };
}

/** Pull the hard-cut intents out of a raw live-execution.json state object. */
export function extractHardCutIntents(state: { intents?: unknown[] } | null | undefined): HardCutIntentInput[] {
  const intents = Array.isArray(state?.intents) ? state!.intents : [];
  const out: HardCutIntentInput[] = [];
  for (const raw of intents as Array<Record<string, unknown>>) {
    const closeReason = typeof raw.closeReason === "string" ? raw.closeReason : "";
    if (!closeReason.startsWith("REGIME_OPPOSITION_HARD_CUT")) continue;
    const entryPrice = Number(raw.filledEntryPrice ?? raw.plannedEntryPrice);
    const stopPrice = Number(raw.stopLossPrice);
    const qty = Number(raw.qty);
    const cutAtMs = new Date(String(raw.closedAt ?? raw.updatedAt ?? "")).getTime();
    const direction = raw.direction === "LONG" ? "LONG" : "SHORT";
    if (!(entryPrice > 0) || !(stopPrice > 0) || !(qty > 0) || !Number.isFinite(cutAtMs)) continue;
    out.push({
      symbol: String(raw.symbol ?? ""),
      direction,
      entryPrice,
      stopPrice,
      qty,
      cutRealizedUsd: Number(raw.realizedPnlUsd ?? 0),
      cutAtMs,
    });
  }
  return out;
}
