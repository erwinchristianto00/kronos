/**
 * Read-only pre-deploy replay for ONE_SIDED_DIRECTIONAL_QUALITY_V1.
 *
 * Example:
 * npx tsx apps/api/scripts/replay-one-sided-directional-quality-v1.ts \
 *   --input live /tmp/live-edge.json /tmp/live-executor.json \
 *   --input testnet /tmp/testnet-edge.json /tmp/testnet-executor.json
 *
 * It never writes state and never calls a private/execution endpoint. Historical public USD-M
 * 1h klines are used only to reconstruct the causal BTC/ETH FAST4H and selected-leg 1h values.
 */
import { readFile } from "node:fs/promises";
import { evaluateOneSidedDirectionalQuality } from "../src/lib/dynamic-mom36-one-sided-directional-quality.js";

type Json = Record<string, any>;
type Input = { label: string; edge: Json; executor: Json };
type Candidate = {
  source: string;
  sourceObservationId: string;
  observation: Json;
  dynamic: Json;
  executorBasket: Json | null;
  featureMs: number;
  direction: "LONG" | "SHORT";
  selected: string[];
};

const HOUR_MS = 60 * 60 * 1000;

function usage(): never {
  throw new Error("usage: --input <label> <cross-sectional-edge.json> <cross-sectional-executor.json> [...]");
}

async function parseInputs(): Promise<Input[]> {
  const args = process.argv.slice(2);
  const inputs: Input[] = [];
  for (let index = 0; index < args.length;) {
    if (args[index] !== "--input") usage();
    const label = args[index + 1];
    const edgePath = args[index + 2];
    const executorPath = args[index + 3];
    if (!label || !edgePath || !executorPath) usage();
    inputs.push({
      label,
      edge: JSON.parse(await readFile(edgePath, "utf8")),
      executor: JSON.parse(await readFile(executorPath, "utf8")),
    });
    index += 4;
  }
  if (!inputs.length) usage();
  return inputs;
}

function finalDirection(dynamic: Json): "LONG" | "SHORT" | null {
  const allocation = dynamic?.finalAllocation;
  if (allocation?.longCount === 6 && allocation?.shortCount === 0) return "LONG";
  if (allocation?.shortCount === 6 && allocation?.longCount === 0) return "SHORT";
  return null;
}

