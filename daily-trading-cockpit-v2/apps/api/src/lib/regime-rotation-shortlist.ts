import {
  VARIANT_MATRIX_DEFINITIONS,
  type CurrentGuardVariantMatrixReport,
  type CurrentGuardVariantMatrixRow,
  type VariantBreakdownRow,
  type VariantMatrixVariantId,
} from "./current-guard-variant-matrix.js";

export type RotationShortlistSide = "bearish" | "bullish";
export type RotationShortlistVerdict = "ALLOW" | "WATCH" | "BLOCK";
export type RotationRegimeFamily = "BULLISH" | "BEARISH";
export type RotationDirection = "LONG" | "SHORT";

export interface RotationShortlistSymbol {
  symbol: string;
  n: number;
  netAvgR: number | null;
  pf: number | null;
  wr: number | null;
  score: number;
  verdict: RotationShortlistVerdict;
  reason: string;
}

export interface RotationShortlistLane {
  laneId: string;
  variantId: VariantMatrixVariantId;
  label: string;
  bearish: RotationShortlistSymbol[];
  bullish: RotationShortlistSymbol[];
}

export interface RegimeRotationShortlistReport {
  generatedAt: string;
  minAllowSample: number;
  minWatchSample: number;
  lanes: RotationShortlistLane[];
  bearishGlobal: RotationShortlistSymbol[];
  bullishGlobal: RotationShortlistSymbol[];
}

export interface RotationShortlistDecision {
  allowed: boolean;
  verdict: RotationShortlistVerdict | "NO_SHORTLIST";
  reason: string;
  match?: RotationShortlistSymbol;
}

