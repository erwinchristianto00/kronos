/**
 * Operator-approved Daily Range candidates.
 *
 * The meme taxonomy remains the dynamic base.  The explicit supplemental list
 * below is a separate operator-approved extension; it does not bypass C1-C6,
 * native exchange checks, or cross-lane ownership.  Radar additions still
 * require a Meme category before they can enter automatically.
 */
import { getNewCoinRadarStore } from "./new-coin-radar.js";

export const DAILY_RANGE_APPROVED_UNIVERSE_POLICY_ID = "DAILY_RANGE_APPROVED_MEME_PLUS_SUPPLEMENTAL_V2" as const;

export const DAILY_RANGE_MEME_BASE_SYMBOLS = [
  "1000PEPEUSDT",
  "DOGEUSDT",
  "1000SHIBUSDT",
  "1000BONKUSDT",
  "WIFUSDT",
  "1000FLOKIUSDT",
  "MEMEUSDT",
  "BOMEUSDT",
  "POPCATUSDT",
  "PNUTUSDT",
  "NEIROUSDT",
  "MEWUSDT",
  "1000SATSUSDT",
  "1000RATSUSDT",
  "ACTUSDT",
  "GOATUSDT",
  "MOODENGUSDT",
  "TURBOUSDT",
  "DOGSUSDT",
  "1MBABYDOGEUSDT",
  "TRUMPUSDT",
  "FARTCOINUSDT",
  "PENGUUSDT",
  "CHILLGUYUSDT",
  "PUMPUSDT",
  "SPXUSDT",
] as const;

/**
 * Explicit operator additions for both Live and Testnet. `XP` maps to
 * XPINUSDT because Binance USD-M has no XPUSDT perpetual; XPLUSUSDT is a
 * different contract and is deliberately not inferred here.
 */
export const DAILY_RANGE_APPROVED_SUPPLEMENTAL_SYMBOLS = [
  "TUTUSDT",
  "HEMIUSDT",
  "EDENUSDT",
  "XPINUSDT",
  "PROMUSDT",
  "POLUSDT",
  "BLESSUSDT",
  "AKEUSDT",
  "TIAUSDT",
  "DOTUSDT",
  "VVVUSDT",
  "BMTUSDT",
  "DASHUSDT",
  "XMRUSDT",
] as const;

function radarVerifiedMemeSymbols(): string[] {
  try {
    return getNewCoinRadarStore()
      .getState()
      .coins
      .filter((coin) => (coin.fundamentals?.categories ?? []).some((category) => /meme/i.test(category)))
      .map((coin) => coin.symbol.trim().toUpperCase())
      .filter(Boolean);
  } catch {
    // The durable base catalog remains usable if the optional radar store is
    // unavailable during startup or recovery.
    return [];
  }
}

/**
 * Dynamic membership is allowed only after an explicit Meme category check;
 * exchangeInfo/C1-C6 then decides whether the symbol is actually tradable.
 */
export function resolveDailyRangeApprovedUniverse(): string[] {
  return [...new Set([
    ...DAILY_RANGE_MEME_BASE_SYMBOLS,
    ...DAILY_RANGE_APPROVED_SUPPLEMENTAL_SYMBOLS,
    ...radarVerifiedMemeSymbols(),
  ])].sort();
}
