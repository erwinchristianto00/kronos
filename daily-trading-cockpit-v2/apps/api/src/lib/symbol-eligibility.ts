/**
 * Objective eligibility criteria for the cross-sectional symbol pool.
 *
 * The allowlist this replaces had NO recorded rationale: 6 of its 8 exclusions passed every
 * objective test that could be found, and 6 of its 17 inclusions turned out to be significant
 * negative contributors. A list with no criterion is not a risk control — it is a preference that
 * nobody can audit or update.
 *
 * DESIGN GUARANTEE: this function cannot see performance. `SymbolEligibilityInput` has no field for
 * P&L, return, dispersion or win rate, and that is deliberate rather than incidental — every
 * previous attempt in this codebase to pick symbols by how they had performed (the adaptive
 * demotion frozen 2026-08-15; the allowlist itself) either cost edge or could not be justified
 * afterwards. Eligibility answers "can this symbol be traded correctly", never "did it make money".
 *
 * UNKNOWN FAILS. A missing measurement is not a pass. An unverifiable symbol is excluded and the
 * reason says so, matching the rest of this codebase's convention that an unlabelled thing is not
 * evidence of a good one.
 *
 * Pure and import-free.
 */

export interface SymbolEligibilityInput {
  symbol: string;
  /** 24h quote volume in USD, as the exchange reports it. */
  quoteVolume24hUsd: number | null;
  /** Last price, for converting lot constraints into notional. */
  price: number | null;
  /** Exchange MIN_NOTIONAL filter, USD. */
  minNotionalUsd: number | null;
  /** LOT_SIZE stepSize and minQty, in base units. */
  stepSize: number | null;
  minQty: number | null;
  /** First tradable timestamp, epoch ms. */
  listedAtMs: number | null;
  /** MEDIAN absolute funding rate per funding period (not mean — one spike must not evict). */
  medianAbsFundingRatePerPeriod: number | null;
  /** Highest return-correlation against any symbol ALREADY accepted this pass, or null if first. */
  maxCorrelationToAccepted: number | null;
}

export interface EligibilityThresholds {
  /** C1 — execution cost. Already the deployed CROSS_SECTIONAL_LIQUIDITY_FLOOR_USD_PER_HOUR. */
  minLiquidityUsdPerHour: number;
  /** C2 — one minimum lot must not exceed this fraction of the target leg. */
  maxLotFractionOfLeg: number;
  targetLegUsd: number;
  /** C3 — enough history to be scored by the momentum window AND measured afterwards. */
  minListedDays: number;
  /** C4 — funding paid over one hold, in bps, and how many funding periods that hold spans. */
  maxFundingCarryBps: number;
  fundingPeriodsPerHold: number;
  /** C5 — two near-identical symbols are the same bet twice. */
  maxCorrelation: number;
}

/**
 * Defaults, each with the measurement that produced it — a threshold with no provenance is a
 * preference wearing a number's clothes.
 *
 *  C1 200_000/h  — the floor already deployed; unchanged so this cannot loosen an existing control.
 *  C2 0.50 of leg — measured 2026-08-15: sizing only ever rounds UP, so a symbol whose one lot
 *                   exceeds the target leg is lifted to a full lot. At a $26 leg that put AVAX at
 *                   +88% and UNI at +49% over target and drove basket imbalance from ~1% to 4.9-10%.
 *                   Half a leg leaves room for the rounding to land inside tolerance.
 *  C3 120 days    — MOM36 needs 36 bars to score and the evidence window needs far more; 120d is
 *                   the point where a symbol has enough history to be both ranked and audited.
 *  C4 8 bps/hold  — a 48h hold spans 6 funding periods. Measured across the universe, median carry
 *                   runs 1.7-6.0 bps, i.e. already up to 46% of the 13 bps round-trip cost model.
 *                   8 bps admits every symbol measured while excluding a genuine outlier.
 *  C5 0.95        — below outright duplication; two symbols above this move as one.
 */
export const DEFAULT_ELIGIBILITY: EligibilityThresholds = {
  minLiquidityUsdPerHour: 200_000,
  maxLotFractionOfLeg: 0.5,
  targetLegUsd: 26,
  minListedDays: 120,
  maxFundingCarryBps: 8,
  fundingPeriodsPerHold: 6,
  maxCorrelation: 0.95,
};

export type FailureCode = "C1_LIQUIDITY" | "C2_LOT_TOO_LARGE" | "C3_TOO_NEW" | "C4_FUNDING_CARRY" | "C5_REDUNDANT";

export interface EligibilityFailure {
  code: FailureCode;
  /** What was measured and what was required — so a report never has to re-derive it. */
  detail: string;
}

