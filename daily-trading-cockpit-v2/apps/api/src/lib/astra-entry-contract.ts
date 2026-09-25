/** Host-frozen admission terms, enforced on the LAST executable book.
 * No exchange I/O. Never used to modify existing positions or their exits.
 */
import { roundToStep } from "./binance-futures-private.js";
import type { AstraDecision } from "./astra-hermes-lane.js";

export const ASTRA_EXECUTION_VERSION = "astra-final-book-contract-v1-20260909";
export interface AstraEntryContract {
  version: 1; planId: string; validatedAt: number; expiresAt: number;
  symbol: string; side: "LONG" | "SHORT"; notionalUsd: number;
  stopPrice: number; targetPrice: number; maxHoldMs: number;
  triggerPrice: number; entryMin: number; entryMax: number;
  maxSpreadBps: number; maxCostBps: number; entrySlippageBps: number;
  exitSlippageBps: number; fundingAllowanceBps: number; takerRate: number;
}
export class AstraEntryGateError extends Error {
  constructor(public diagnostic: Record<string, unknown>) {
    super(`FINAL_ENTRY_GATE:${diagnostic.failedPredicate}`);
  }
}
function fail(predicate: string, threshold: unknown, actual: unknown, extra = {}) : never {
  throw new AstraEntryGateError({ executionVersion: ASTRA_EXECUTION_VERSION,
    failedPredicate: predicate, threshold, actualValue: actual, ...extra });
}
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function validateEntryContract(d: AstraDecision): AstraEntryContract {
  const c = d.entryContract;
  if (!c || c.version !== 1 || typeof c.planId !== "string" || !/^[a-zA-Z0-9_-]{8,120}$/.test(c.planId))
    fail("entryContract", "host frozen contract v1", "missing or malformed");
  for (const k of ["validatedAt", "expiresAt", "notionalUsd", "stopPrice", "targetPrice", "maxHoldMs", "triggerPrice", "entryMin", "entryMax", "maxCostBps"] as const)
    if (!finite(c[k]) || c[k] <= 0) fail(k, "positive finite", c[k]);
  for (const k of ["maxSpreadBps", "entrySlippageBps", "exitSlippageBps", "fundingAllowanceBps", "takerRate"] as const)
    if (!finite(c[k]) || c[k] < 0) fail(k, "nonnegative finite", c[k]);
  for (const k of ["symbol", "side", "notionalUsd", "stopPrice", "targetPrice", "maxHoldMs"] as const)
    if (c[k] !== d[k]) fail(`frozen.${k}`, c[k], d[k]);
  if (c.entrySlippageBps !== d.slippageBps) fail("frozen.slippageBps", c.entrySlippageBps, d.slippageBps);
  if (c.entryMin > c.entryMax) fail("entryBand", "min <= max", [c.entryMin, c.entryMax]);
  if ((d.side === "LONG" ? c.triggerPrice-c.stopPrice : c.stopPrice-c.triggerPrice) <= 0)
    fail("plannedRisk", "> 0", c.triggerPrice-c.stopPrice);
  return c;
}

export function finalEntryGate(d: AstraDecision, book: {bid: number | null; ask: number | null; time: number | null}, tick: number, now: number) {
  const c = validateEntryContract(d), long = d.side === "LONG", direction = long ? 1 : -1;
  if (!finite(now) || now < c.validatedAt || now-c.validatedAt > 120000 || now >= c.expiresAt)
    fail("contractFresh", { maxAgeMs: 120000, expiresAt: c.expiresAt }, now, { validatedAt: c.validatedAt });
  if (!finite(book.bid) || !finite(book.ask) || book.bid <= 0 || book.ask < book.bid ||
      !finite(book.time) || Math.abs(now-book.time) > 5000 || !finite(tick) || tick <= 0)
    fail("bookFresh", "valid executable book <= 5s", book);
  const px = long ? book.ask : book.bid;
  const spreadBps = (book.ask-book.bid)/((book.ask+book.bid)/2)*10000;
  const costBps = spreadBps + 2*c.takerRate*10000 + c.entrySlippageBps+c.exitSlippageBps+c.fundingAllowanceBps;
  const detail = { planId: c.planId, book, executablePrice: px, spreadBps, costBps, checkedAt: now };
  if (!finite(costBps)) fail("cost", "finite", costBps, detail);
  if (px < c.entryMin || px > c.entryMax) fail("entryBand", [c.entryMin,c.entryMax], px, detail);
  if (spreadBps > c.maxSpreadBps) fail("spread", c.maxSpreadBps, spreadBps, detail);
  if (costBps > c.maxCostBps) fail("cost", c.maxCostBps, costBps, detail);
  const originalLimit = roundToStep(px*(1+direction*c.entrySlippageBps/10000), tick, long ? "up" : "down");
  // Preserve the original IOC allowance, but never round beyond the frozen band.
  const bandLimit = roundToStep(long ? c.entryMax : c.entryMin, tick, long ? "down" : "up");
  const limitPrice = long ? Math.min(originalLimit,bandLimit) : Math.max(originalLimit,bandLimit);
  if (!finite(limitPrice) || limitPrice <= 0 || (limitPrice-px)*direction < 0) fail("executableLimit", px, limitPrice, detail);
  const stop = roundToStep(c.stopPrice,tick,long ? "down" : "up");
  const plannedRisk = direction*(c.triggerPrice-c.stopPrice)/c.triggerPrice;
  const riskInflation = direction*(limitPrice-stop)/limitPrice/plannedRisk;
  if (!finite(riskInflation) || riskInflation <= 0 || riskInflation > 1.25) fail("riskEnvelope", 1.25, riskInflation, { ...detail, limitPrice, stop });
  const rewardBps = direction*(c.targetPrice-limitPrice)/limitPrice*10000;
  if (!finite(rewardBps) || rewardBps <= costBps) fail("targetCoversCost", costBps, rewardBps, { ...detail, limitPrice });
  return { executionVersion: ASTRA_EXECUTION_VERSION, ...detail, originalLimit, limitPrice,
    bandClamped: originalLimit !== limitPrice, stop, riskInflation, maxRiskInflation: 1.25, rewardBps,
    contract: c };
}
