/**
 * Context assembler for the trading-assistant chat feature. STRICT READ-ONLY BY CONSTRUCTION:
 *   - local CORTEX state comes only from `getCortexBrainStore(dataDir).get()` (a read accessor, see
 *     cortex-brain-store.ts) and `readCortexJournalTail` (this repo's own read-only jsonl tail reader);
 *   - live/mainnet state comes only from a FIXED, HARDCODED list of GET requests against the confirmed
 *     read-only endpoints in routes/live.ts (`/api/live/account`, `/api/live/balance`,
 *     `/api/live/wallet-reconciliation`) — there is no code path here that accepts a dynamic path or method,
 *     and nothing in this module (or the LLM it feeds) is ever given the ability to call an arbitrary endpoint.
 * Optional source/log inspection is implemented separately by trading-assistant-diagnostic-tools.ts. That runner
 * exposes only fixed read operations and never delegates arbitrary paths, URLs, shell commands, writes, restarts,
 * or trading actions to the model. This context module itself remains GET/read-only.
 */
import { getCortexBrainStore } from "./cortex-brain-store.js";
import { readCortexJournalTail } from "./cortex-journal-reader.js";

interface LiveAccountSnapshot {
  walletBalance?: number;
  availableBalance?: number;
  unrealizedPnl?: number;
  accountEquity?: number;
  openPositionCount?: number;
  positions?: Array<{ symbol: string; direction: string; unrealizedPnl: number; laneIds?: string[] }>;
  closedLanes?: Array<{ laneId: string; closedCount: number; wins: number; losses: number; realizedPnlUsd: number }>;
}
interface LiveBalanceSnapshot {
  walletBalance: number | null;
  availableBalance: number | null;
}
interface WalletReconciliationSnapshot {
  report?: { dayUtc: string; internalRealizedPnlUsd: number; comparisonExchangeUsd: number; deltaUsd: number; withinTolerance: boolean };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatNumber(value: unknown, digits = 2): string {
  const number = finiteNumber(value);
  return number === null ? "n/a" : number.toFixed(digits);
}

function safeText(value: unknown, maxLength = 160): string {
  if (typeof value !== "string") return "?";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maxLength) || "?";
}

async function fetchJsonReadOnly<T>(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // fail-soft: missing peer context must never affect the trading engine
  } finally {
    clearTimeout(timer);
  }
}

export interface TradingAssistantContext {
  contextText: string;
  cortexAvailable: boolean;
  liveAvailable: boolean;
}

export interface BuildContextArgs {
  dataDir?: string;
  livePeerBaseUrl?: string; // default http://127.0.0.1:3103, mirrors LIVE_COPY_TARGET_URL's default (routes/live.ts)
  fetchImpl?: typeof fetch;
  peerTimeoutMs?: number;
}

