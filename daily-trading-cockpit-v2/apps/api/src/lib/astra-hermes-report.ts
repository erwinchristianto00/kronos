import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { AstraTrade, AstraDecision } from "./astra-hermes-lane.js";
import { ASTRA_CAPITAL, walletView } from "./astra-capital.js";
import { DECLARED_PRIMARY, type AstraModelPolicy } from "./astra-model-policy.js";

export interface AstraReportSource {
  trades: AstraTrade[];
  funding: Array<{ tradeId: string; amount: number }>;
  fundingThrough: number; lastError: string | null;
  decisions: Array<{ at: number; decision: AstraDecision; result: unknown }>;
}
export interface ReportBook { bid: number | null; ask: number | null; time: number | null }
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Pure owned-ledger projection. No exchange I/O and no mutation from dashboard GETs.
 *
 * The decision policy is passed in rather than read here, so this stays pure: the lane
 * resolves the live one, and a caller that does not know defaults to what the lane
 * declares — never to a claim that the primary is running when it may not be. */
export function buildAstraReport(source: AstraReportSource, books: Map<string, ReportBook>, now: number,
  wallet = walletView(null, null, now), policy: AstraModelPolicy = DECLARED_PRIMARY) {
  const trades = source.trades.map(t => {
    const gross = sum(t.fills.map(f => f.realizedPnl));
    const fees = sum(t.fills.map(f => f.commission));
    const funding = sum(source.funding.filter(f => f.tradeId === t.id).map(f => f.amount));
    const book = books.get(t.symbol);
    const px = t.side === "LONG" ? book?.bid : book?.ask;
    const quoteFresh = !!book?.time && Math.abs(now - book.time) <= 120000 && !!px && px > 0;
    const hasExposure = t.qty > 1e-9;
    const unrealized = !hasExposure ? 0 : quoteFresh ? (px! - t.entryPrice) * t.qty * (t.side === "LONG" ? 1 : -1) : null;
    const settled = t.state === "CLOSED" && t.entryQty > 0 && t.settlementComplete;
    const exitIds = new Set([...t.exits.map(x => x.order?.orderId), t.stopExitId].filter(Boolean));
    const exitFills = t.fills.filter(f => exitIds.has(f.orderId));
    const exitQty = sum(exitFills.map(f => f.qty));
    return { id: t.id, symbol: t.symbol, side: t.side, state: t.state, settled,
      openedAt: t.entry.order?.updateTime ?? t.createdAt, closedAt: t.closedAt,
      entryPrice: t.entryPrice || null, exitPrice: exitQty > 0 ? sum(exitFills.map(f => f.qty * f.price)) / exitQty : null,
      entryQty: t.entryQty, remainingQty: t.qty, entryNotional: t.entryPrice * t.entryQty,
      gross, fees, funding, net: gross - fees + funding, unrealized,
      quoteAt: book?.time ?? null, quoteFresh, quotePrice: quoteFresh ? px : null,
      stopPrice: t.stopPrice, targetPrice: t.targetPrice, maxHoldMs: t.maxHoldMs,
      protection: hasExposure ? t.stopId && !t.stopDone ? "NATIVE_STOP" : "UNCONFIRMED" : "NO_EXPOSURE",
      reason: t.decision.reason, exitReason: t.safetyExitReason ?? (t.stopExitId ? "NATIVE_STOP" : t.exitReason ?? null),
      accountingComplete: settled || t.state === "NO_FILL", error: t.error };
  });
  const closed = trades.filter(t => t.settled).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const noFill = trades.filter(t => t.state === "NO_FILL");
  const open = trades.filter(t => !t.settled && t.state !== "NO_FILL").sort((a, b) => b.openedAt - a.openedAt);
  const gross = sum(trades.map(t => t.gross)), fees = sum(trades.map(t => t.fees));
  const funding = sum(source.funding.map(f => f.amount));
  const net = gross - fees + funding;
  const floating = open.some(t => t.unrealized === null) ? null : sum(open.map(t => t.unrealized ?? 0));
  const wins = closed.filter(t => t.net > 0), losses = closed.filter(t => t.net < 0);
  const winningPnl = sum(wins.map(t => t.net)), losingPnl = -sum(losses.map(t => t.net));
  let running = 0, peak = 0, maxDrawdown = 0;
  for (const t of [...closed].reverse()) { running += t.net; peak = Math.max(peak, running); maxDrawdown = Math.max(maxDrawdown, peak - running); }
  return { schemaVersion: 2, environment: "testnet", laneId: "ASTRA_HERMES_TESTNET", generatedAt: now,
    model: policy.model, reasoning: policy.reasoning, modelRole: policy.modelRole, modelSource: policy.modelSource,
    capital: ASTRA_CAPITAL, wallet, leverage: 1, dailyLossCap: null,
    source: "OWNED_ASTRA_LEDGER", fundingThrough: source.fundingThrough, lastError: source.lastError,
    summary: { gross, fees, funding, net, floating, estimatedNet: floating === null ? null : net + floating,
      closedN: closed.length, openN: open.filter(t => t.remainingQty > 0).length,
      pendingN: open.filter(t => t.state !== "OPEN" || !!t.error).length, noFillN: noFill.length,
      closedGross: sum(closed.map(t => t.gross)), closedFees: sum(closed.map(t => t.fees)), closedFunding: sum(closed.map(t => t.funding)),
      closedNet: sum(closed.map(t => t.net)), wins: wins.length, losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : null,
      profitFactor: losingPnl > 0 ? winningPnl / losingPnl : null,
      expectancy: closed.length ? sum(closed.map(t => t.net)) / closed.length : null,
      maxClosedDrawdown: closed.length ? maxDrawdown : null,
      fundingCurrent: now - source.fundingThrough <= 180000,
      settlementPending: open.some(t => t.state !== "OPEN" || !!t.error) },
    closed, open, noFill,
    decisions: source.decisions.slice(-20).reverse().map(d => ({ at: d.at, id: d.decision.id,
      action: d.decision.action, reasonCode: d.decision.reasonCode ?? null, symbol: d.decision.symbol ?? null, reason: d.decision.reason,
      result: (d.result as { status?: string; state?: string })?.status ?? (d.result as { state?: string })?.state ?? "UNKNOWN" })) };
}