const DEFAULT_MIN_ALLOW_SAMPLE = 10;
const DEFAULT_MIN_WATCH_SAMPLE = 5;
const DEFAULT_MAX_SYMBOLS_PER_SIDE = 8;
const MIN_ALLOW_NET_R = 0.025;
const MIN_WATCH_NET_R = 0;
const MIN_ALLOW_PF = 1.1;
const MIN_WATCH_PF = 1.0;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numeric(value: number | null | undefined, fallback = 0): number {
  return isFiniteNumber(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function rotationLaneIdForVariant(variantId: string): string {
  const definition = VARIANT_MATRIX_DEFINITIONS.find((candidate) => candidate.id === variantId);
  return definition?.longOnly
    ? `CG_LONG_VARIANT_MATRIX:${variantId}`
    : `CG_VARIANT_MATRIX:${variantId}`;
}

export function rotationRegimeFamilyForLabel(value: string | null | undefined): "BULLISH" | "BEARISH" | "MIXED" | "UNKNOWN" {
  const label = (value ?? "").toLowerCase();
  if (label.includes("mixed") || label.includes("chop") || label.includes("range") || label.includes("rotation") || label.includes("sideways")) {
    return "MIXED";
  }
  if (label.includes("bull") || label.includes("long")) return "BULLISH";
  if (label.includes("bear") || label.includes("short")) return "BEARISH";
  return "UNKNOWN";
}

function rowForAxisSymbol(rows: VariantBreakdownRow[] | null | undefined, axis: string): VariantBreakdownRow[] {
  return (rows ?? [])
    .filter((row) => row.key.toUpperCase().startsWith(`${axis}|`))
    .map((row) => ({ ...row, key: row.key.split("|").pop()?.toUpperCase() ?? row.key.toUpperCase() }));
}

function verdictFor(row: VariantBreakdownRow, minAllowSample: number, minWatchSample: number): { verdict: RotationShortlistVerdict; reason: string } {
  const net = numeric(row.netAvgR);
  const pf = row.pf;
  if (row.n >= minAllowSample && net >= MIN_ALLOW_NET_R && (pf === null || pf === undefined || pf >= MIN_ALLOW_PF)) {
    return { verdict: "ALLOW", reason: `allow: n>=${minAllowSample}, net>=${MIN_ALLOW_NET_R.toFixed(3)}R, PF>=${MIN_ALLOW_PF.toFixed(1)}` };
  }
  if (row.n >= minWatchSample && net > MIN_WATCH_NET_R && (pf === null || pf === undefined || pf >= MIN_WATCH_PF)) {
    return { verdict: "WATCH", reason: `watch: sample or PF below live allow bar` };
  }
  if (row.n < minWatchSample) return { verdict: "BLOCK", reason: `sample<${minWatchSample}` };
  if (!(net > MIN_WATCH_NET_R)) return { verdict: "BLOCK", reason: "non-positive axis-symbol edge" };
  return { verdict: "BLOCK", reason: "PF below watch bar" };
}

function scoreRow(row: VariantBreakdownRow): number {
  const net = numeric(row.netAvgR);
  const pf = row.pf === null || row.pf === undefined ? 1 : clamp(row.pf, 0, 8);
  const wr = row.wr === null || row.wr === undefined ? 0.5 : clamp(row.wr, 0, 1);
  const sample = Math.log10(Math.max(1, row.n));
  return net * 100 + (pf - 1) * 1.8 + (wr - 0.5) * 3 + sample * 0.8;
}

function buildSymbols(
  rows: VariantBreakdownRow[] | null | undefined,
  axis: "SHORT_BEARISH" | "LONG_BULLISH",
  minAllowSample: number,
  minWatchSample: number,
  maxSymbols: number,
): RotationShortlistSymbol[] {
  return rowForAxisSymbol(rows, axis)
    .map((row): RotationShortlistSymbol => {
      const verdict = verdictFor(row, minAllowSample, minWatchSample);
      return {
        symbol: row.key.toUpperCase(),
        n: row.n,
        netAvgR: row.netAvgR,
        pf: row.pf ?? null,
        wr: row.wr ?? null,
        score: scoreRow(row),
        verdict: verdict.verdict,
        reason: verdict.reason,
      };
    })
    .sort((left, right) => {
      const verdictRank = (v: RotationShortlistVerdict): number => v === "ALLOW" ? 2 : v === "WATCH" ? 1 : 0;
      const byVerdict = verdictRank(right.verdict) - verdictRank(left.verdict);
      return byVerdict !== 0 ? byVerdict : right.score - left.score;
    })
    .slice(0, maxSymbols);
}

function aggregateGlobal(lanes: RotationShortlistLane[], side: RotationShortlistSide): RotationShortlistSymbol[] {
  const bySymbol = new Map<string, {
    n: number;
    weightedNet: number;
    weightedPf: number;
    weightedWr: number;
    pfN: number;
    wrN: number;
    allowCount: number;
    watchCount: number;
    bestScore: number;
  }>();
  for (const lane of lanes) {
    for (const item of lane[side]) {
      const existing = bySymbol.get(item.symbol) ?? {
        n: 0,
        weightedNet: 0,
        weightedPf: 0,
        weightedWr: 0,
        pfN: 0,
        wrN: 0,
        allowCount: 0,
        watchCount: 0,
        bestScore: Number.NEGATIVE_INFINITY,
      };
      existing.n += item.n;
      existing.weightedNet += numeric(item.netAvgR) * item.n;
      if (item.pf !== null) {
        existing.weightedPf += item.pf * item.n;
        existing.pfN += item.n;
      }
      if (item.wr !== null) {
        existing.weightedWr += item.wr * item.n;
        existing.wrN += item.n;
      }
      if (item.verdict === "ALLOW") existing.allowCount += 1;
      if (item.verdict === "WATCH") existing.watchCount += 1;
      existing.bestScore = Math.max(existing.bestScore, item.score);
      bySymbol.set(item.symbol, existing);
    }
  }
  return Array.from(bySymbol.entries())
    .map(([symbol, item]): RotationShortlistSymbol => {
      const verdict: RotationShortlistVerdict = item.allowCount > 0 ? "ALLOW" : item.watchCount > 0 ? "WATCH" : "BLOCK";
      return {
        symbol,
        n: item.n,
        netAvgR: item.n > 0 ? item.weightedNet / item.n : null,
        pf: item.pfN > 0 ? item.weightedPf / item.pfN : null,
        wr: item.wrN > 0 ? item.weightedWr / item.wrN : null,
        score: item.bestScore,
        verdict,
        reason: verdict === "ALLOW" ? `${item.allowCount} lane allow` : verdict === "WATCH" ? `${item.watchCount} lane watch` : "no lane allow",
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, DEFAULT_MAX_SYMBOLS_PER_SIDE);
}

export function buildRegimeRotationShortlistReport(
  report: CurrentGuardVariantMatrixReport,
  options: {
    generatedAt?: string;
    minAllowSample?: number;
    minWatchSample?: number;
    maxSymbolsPerSide?: number;
  } = {},
): RegimeRotationShortlistReport {
  const minAllowSample = options.minAllowSample ?? DEFAULT_MIN_ALLOW_SAMPLE;
  const minWatchSample = options.minWatchSample ?? DEFAULT_MIN_WATCH_SAMPLE;
  const maxSymbolsPerSide = options.maxSymbolsPerSide ?? DEFAULT_MAX_SYMBOLS_PER_SIDE;
  const rows = report.rows as Array<CurrentGuardVariantMatrixRow & { byAxisSymbol?: VariantBreakdownRow[] }>;
  const lanes = rows.map((row): RotationShortlistLane => ({
    laneId: rotationLaneIdForVariant(row.variantId),
    variantId: row.variantId,
    label: row.label,
    bearish: buildSymbols(row.byAxisSymbol, "SHORT_BEARISH", minAllowSample, minWatchSample, maxSymbolsPerSide),
    bullish: buildSymbols(row.byAxisSymbol, "LONG_BULLISH", minAllowSample, minWatchSample, maxSymbolsPerSide),
  }));
  return {
    generatedAt: options.generatedAt ?? report.computedAt,
    minAllowSample,
    minWatchSample,
    lanes,
    bearishGlobal: aggregateGlobal(lanes, "bearish"),
    bullishGlobal: aggregateGlobal(lanes, "bullish"),
  };
}

/** Whether the shortlist has ANY symbol for the family at all. An EMPTY family means the local
 *  VM book has no data to rank from (live never accrues VM observations) — that is "no data",
 *  not "no good symbols", and callers should fall back to the /research curation whitelist
 *  instead of vetoing everything (2026-07-08: live opened ZERO trades in an extended-bear regime
 *  because its local shortlist was structurally empty). */
export function rotationShortlistFamilyHasSymbols(
  report: RegimeRotationShortlistReport,
  family: "BULLISH" | "BEARISH",
): boolean {
  const key = family === "BULLISH" ? "bullish" : "bearish";
  if ((family === "BULLISH" ? report.bullishGlobal : report.bearishGlobal).length > 0) return true;
  return report.lanes.some((lane) => lane[key].length > 0);
}

export function rotationShortlistDecision(
  report: RegimeRotationShortlistReport | null | undefined,
  input: {
    laneId?: string | null;
    variantId?: string | null;
    symbol: string;
    direction: RotationDirection;
    regimeFamily: RotationRegimeFamily | "MIXED" | "UNKNOWN" | null;
  },
): RotationShortlistDecision {
  if (!report) return { allowed: false, verdict: "NO_SHORTLIST", reason: "rotation_shortlist_unavailable" };
  const side: RotationShortlistSide | null =
    input.direction === "SHORT" && input.regimeFamily === "BEARISH"
      ? "bearish"
      : input.direction === "LONG" && input.regimeFamily === "BULLISH"
        ? "bullish"
        : null;
  if (!side) return { allowed: false, verdict: "NO_SHORTLIST", reason: "not_bullish_or_bearish_rotation_context" };
  const laneId = input.laneId ?? (input.variantId ? rotationLaneIdForVariant(input.variantId) : null);
  const lane = report.lanes.find((candidate) =>
    (laneId && candidate.laneId === laneId) ||
    (input.variantId && candidate.variantId === input.variantId)
  );
  if (!lane) return { allowed: false, verdict: "NO_SHORTLIST", reason: "lane_not_in_rotation_shortlist" };
  const symbol = input.symbol.toUpperCase();
  const match = lane[side].find((candidate) => candidate.symbol === symbol) ?? null;
  if (!match) return { allowed: false, verdict: "NO_SHORTLIST", reason: `symbol_not_shortlisted:${side}` };
  return {
    allowed: match.verdict === "ALLOW",
    verdict: match.verdict,
    reason: match.reason,
    match,
  };
}