export async function buildTradingAssistantContext(args: BuildContextArgs = {}): Promise<TradingAssistantContext> {
  const dataDir = args.dataDir ?? "data";
  const livePeerBaseUrl = args.livePeerBaseUrl ?? process.env.LIVE_PEER_BASE_URL ?? "http://127.0.0.1:3103";
  const fetchImpl = args.fetchImpl ?? fetch;
  const peerTimeoutMs = args.peerTimeoutMs ?? 5_000;

  const sections: string[] = [];
  let cortexAvailable = false;
  try {
    const store = getCortexBrainStore(dataDir).get();
    const journal = readCortexJournalTail(dataDir, 8);
    if (journal.length > 0) {
      cortexAvailable = true;
      const latest = journal[journal.length - 1]!;
      const laneLines = (Array.isArray(latest.lanes) ? latest.lanes : [])
        .filter((l) => l.eligible)
        .sort((a, b) => (finiteNumber(b.finalPct) ?? 0) - (finiteNumber(a.finalPct) ?? 0))
        .slice(0, 8)
        .map((l) => `  - ${safeText(l.laneId, 80)} (${safeText(l.direction, 16)}): finalPct=${formatNumber(l.finalPct, 1)}% pWin=${formatNumber(l.pWin)} allocMag=${formatNumber(l.allocationMagnitude, 3)}R - ${safeText(l.reason, 200)}`)
        .join("\n");
      sections.push(
        [
          "=== CORTEX (report-only shadow decision engine, SHADOW mode — drives NOTHING, live beta is hardcoded 0) ===",
          `Source instance port=${safeText(process.env.PORT, 8)}. Latest decision at ${safeText(latest.at, 40)}: regime=${safeText(latest.regimeFamily, 48)}, posture=${safeText(latest.posture, 32)}, direction=${safeText(latest.directionStance, 24)}, grossG=${formatNumber(latest.grossG)}, operationalBeta=${formatNumber(latest.beta, 3)} (always 0 in live), evaluationBeta(shadow-only)=${formatNumber(latest.evaluationBeta, 3)}`,
          `Rationale: ${safeText(latest.rationale, 500)}`,
          `Top eligible lanes this cycle:\n${laneLines || "  (none eligible)"}`,
          `Model has learned from ${store.cumulativeResolved} resolved outcomes total (per-family: ${JSON.stringify(store.resolvedByFamily)}).`,
          `Last ${journal.length} decisions available if asked about recent history/trend.`,
        ].join("\n"),
      );
    }
  } catch {
    cortexAvailable = false; // fail-soft: CORTEX simply is not available on this instance
  }
  if (!cortexAvailable) {
    sections.push("=== CORTEX ===\nNo CORTEX decision data available on this instance (not running here, or no decisions recorded yet).");
  }

  let liveAvailable = false;
  const [account, balance, reconciliation] = await Promise.all([
    fetchJsonReadOnly<{ ok: boolean } & LiveAccountSnapshot>(`${livePeerBaseUrl}/api/live/account`, fetchImpl, peerTimeoutMs),
    fetchJsonReadOnly<{ ok: boolean } & LiveBalanceSnapshot>(`${livePeerBaseUrl}/api/live/balance`, fetchImpl, peerTimeoutMs),
    fetchJsonReadOnly<{ ok: boolean } & WalletReconciliationSnapshot>(`${livePeerBaseUrl}/api/live/wallet-reconciliation`, fetchImpl, peerTimeoutMs),
  ]);
  if (account && (account as { ok?: boolean }).ok !== false) {
    liveAvailable = true;
    const positions = (Array.isArray(account.positions) ? account.positions : [])
      .filter((position): position is NonNullable<typeof position> => position != null && typeof position === "object")
      .slice(0, 50)
      .map((p) => `  - ${safeText(p.symbol, 24)} ${safeText(p.direction, 16)}: unrealizedPnl=$${formatNumber(p.unrealizedPnl)} (lanes: ${(Array.isArray(p.laneIds) ? p.laneIds : []).slice(0, 8).map((lane) => safeText(lane, 80)).join(",") || "?"})`)
      .join("\n");
    const closed = (Array.isArray(account.closedLanes) ? account.closedLanes : [])
      .filter((lane): lane is NonNullable<typeof lane> => lane != null && typeof lane === "object")
      .slice(0, 10)
      .map((l) => `  - ${safeText(l.laneId, 80)}: ${formatNumber(l.closedCount, 0)} closed, ${formatNumber(l.wins, 0)}W/${formatNumber(l.losses, 0)}L, realized=$${formatNumber(l.realizedPnlUsd)}`)
      .join("\n");
    sections.push(
      [
        "=== LIVE / MAINNET real-money account (read-only, from the actual Binance mainnet exchange state) ===",
        `Equity=$${formatNumber(account.accountEquity)}, walletBalance=$${formatNumber(account.walletBalance ?? balance?.walletBalance)}, unrealizedPnl=$${formatNumber(account.unrealizedPnl)}, openPositions=${formatNumber(account.openPositionCount, 0)}`,
        `Open positions:\n${positions || "  (none)"}`,
        `Recent closed lanes:\n${closed || "  (none)"}`,
      ].join("\n"),
    );
  }
  if (reconciliation?.report) {
    const r = reconciliation.report;
    sections.push(`Wallet reconciliation (${safeText(r.dayUtc, 24)}): internal=$${formatNumber(r.internalRealizedPnlUsd)} vs exchange=$${formatNumber(r.comparisonExchangeUsd)}, delta=$${formatNumber(r.deltaUsd)} (${r.withinTolerance ? "within tolerance" : "OUT OF TOLERANCE"})`);
  }
  if (!liveAvailable) {
    sections.push("=== LIVE / MAINNET ===\nCould not reach the live/mainnet instance's read-only status right now (it may be down, or this deployment has no live peer configured).");
  }

  return { contextText: sections.join("\n\n"), cortexAvailable, liveAvailable };
}