export interface LearningCycle { at: number; completed: boolean; apiCalls: number; response: string; inspectedSymbols: string[] }
export interface LearningSnapshot {
  publishedAt: number; memoryUpdatedAt: number | null; memoryText: string;
  cycleCount: number; completedCycles: number; cycles: LearningCycle[];
}
/** Host-authored, allowlisted learning projection; never accepts config, tools or credentials. */
export class AstraLearningStore {
  constructor(private file: string, private now = Date.now) {}
  accept(input: unknown) {
    const x = input as LearningSnapshot;
    const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
    const boundedText = (s: unknown, max: number): s is string => typeof s === "string" && s.length <= max;
    if (!x || !finite(x.publishedAt) || x.publishedAt < 1 || x.publishedAt > this.now() + 120000 ||
        !(x.memoryUpdatedAt === null || finite(x.memoryUpdatedAt)) || !boundedText(x.memoryText, 12000) ||
        !Number.isSafeInteger(x.cycleCount) || x.cycleCount < 0 || !Number.isSafeInteger(x.completedCycles) ||
        x.completedCycles < 0 || x.completedCycles > x.cycleCount || !Array.isArray(x.cycles) || x.cycles.length > 10)
      throw new Error("Invalid learning snapshot");
    const cycles = x.cycles.map(c => {
      if (!c || !finite(c.at) || c.at > x.publishedAt + 120000 || typeof c.completed !== "boolean" ||
          !Number.isSafeInteger(c.apiCalls) || c.apiCalls < 0 || !boundedText(c.response, 6000) ||
          !Array.isArray(c.inspectedSymbols) || c.inspectedSymbols.length > 1000 || c.inspectedSymbols.some(s => !boundedText(s, 80)))
        throw new Error("Invalid learning cycle");
      return { at: c.at, completed: c.completed, apiCalls: c.apiCalls, response: c.response, inspectedSymbols: c.inspectedSymbols };
    });
    const previous = this.read();
    if (previous.snapshot && x.publishedAt < previous.snapshot.publishedAt) throw new Error("Stale learning upload");
    const snapshot: LearningSnapshot = { publishedAt: x.publishedAt, memoryUpdatedAt: x.memoryUpdatedAt,
      memoryText: x.memoryText, cycleCount: x.cycleCount, completedCycles: x.completedCycles, cycles };
    writeFileSync(this.file + ".tmp", JSON.stringify(snapshot), { mode: 0o600 }); renameSync(this.file + ".tmp", this.file);
    return { ok: true, publishedAt: snapshot.publishedAt };
  }
  read(): { snapshot: LearningSnapshot | null; status: "AVAILABLE" | "STALE" | "MISSING" | "UNREADABLE" } {
    if (!existsSync(this.file)) return { snapshot: null, status: "MISSING" };
    try {
      const snapshot = JSON.parse(readFileSync(this.file, "utf8")) as LearningSnapshot;
      if (!Number.isFinite(snapshot.publishedAt) || !Array.isArray(snapshot.cycles) || typeof snapshot.memoryText !== "string") throw new Error("Invalid data");
      return { snapshot, status: this.now() - snapshot.publishedAt > 900000 ? "STALE" : "AVAILABLE" };
    } catch { return { snapshot: null, status: "UNREADABLE" }; }
  }
}