export interface EligibilityVerdict {
  symbol: string;
  eligible: boolean;
  failures: EligibilityFailure[];
  measured: {
    liquidityUsdPerHour: number | null;
    oneLotUsd: number | null;
    listedDays: number | null;
    fundingCarryBps: number | null;
    maxCorrelationToAccepted: number | null;
  };
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Smallest notional the exchange will actually accept for this symbol. */
export function oneLotNotionalUsd(input: Pick<SymbolEligibilityInput, "price" | "minNotionalUsd" | "stepSize" | "minQty">): number | null {
  if (!num(input.price) || input.price <= 0) return null;
  const step = num(input.stepSize) && input.stepSize > 0 ? input.stepSize : null;
  const minQ = num(input.minQty) && input.minQty > 0 ? input.minQty : null;
  if (step === null && minQ === null) return null;
  const qty = Math.max(step ?? 0, minQ ?? 0);
  const fromQty = qty * input.price;
  const fromNotional = num(input.minNotionalUsd) && input.minNotionalUsd > 0 ? input.minNotionalUsd : 0;
  return Math.max(fromQty, fromNotional);
}

export function evaluateSymbolEligibility(
  input: SymbolEligibilityInput,
  nowMs: number,
  thresholds: EligibilityThresholds = DEFAULT_ELIGIBILITY,
): EligibilityVerdict {
  const failures: EligibilityFailure[] = [];

  const liq = num(input.quoteVolume24hUsd) && input.quoteVolume24hUsd >= 0 ? input.quoteVolume24hUsd / 24 : null;
  if (liq === null) failures.push({ code: "C1_LIQUIDITY", detail: "volume tidak terukur" });
  else if (liq < thresholds.minLiquidityUsdPerHour) {
    failures.push({ code: "C1_LIQUIDITY", detail: `$${Math.round(liq).toLocaleString()}/jam < $${thresholds.minLiquidityUsdPerHour.toLocaleString()}` });
  }

  const lot = oneLotNotionalUsd(input);
  const lotCeiling = thresholds.maxLotFractionOfLeg * thresholds.targetLegUsd;
  if (lot === null) failures.push({ code: "C2_LOT_TOO_LARGE", detail: "filter lot/harga tidak terbaca" });
  else if (lot > lotCeiling) {
    failures.push({ code: "C2_LOT_TOO_LARGE", detail: `satu lot $${lot.toFixed(2)} > $${lotCeiling.toFixed(2)} (${(thresholds.maxLotFractionOfLeg * 100).toFixed(0)}% dari leg $${thresholds.targetLegUsd})` });
  }

  const listedDays = num(input.listedAtMs) && num(nowMs) ? (nowMs - input.listedAtMs) / 86_400_000 : null;
  if (listedDays === null) failures.push({ code: "C3_TOO_NEW", detail: "tanggal listing tidak diketahui" });
  else if (listedDays < thresholds.minListedDays) {
    failures.push({ code: "C3_TOO_NEW", detail: `${listedDays.toFixed(0)} hari < ${thresholds.minListedDays} hari` });
  }

  const carryBps = num(input.medianAbsFundingRatePerPeriod)
    ? Math.abs(input.medianAbsFundingRatePerPeriod) * thresholds.fundingPeriodsPerHold * 10_000
    : null;
  if (carryBps === null) failures.push({ code: "C4_FUNDING_CARRY", detail: "funding tidak terukur" });
  else if (carryBps > thresholds.maxFundingCarryBps) {
    failures.push({ code: "C4_FUNDING_CARRY", detail: `${carryBps.toFixed(1)} bps/hold > ${thresholds.maxFundingCarryBps} bps` });
  }

  // C5 is the only criterion where "no value" is legitimately a PASS: the first symbol evaluated
  // has nothing to be redundant against. Absence of a peer is not absence of a measurement.
  const corr = input.maxCorrelationToAccepted;
  if (num(corr) && corr > thresholds.maxCorrelation) {
    failures.push({ code: "C5_REDUNDANT", detail: `korelasi ${corr.toFixed(3)} > ${thresholds.maxCorrelation}` });
  }

  return {
    symbol: input.symbol,
    eligible: failures.length === 0,
    failures,
    measured: {
      liquidityUsdPerHour: liq,
      oneLotUsd: lot,
      listedDays,
      fundingCarryBps: carryBps,
      maxCorrelationToAccepted: num(corr) ? corr : null,
    },
  };
}

export interface PoolDiff {
  eligible: string[];
  added: string[];
  removed: string[];
  unchanged: string[];
  /** Why each removal happened, so a rotation is never silent. */
  removalReasons: Record<string, FailureCode[]>;
}

/** Compare an evaluated pool against the currently configured one. Pure bookkeeping. */
export function diffPool(verdicts: readonly EligibilityVerdict[], currentPool: readonly string[]): PoolDiff {
  const eligible = verdicts.filter((v) => v.eligible).map((v) => v.symbol);
  const eligibleSet = new Set(eligible);
  const currentSet = new Set(currentPool);
  const removalReasons: Record<string, FailureCode[]> = {};
  for (const v of verdicts) {
    if (!v.eligible && currentSet.has(v.symbol)) removalReasons[v.symbol] = v.failures.map((f) => f.code);
  }
  return {
    eligible,
    added: eligible.filter((s) => !currentSet.has(s)),
    removed: currentPool.filter((s) => !eligibleSet.has(s)),
    unchanged: eligible.filter((s) => currentSet.has(s)),
    removalReasons,
  };
}