function featureMs(dynamic: Json): number | null {
  const parsed = Date.parse(dynamic?.featureTimestamp ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function candidateKey(candidate: Pick<Candidate, "featureMs" | "direction" | "selected">): string {
  return `${candidate.featureMs}|${candidate.direction}|${[...candidate.selected].sort().join("|")}`;
}

function executionPriority(candidate: Candidate): number {
  const basket = candidate.executorBasket;
  if (basket?.status === "CLOSED" || basket?.status === "COMPLETE") return 3;
  if (candidate.observation?.status === "CLOSED") return 2;
  if (basket) return 1;
  return 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function cvar5(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const count = Math.max(1, Math.ceil(sorted.length * 0.05));
  return sorted.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
}

function maxDrawdown(values: Array<{ featureMs: number; netReturn: number }>): number | null {
  if (!values.length) return null;
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (const row of [...values].sort((a, b) => a.featureMs - b.featureMs)) {
    equity *= 1 + row.netReturn;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity / peak - 1);
  }
  return drawdown;
}

function realizedReturn(candidate: Candidate): number | null {
  const basket = candidate.executorBasket;
  if ((basket?.status === "CLOSED" || basket?.status === "COMPLETE") && finite(basket.lastNetReturn)) return basket.lastNetReturn;
  return candidate.observation?.status === "CLOSED" && finite(candidate.observation.netReturn)
    ? candidate.observation.netReturn
    : null;
}

function outcomeState(candidate: Candidate): string {
  const basket = candidate.executorBasket;
  if (basket?.status) return String(basket.status);
  if (candidate.observation?.status) return String(candidate.observation.status);
  return "UNAVAILABLE";
}

async function fetchSymbolCandles(symbol: string, startMs: number, endMs: number): Promise<Map<number, number>> {
  const query = new URLSearchParams({
    symbol,
    interval: "1h",
    startTime: String(startMs),
    endTime: String(endMs),
    limit: "1000",
  });
  const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?${query}`);
  if (!response.ok) throw new Error(`public kline ${symbol}: HTTP ${response.status}`);
  const rows = await response.json() as unknown;
  if (!Array.isArray(rows)) throw new Error(`public kline ${symbol}: malformed payload`);
  const result = new Map<number, number>();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const openTime = Number(row[0]);
    const close = Number(row[4]);
    if (Number.isFinite(openTime) && Number.isFinite(close) && close > 0) result.set(openTime, close);
  }
  return result;
}

function returnAt(candles: Map<number, number> | undefined, endMs: number, bars: number): number | null {
  if (!candles) return null;
  const latest = candles.get(endMs - HOUR_MS);
  const prior = candles.get(endMs - (bars + 1) * HOUR_MS);
  if (!(finite(latest) && latest > 0 && finite(prior) && prior > 0)) return null;
  return latest / prior - 1;
}

function strictSelected(candidate: Candidate): boolean {
  const bySymbol = new Map<string, Json>((candidate.dynamic.activeUniverse ?? []).map((row: Json) => [row.symbol, row]));
  return candidate.selected.length === 6 && candidate.selected.every((symbol) => {
    const row = bySymbol.get(symbol);
    if (!row || !finite(row.mom36) || !finite(row.fastReturn)) return false;
    if (candidate.direction === "LONG") return row.mom36 > 0 && row.fastReturn > 0 && row.longEligible !== false && !row.longExecutionBlockReason;
    return row.mom36 < 0 && row.fastReturn < 0 && row.shortEligible !== false && !row.shortBlocked && !row.shortExecutionBlockReason;
  });
}

function strictEligibleCount(candidate: Candidate): number {
  const key = candidate.direction === "LONG"
    ? "availableExecutionEligibleAlignedLongs"
    : "availableExecutionEligibleAlignedShorts";
  const value = candidate.dynamic[key];
  return finite(value) ? value : candidate.selected.length;
}

function scanFrom(dynamic: Json) {
  return {
    featureTimestamp: String(dynamic.featureTimestamp),
    positiveCount: Number(dynamic.positiveCount),
    negativeCount: Number(dynamic.negativeCount),
    zeroCount: Number(dynamic.zeroCount),
  };
}

function summary(rows: Array<{ featureMs: number; passed: boolean; reason: string; outcomeNetReturn: number | null }>) {
  const closed = rows.flatMap((row) => row.outcomeNetReturn === null ? [] : [{ featureMs: row.featureMs, netReturn: row.outcomeNetReturn }]);
  const returns = closed.map((row) => row.netReturn);
  const positive = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const negative = returns.filter((value) => value < 0).reduce((sum, value) => sum + Math.abs(value), 0);
  const count = (predicate: (row: typeof rows[number]) => boolean) => rows.filter(predicate).length;
  return {
    formations: rows.length,
    v1Admitted: count((row) => row.passed),
    v1Rejected: count((row) => !row.passed),
    admissionRate: rows.length ? count((row) => row.passed) / rows.length : null,
    strongReversalVetoes: count((row) => row.reason === "ONE_SIDED_STRONG_REVERSAL_CONFLICT"),
    rejectionReasons: Object.fromEntries([...new Set(rows.filter((row) => !row.passed).map((row) => row.reason))].map((reason) => [reason, count((row) => row.reason === reason)])),
    closedOutcomeN: closed.length,
    outcomeMean: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    outcomeMedian: median(returns),
    outcomePF: negative > 0 ? positive / negative : positive > 0 ? null : 0,
    outcomeCVaR5: cvar5(returns),
    outcomeMaxDrawdown: maxDrawdown(closed),
  };
}

const inputs = await parseInputs();
const allObservations: Array<{ source: string; observation: Json; dynamic: Json }> = [];
const candidates: Candidate[] = [];
for (const input of inputs) {
  const baskets = new Map<string, Json>((input.executor.baskets ?? []).map((basket: Json) => [basket.sourceObservationId, basket]));
  for (const observation of input.edge.observations ?? []) {
    const dynamic = observation?.dynamicMom36;
    const feature = featureMs(dynamic);
    if (!dynamic || feature === null) continue;
    allObservations.push({ source: input.label, observation, dynamic });
    const direction = finalDirection(dynamic);
    if (!direction) continue;
    const selected = direction === "LONG" ? dynamic.selectedLongs : dynamic.selectedShorts;
    if (!Array.isArray(selected) || !selected.every((value) => typeof value === "string")) continue;
    candidates.push({
      source: input.label,
      sourceObservationId: String(observation.observationId ?? ""),
      observation,
      dynamic,
      executorBasket: baskets.get(observation.observationId) ?? null,
      featureMs: feature,
      direction,
      selected: [...selected],
    });
  }
}

const uniqueCandidateMap = new Map<string, Candidate>();
for (const candidate of candidates) {
  const key = candidateKey(candidate);
  const existing = uniqueCandidateMap.get(key);
  if (!existing || executionPriority(candidate) > executionPriority(existing) ||
    (executionPriority(candidate) === executionPriority(existing) && candidate.source === "live")) {
    uniqueCandidateMap.set(key, candidate);
  }
}
const uniqueCandidates = [...uniqueCandidateMap.values()].sort((a, b) => a.featureMs - b.featureMs);

const scanMap = new Map<string, Json>();
for (const row of allObservations) {
  const feature = featureMs(row.dynamic);
  if (feature === null) continue;
  const existing = scanMap.get(String(feature));
  if (!existing || row.source === "live") scanMap.set(String(feature), row.dynamic);
}
const historicalScans = [...scanMap.values()].sort((a, b) => featureMs(a)! - featureMs(b)!);

const symbols = new Set(["BTCUSDT", "ETHUSDT"]);
for (const candidate of uniqueCandidates) candidate.selected.forEach((symbol) => symbols.add(symbol));
const startMs = Math.min(...uniqueCandidates.map((candidate) => candidate.featureMs)) - 6 * HOUR_MS;
const endMs = Math.max(...uniqueCandidates.map((candidate) => candidate.featureMs));
const candlesBySymbol = new Map<string, Map<number, number>>();
for (const symbol of [...symbols].sort()) candlesBySymbol.set(symbol, await fetchSymbolCandles(symbol, startMs, endMs));

const rows = uniqueCandidates.map((candidate) => {
  const selectedReturns = Object.fromEntries(candidate.selected.map((symbol) => [symbol, returnAt(candlesBySymbol.get(symbol), candidate.featureMs, 1)]));
  const quality = evaluateOneSidedDirectionalQuality({
    direction: candidate.direction,
    selected: candidate.selected.map((symbol) => ({ symbol })),
    strictEligibleCount: strictEligibleCount(candidate),
    context: {
      breadthScans: historicalScans.filter((scan) => featureMs(scan)! <= candidate.featureMs).map(scanFrom),
      btcFast4hReturn: returnAt(candlesBySymbol.get("BTCUSDT"), candidate.featureMs, 4),
      ethFast4hReturn: returnAt(candlesBySymbol.get("ETHUSDT"), candidate.featureMs, 4),
      selectedOneHourReturnBySymbol: selectedReturns,
      absMom36PercentileBySymbol: {},
      percentileWindowHours: null,
      percentileRequiredWindowHours: 90 * 24,
      percentileSource: null,
    },
    continuationDecision: candidate.dynamic.continuation?.decision ?? "UNAVAILABLE",
    shockState: candidate.dynamic.shockState ?? "UNAVAILABLE",
  });
  return {
    source: candidate.source,
    sourceObservationId: candidate.sourceObservationId,
    basketId: candidate.executorBasket?.basketId ?? null,
    formationId: candidate.dynamic.formationId ?? null,
    featureTimestamp: new Date(candidate.featureMs).toISOString(),
    direction: candidate.direction,
    selected: candidate.selected,
    strictSelected: strictSelected(candidate),
    strictEligibleCount: strictEligibleCount(candidate),
    priorCapturedBreadthScanN: historicalScans.filter((scan) => featureMs(scan)! < candidate.featureMs).length,
    score: quality.score,
    decision: quality.decision,
    reason: quality.reason,
    components: {
      breadth: quality.components.breadthPersistence.score,
      depth: quality.components.strictEligibleDepth.score,
      macro: quality.components.btcEthAlignment.score,
      trajectory: quality.components.selectedTrajectory.score,
      model: quality.components.modelSupport.score,
      exhaustion: quality.components.exhaustionRisk.score,
    },
    reversal: quality.strongReversal,
    btcFast4hReturn: quality.components.btcEthAlignment.btcFast4hReturn,
    ethFast4hReturn: quality.components.btcEthAlignment.ethFast4hReturn,
    selectedMedian1h: quality.components.selectedTrajectory.medianOneHourReturn,
    selectedAlignedCount: quality.components.selectedTrajectory.alignedCount,
    modelRaw: {
      continuation: quality.components.modelSupport.continuationDecision,
      shock: quality.components.modelSupport.shockState,
    },
    outcomeState: outcomeState(candidate),
    outcomeNetReturn: realizedReturn(candidate),
    outcomeCloseReason: candidate.executorBasket?.closeReason ?? candidate.observation?.exitReason ?? null,
  };
});

const byDirection = {
  long: rows.filter((row) => row.direction === "LONG"),
  short: rows.filter((row) => row.direction === "SHORT"),
};
const byDecision = {
  pass: rows.filter((row) => row.decision === "PASS"),
  reject: rows.filter((row) => row.decision === "REJECT"),
};
const recentLoss = rows.find((row) => row.basketId === "xb-mte7ph2r-6shock") ?? null;

console.log(JSON.stringify({
  policy: "one-sided-directional-quality-v1",
  readOnly: true,
  limitations: {
    historicalFormationCoverage: "The pre-V6.2 store retained executed Dynamic MOM36 observations, not every rejected canonical scan. Breadth is reconstructed only from those captured observations.",
    exhaustion: "Historical 90d MOM36 percentile is unavailable in the pre-deploy store, therefore F is neutral exactly as the V1 missing-data rule requires.",
    outcome: "Only actual closed baskets expose realized net return. Pre-deploy data does not retain canonical MFE/MAE for every historical one-sided formation.",
  },
  inputs: inputs.map((input) => input.label),
  observedRowsBeforeDedup: candidates.length,
  uniqueOneSidedFormations: rows.length,
  directionCounts: { long: byDirection.long.length, short: byDirection.short.length },
  currentPolicyAdmitted: rows.length,
  v1: summary(rows.map((row) => ({ featureMs: Date.parse(row.featureTimestamp), passed: row.decision === "PASS", reason: row.reason, outcomeNetReturn: row.outcomeNetReturn }))),
  passOutcome: summary(byDecision.pass.map((row) => ({ featureMs: Date.parse(row.featureTimestamp), passed: true, reason: row.reason, outcomeNetReturn: row.outcomeNetReturn }))),
  rejectOutcome: summary(byDecision.reject.map((row) => ({ featureMs: Date.parse(row.featureTimestamp), passed: false, reason: row.reason, outcomeNetReturn: row.outcomeNetReturn }))),
  scoreDistribution: Object.fromEntries([...new Set(rows.map((row) => String(row.score)))].sort((a, b) => Number(a) - Number(b)).map((score) => [score, rows.filter((row) => String(row.score) === score).length])),
  recentLoss,
  rows,
}, null, 2));
