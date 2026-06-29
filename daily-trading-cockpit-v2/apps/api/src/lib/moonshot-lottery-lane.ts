/**
 * MOONSHOT_LOTTERY_LANE — an experimental "sniper slot machine with a seatbelt".
 *
 * NOT a universal edge. A controlled lottery lane: many tiny losses are acceptable, rare violent
 * wins are the target, a single-position margin call is acceptable, ACCOUNT-LEVEL damage is NOT.
 *
 * v1 SCOPE (this module): SIGNAL + POLICY only — scoring, risk, tiered-leverage selection, daily
 * budget guard, and the emitted signal object. It NEVER places orders: the existing execution/risk
 * engine consumes the signal. Report-only, env-gated, LONG-only. Brutal is allowed; unbounded is not.
 *
 * The hard SAFETY rules (position caps, isolated-only, no averaging/martingale, daily budgets, the
 * leverage ceiling = min(requested, Binance symbol max), the minNotional check) are encoded exactly
 * as specified. The SCORE/RISK formulas are a reasonable, fully-tunable interpretation of the listed
 * components — weights/thresholds are env-overridable so they can be calibrated, not guessed-forever.
 */

function envNum(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

// ── lane config (spec: POSITION RULES) ───────────────────────────────────────
export const MOONSHOT_LANE_ID = "MOONSHOT_LOTTERY" as const;
export const MOONSHOT_SIDE = "LONG" as const; // v1 LONG only
export const MOONSHOT_MARGIN_MODE = "ISOLATED" as const; // cross forbidden
export const MOONSHOT_MAX_ACTIVE_POSITIONS = 1;
export const MOONSHOT_MARGIN_USDT = envNum("MOONSHOT_MARGIN_USDT", 1); // max margin per trade
export const MOONSHOT_MAX_TRADES_PER_DAY = envNum("MOONSHOT_MAX_TRADES_PER_DAY", 10);
export const MOONSHOT_MAX_DAILY_LOSS_USDT = envNum("MOONSHOT_MAX_DAILY_LOSS_USDT", 10);
export const MOONSHOT_MAX_100X_PER_DAY = envNum("MOONSHOT_MAX_100X_PER_DAY", 2);
export const MOONSHOT_MAX_50X_PLUS_PER_DAY = envNum("MOONSHOT_MAX_50X_PLUS_PER_DAY", 4);

// ── gate thresholds (spec: TRADE GATE / SNIPER GATE) ─────────────────────────
export const MOONSHOT_SCORE_MIN = envNum("MOONSHOT_SCORE_MIN", 82);
export const MOONSHOT_RISK_MAX = envNum("MOONSHOT_RISK_MAX", 45);
export const MOONSHOT_MAX_SPREAD_BPS = envNum("MOONSHOT_MAX_SPREAD_BPS", 8);
export const MOONSHOT_MIN_DEPTH_USD = envNum("MOONSHOT_MIN_DEPTH_USD", 20_000);
export const MOONSHOT_BTC_DUMP_1M_PCT = envNum("MOONSHOT_BTC_DUMP_1M_PCT", -0.4); // BTC down >0.4%/1m = dumping
export const MOONSHOT_MARK_DIVERGENCE_MAX_BPS = envNum("MOONSHOT_MARK_DIVERGENCE_MAX_BPS", 30);
export const MOONSHOT_FUNDING_EXTREME = envNum("MOONSHOT_FUNDING_EXTREME", 0.0015); // |funding| > 0.15%
export const MOONSHOT_ALREADY_PUMPED_5M_PCT = envNum("MOONSHOT_ALREADY_PUMPED_5M_PCT", 12); // +12%/5m = chased

// sniper (100x) gate
export const MOONSHOT_SNIPER_SCORE_MIN = envNum("MOONSHOT_SNIPER_SCORE_MIN", 97);
export const MOONSHOT_SNIPER_RISK_MAX = envNum("MOONSHOT_SNIPER_RISK_MAX", 20);
export const MOONSHOT_SNIPER_MAX_SPREAD_BPS = envNum("MOONSHOT_SNIPER_MAX_SPREAD_BPS", 3);
export const MOONSHOT_SNIPER_MIN_DEPTH_USD = envNum("MOONSHOT_SNIPER_MIN_DEPTH_USD", 60_000);
export const MOONSHOT_SNIPER_MIN_OI_DELTA_PCT = envNum("MOONSHOT_SNIPER_MIN_OI_DELTA_PCT", 3);
export const MOONSHOT_SNIPER_MIN_TAKER_RATIO = envNum("MOONSHOT_SNIPER_MIN_TAKER_RATIO", 1.8);

export const MOONSHOT_MAX_SLIPPAGE_BPS = envNum("MOONSHOT_MAX_SLIPPAGE_BPS", 20);

// ── leverage tiers (spec: LEVERAGE RULES) ────────────────────────────────────
interface LeverageTier {
  minScore: number;
  leverage: number;
  maxHoldSeconds: number;
}
// Highest score first so the first match wins.
const MOONSHOT_LEVERAGE_TIERS: readonly LeverageTier[] = [
  { minScore: 97, leverage: 100, maxHoldSeconds: 45 }, // sniper mode
  { minScore: 94, leverage: 75, maxHoldSeconds: 90 },
  { minScore: 90, leverage: 50, maxHoldSeconds: 90 },
  { minScore: 86, leverage: 35, maxHoldSeconds: 90 },
  { minScore: 82, leverage: 20, maxHoldSeconds: 90 },
];

export function isMoonshotLotteryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MOONSHOT_LOTTERY_ENABLED === "1";
}

// ── feature input (spec: SIGNAL INPUT FEATURES) ──────────────────────────────
export interface MoonshotFeatures {
  symbol: string;
  priceChange1mPct: number;
  priceChange3mPct: number;
  priceChange5mPct: number;
  volumeRatio1m: number; // current 1m volume / its recent average (1 = average)
  takerBuySellRatio: number; // >1 = buy-dominant
  oiDelta3mPct: number; // open-interest change over 3m, percent
  fundingRate: number; // fraction, e.g. 0.0005 = 0.05%
  spreadBps: number;
  depth05PctUsd: number; // resting USD within 0.5% of mid
  depth1PctUsd: number; // resting USD within 1% of mid
  btc1mPct: number; // BTC 1m return, percent (guard)
  markVsLastDivergenceBps: number; // |mark − last| / last, bps
  minNotionalUsd: number; // symbol minNotional
  maxLeverage: number; // symbol max allowed leverage (Binance bracket)
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
/** Map x in [lo,hi] → [0,1], clamped. */
const ramp = (x: number, lo: number, hi: number): number => (hi === lo ? 0 : clamp((x - lo) / (hi - lo), 0, 1));

export interface MoonshotScoreBreakdown {
  score: number;
  components: {
    volumeBurst: number;
    takerBuyPressure: number;
    oiExpansion: number;
    breakout: number;
    relativeStrengthVsBtc: number;
    freshMomentum: number;
  };
  penalties: {
    alreadyPumped: number;
    spreadWide: number;
    fundingExtreme: number;
    btcDumping: number;
    markDivergence: number;
  };
}

/** MOONSHOT SCORE — bullish-burst evidence minus chase/structure penalties. 0–100. */
export function computeMoonshotScore(f: MoonshotFeatures): MoonshotScoreBreakdown {
  const components = {
    volumeBurst: 22 * ramp(f.volumeRatio1m, 2, 8), // 2x→8x average volume
    takerBuyPressure: 18 * ramp(f.takerBuySellRatio, 1.2, 2.5),
    oiExpansion: 16 * ramp(f.oiDelta3mPct, 0.5, 4), // OI building
    breakout: 20 * ramp(f.priceChange1mPct, 0.3, 2.5), // fresh 1m thrust
    relativeStrengthVsBtc: 14 * ramp(f.priceChange1mPct - f.btc1mPct, 0.2, 2),
    freshMomentum: 10 * ramp(f.priceChange1mPct - f.priceChange5mPct / 5, 0.2, 1.5), // 1m rate > 5m avg rate ⇒ accelerating
  };
  const penalties = {
    alreadyPumped: 18 * ramp(f.priceChange5mPct, MOONSHOT_ALREADY_PUMPED_5M_PCT, MOONSHOT_ALREADY_PUMPED_5M_PCT + 15),
    spreadWide: 14 * ramp(f.spreadBps, MOONSHOT_MAX_SPREAD_BPS * 0.6, MOONSHOT_MAX_SPREAD_BPS * 2),
    fundingExtreme: 10 * ramp(Math.abs(f.fundingRate), MOONSHOT_FUNDING_EXTREME * 0.5, MOONSHOT_FUNDING_EXTREME * 2),
    btcDumping: 16 * ramp(-f.btc1mPct, -MOONSHOT_BTC_DUMP_1M_PCT * 0.5, -MOONSHOT_BTC_DUMP_1M_PCT * 2),
    markDivergence: 10 * ramp(f.markVsLastDivergenceBps, MOONSHOT_MARK_DIVERGENCE_MAX_BPS * 0.5, MOONSHOT_MARK_DIVERGENCE_MAX_BPS * 1.5),
  };
  const raw =
    Object.values(components).reduce((a, b) => a + b, 0) -
    Object.values(penalties).reduce((a, b) => a + b, 0);
  return { score: clamp(raw, 0, 100), components, penalties };
}

export interface MoonshotRiskBreakdown {
  score: number;
  components: {
    wideSpread: number;
    thinDepth: number;
    fundingOverheated: number;
    alreadyPumped: number;
    markDivergence: number;
    btcDumping: number;
    oiSpikeNoFollowThrough: number;
  };
}

/** RISK SCORE — Binance-only liquidity/manipulation risk (NOT an on-chain rug detector). 0–100. */
export function computeMoonshotRiskScore(f: MoonshotFeatures): MoonshotRiskBreakdown {
  // OI spiking hard while price/volume DON'T confirm = a manipulation/squeeze-bait smell.
  const oiSpikeNoFollow = ramp(f.oiDelta3mPct, 3, 8) * (1 - ramp(f.priceChange3mPct, 0.5, 2)) * (1 - ramp(f.volumeRatio1m, 2, 5));
  const components = {
    wideSpread: 22 * ramp(f.spreadBps, MOONSHOT_MAX_SPREAD_BPS * 0.5, MOONSHOT_MAX_SPREAD_BPS * 2),
    thinDepth: 22 * (1 - ramp(Math.min(f.depth05PctUsd, f.depth1PctUsd), MOONSHOT_MIN_DEPTH_USD * 0.5, MOONSHOT_MIN_DEPTH_USD * 2.5)),
    fundingOverheated: 14 * ramp(Math.abs(f.fundingRate), MOONSHOT_FUNDING_EXTREME * 0.5, MOONSHOT_FUNDING_EXTREME * 2),
    alreadyPumped: 16 * ramp(f.priceChange5mPct, MOONSHOT_ALREADY_PUMPED_5M_PCT * 0.7, MOONSHOT_ALREADY_PUMPED_5M_PCT + 18),
    markDivergence: 14 * ramp(f.markVsLastDivergenceBps, MOONSHOT_MARK_DIVERGENCE_MAX_BPS * 0.5, MOONSHOT_MARK_DIVERGENCE_MAX_BPS * 1.5),
    btcDumping: 16 * ramp(-f.btc1mPct, -MOONSHOT_BTC_DUMP_1M_PCT * 0.5, -MOONSHOT_BTC_DUMP_1M_PCT * 2),
    oiSpikeNoFollowThrough: 16 * oiSpikeNoFollow,
  };
  return { score: clamp(Object.values(components).reduce((a, b) => a + b, 0), 0, 100), components };
}

// ── leverage selector (spec: LEVERAGE RULES) ─────────────────────────────────
export interface MoonshotLeverageResult {
  requestedLeverage: number;
  finalLeverage: number;
  tier: LeverageTier | null;
  /** true once leverage is capped by the Binance symbol max. */
  cappedBySymbol: boolean;
}

/** Tier the leverage by score, then HARD-cap at the symbol's Binance max. */
export function selectMoonshotLeverage(score: number, maxSymbolLeverage: number): MoonshotLeverageResult {
  const tier = MOONSHOT_LEVERAGE_TIERS.find((t) => score >= t.minScore) ?? null;
  if (!tier) return { requestedLeverage: 0, finalLeverage: 0, tier: null, cappedBySymbol: false };
  const requested = tier.leverage;
  const final = Math.max(0, Math.min(requested, Math.floor(maxSymbolLeverage)));
  return { requestedLeverage: requested, finalLeverage: final, tier, cappedBySymbol: final < requested };
}

// ── daily budget state (spec: daily budget guard) ────────────────────────────
export interface MoonshotDailyState {
  dateUtc: string;
  tradesToday: number;
  trades100xToday: number;
  trades50xPlusToday: number;
  dailyRealizedLossUsdt: number; // positive number = USD lost today
  activePositions: number;
}

export function emptyMoonshotDailyState(dateUtc: string): MoonshotDailyState {
  return { dateUtc, tradesToday: 0, trades100xToday: 0, trades50xPlusToday: 0, dailyRealizedLossUsdt: 0, activePositions: 0 };
}

// ── trade gate + signal contract ─────────────────────────────────────────────
export interface MoonshotSignal {
  lane: typeof MOONSHOT_LANE_ID;
  symbol: string;
  side: typeof MOONSHOT_SIDE;
  marginUsdt: number;
  marginMode: typeof MOONSHOT_MARGIN_MODE;
  requestedLeverage: number;
  finalLeverage: number;
  moonshotScore: number;
  riskScore: number;
  maxHoldSeconds: number;
  tpPlan: { tp1Roe: number; tp1ClosePct: number; tp2Roe: number; tp2ClosePct: number; runnerPct: number };
  entryPolicy: { type: "LIMIT_IOC"; maxSlippageBps: number };
  reason: string[];
}

export interface MoonshotEvaluation {
  decision: "SIGNAL" | "REJECT";
  signal: MoonshotSignal | null;
  rejectReasons: string[];
  moonshotScore: number;
  riskScore: number;
  leverage: MoonshotLeverageResult;
  isSniper: boolean;
}

function notionalUsd(marginUsdt: number, leverage: number): number {
  return marginUsdt * leverage;
}

/** The full gate. Returns a signal object only if EVERY hard rule passes. Never executes anything. */
export function evaluateMoonshot(f: MoonshotFeatures, daily: MoonshotDailyState): MoonshotEvaluation {
  const { score } = computeMoonshotScore(f);
  const { score: riskScore } = computeMoonshotRiskScore(f);
  const lev = selectMoonshotLeverage(score, f.maxLeverage);
  const isSniper = lev.finalLeverage >= 100;
  const reject: string[] = [];

  // ── universal trade gate ──
  if (score < MOONSHOT_SCORE_MIN) reject.push(`moonshotScore ${score.toFixed(1)} < ${MOONSHOT_SCORE_MIN}`);
  if (riskScore > MOONSHOT_RISK_MAX) reject.push(`riskScore ${riskScore.toFixed(1)} > ${MOONSHOT_RISK_MAX}`);
  if (daily.activePositions >= MOONSHOT_MAX_ACTIVE_POSITIONS) reject.push("existing moonshot position open");
  if (daily.tradesToday >= MOONSHOT_MAX_TRADES_PER_DAY) reject.push(`trades today >= ${MOONSHOT_MAX_TRADES_PER_DAY}`);
  if (daily.dailyRealizedLossUsdt >= MOONSHOT_MAX_DAILY_LOSS_USDT) reject.push(`daily moonshot loss >= ${MOONSHOT_MAX_DAILY_LOSS_USDT} USDT`);
  if (lev.tier === null || lev.finalLeverage <= 0) reject.push("no leverage tier / final leverage 0");
  // Binance: final notional must clear minNotional with the 1 USDT margin. (Leverage is CAPPED to the
  // symbol max in selectMoonshotLeverage — capping, not rejection, per spec "finalLeverage = min(...)";
  // by construction finalLeverage can never exceed the symbol max, so there is no leverage-over-max reject.)
  if (notionalUsd(MOONSHOT_MARGIN_USDT, lev.finalLeverage) < f.minNotionalUsd) {
    reject.push(`notional ${notionalUsd(MOONSHOT_MARGIN_USDT, lev.finalLeverage).toFixed(2)} < minNotional ${f.minNotionalUsd}`);
  }
  if (f.spreadBps > MOONSHOT_MAX_SPREAD_BPS) reject.push(`spread ${f.spreadBps}bps too wide`);
  if (Math.min(f.depth05PctUsd, f.depth1PctUsd) < MOONSHOT_MIN_DEPTH_USD) reject.push("depth too thin");
  if (f.btc1mPct <= MOONSHOT_BTC_DUMP_1M_PCT) reject.push("BTC dumping");
  if (f.markVsLastDivergenceBps > MOONSHOT_MARK_DIVERGENCE_MAX_BPS) reject.push("mark price divergence dangerous");

  // per-tier daily caps
  if (lev.finalLeverage >= 50 && daily.trades50xPlusToday >= MOONSHOT_MAX_50X_PLUS_PER_DAY) reject.push(`50x+ trades today >= ${MOONSHOT_MAX_50X_PLUS_PER_DAY}`);

  // ── sniper (100x) extra gate ──
  if (isSniper) {
    if (score < MOONSHOT_SNIPER_SCORE_MIN) reject.push(`sniper: score < ${MOONSHOT_SNIPER_SCORE_MIN}`);
    if (riskScore > MOONSHOT_SNIPER_RISK_MAX) reject.push(`sniper: risk > ${MOONSHOT_SNIPER_RISK_MAX}`);
    if (f.spreadBps > MOONSHOT_SNIPER_MAX_SPREAD_BPS) reject.push("sniper: spread not tight enough");
    if (Math.min(f.depth05PctUsd, f.depth1PctUsd) < MOONSHOT_SNIPER_MIN_DEPTH_USD) reject.push("sniper: depth not strong enough");
    if (f.oiDelta3mPct < MOONSHOT_SNIPER_MIN_OI_DELTA_PCT) reject.push("sniper: OI delta not strong enough");
    if (f.takerBuySellRatio < MOONSHOT_SNIPER_MIN_TAKER_RATIO) reject.push("sniper: taker buy/sell not strong enough");
    if (f.priceChange5mPct >= MOONSHOT_ALREADY_PUMPED_5M_PCT) reject.push("sniper: already pumped too much");
    if (daily.trades100xToday >= MOONSHOT_MAX_100X_PER_DAY) reject.push(`sniper: 100x trades today >= ${MOONSHOT_MAX_100X_PER_DAY}`);
  }

  if (reject.length > 0) {
    return { decision: "REJECT", signal: null, rejectReasons: reject, moonshotScore: score, riskScore, leverage: lev, isSniper };
  }

  const tpPlan = isSniper
    ? { tp1Roe: 90, tp1ClosePct: 0.5, tp2Roe: 215, tp2ClosePct: 0.3, runnerPct: 0.2 }
    : { tp1Roe: 100, tp1ClosePct: 0.4, tp2Roe: 250, tp2ClosePct: 0.4, runnerPct: 0.2 };

  const reason: string[] = [];
  const sc = computeMoonshotScore(f).components;
  if (sc.volumeBurst > 8) reason.push("volume burst");
  if (sc.takerBuyPressure > 7) reason.push("taker buy pressure");
  if (sc.oiExpansion > 6) reason.push("OI expansion");
  if (sc.breakout > 8) reason.push("breakout");
  if (f.spreadBps <= MOONSHOT_MAX_SPREAD_BPS) reason.push("spread acceptable");
  if (Math.min(f.depth05PctUsd, f.depth1PctUsd) >= MOONSHOT_MIN_DEPTH_USD) reason.push("depth acceptable");

  const signal: MoonshotSignal = {
    lane: MOONSHOT_LANE_ID,
    symbol: f.symbol,
    side: MOONSHOT_SIDE,
    marginUsdt: MOONSHOT_MARGIN_USDT,
    marginMode: MOONSHOT_MARGIN_MODE,
    requestedLeverage: lev.requestedLeverage,
    finalLeverage: lev.finalLeverage,
    moonshotScore: Number(score.toFixed(2)),
    riskScore: Number(riskScore.toFixed(2)),
    maxHoldSeconds: lev.tier!.maxHoldSeconds,
    tpPlan,
    entryPolicy: { type: "LIMIT_IOC", maxSlippageBps: MOONSHOT_MAX_SLIPPAGE_BPS },
    reason,
  };
  return { decision: "SIGNAL", signal, rejectReasons: [], moonshotScore: score, riskScore, leverage: lev, isSniper };
}
