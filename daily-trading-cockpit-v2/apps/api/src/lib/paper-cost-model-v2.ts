/**
 * PAPER COST MODEL v2 — the arithmetic only, on primitives, with NO imports (2026-07-28).
 *
 * WHY IT LIVES HERE AND NOT IN THE ROUTER. The v2 model shipped inside
 * paper-execution-router.ts, and live/3103 runs a router that is ~977 lines behind canonical.
 * Copying that file over pulls in Exit Brain and variant-matrix dependencies 3103 does not have, so
 * the port stalled. Duplicating the formula into live instead would be worse than stalling: two
 * copies of a cost model that must agree exactly, or the two cohorts diverge silently and every
 * cross-instance comparison becomes a lie about execution cost rather than an obvious bug.
 *
 * So the formula moves down here, takes plain numbers, and imports nothing. Canonical calls it, and
 * an older instance can call it too — the same arithmetic, provably, because there is only one copy.
 *
 * WHAT v2 CHANGES vs the flat v1 `-(22 / stopBps)`:
 *   - exit-aware      — a stop-like exit pays STOP_OUT_SLIPPAGE_BPS on top; a TP-like one does not
 *   - cost-model aware— maker round-trips cost a fraction of taker ones
 *   - no double-count — slippage already realized inside grossR is netted back out
 *   - floored         — an over-configured PAPER_*_SLIPPAGE_BPS can never drive the charge to zero
 *   - funded          — completed 8h funding periods are charged at exit
 *
 * SIGN: returns R, SIGNED NEGATIVE. The paper convention is `netR = grossR + costR`. (The variant
 * matrix uses the opposite sign, `netR = grossR - costR` — do not mix them.)
 *
 * COHORT WARNING: v1 and v2 numbers are NOT comparable and must never be pooled. Every row the
 * resolver closes is stamped with its generation for exactly this reason.
 */

/** Funding charged per completed 8-hour period, in bps of price. */
export const PAPER_FUNDING_BPS_PER_8H = 1.5;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

/** A stop-like exit slips; a TP-like one fills at its resting limit. MARK_TO_MARKET is genuinely
 *  neither, and it splits the difference: NO stop-out surcharge (nothing was triggered), but it nets
 *  out the STOP slippage, because a close at a candle mark has no resting limit protecting it. Do
 *  not "simplify" it to either neighbour — see slipAlreadyInGrossBps below. */
export type PaperExitKindV2 = "TP_LIKE" | "STOP_LIKE" | "MARK_TO_MARKET";

export interface PaperCostV2Inputs {
  /** Planned stop distance in bps. Everything is expressed as a fraction of this — at <= 0 there is
   *  no risk unit to divide by, so the honest answer is 0 rather than a fabricated charge. */
  stopBps: number;
  /** Declared cost basis for the order (the matrix's `costModel`, falling back to fillMode). */
  costModel: "maker_limit" | "taker";
  kind: PaperExitKindV2;
  /** Round-trip bps for each basis — injected, not hardcoded, because STOP_OUT_SLIPPAGE_BPS is
   *  env-tunable in the variant matrix and an instance may legitimately carry different values. */
  takerRoundTripBps: number;
  makerRoundTripBps: number;
  realisticFeeBpsPerSide: number;
  stopOutSlippageBps: number;
  /** Slippage ALREADY realized inside grossR on this path, which must not be charged twice.
   *  walkVariantPath is handed raw E/S/T, so a walk-resolved close has none — pass 0. */
  slipAlreadyInGrossBps: number;
  /** Both required to charge funding; either absent or non-finite ⇒ no funding component. */
  openedAtMs?: number | null;
  exitAtMs?: number | null;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Completed 8h funding periods, in R, signed negative. PARTIAL periods are deliberately NOT
 * prorated: funding is charged by the venue at discrete settlement times, so a position closed at
 * 7h59m has genuinely paid nothing. Prorating would invent a cost that was never incurred.
 */
export function paperFundingCostR(stopBps: number, openedAtMs?: number | null, exitAtMs?: number | null): number {
  if (!(stopBps > 0) || !finite(openedAtMs) || !finite(exitAtMs)) return 0;
  if (exitAtMs <= openedAtMs) return 0;
  const periods = Math.floor((exitAtMs - openedAtMs) / EIGHT_HOURS_MS);
  return periods > 0 ? -((periods * PAPER_FUNDING_BPS_PER_8H) / stopBps) : 0;
}

/**
 * The whole v2 charge for one exit, in R, signed negative.
 *
 * The floor is the point of the `Math.max`: it never charges less than the pure exchange fee, so a
 * mis-set slippage config can reduce the modeled cost but can never erase it. Funding is added
 * AFTER the floor — it is a separate, genuinely-incurred cost, not part of the round-trip that the
 * floor protects.
 */
export function paperExitCostRV2(input: PaperCostV2Inputs): number {
  const { stopBps } = input;
  if (!(stopBps > 0)) return 0;
  const maker = input.costModel === "maker_limit";
  const roundTripBps = maker ? input.makerRoundTripBps : input.takerRoundTripBps;
  const feeOnlyFloorBps = maker ? input.makerRoundTripBps : input.realisticFeeBpsPerSide * 2;
  const stopOutExtraBps = input.kind === "STOP_LIKE" ? Math.max(0, input.stopOutSlippageBps) : 0;
  const chargedBps = Math.max(
    feeOnlyFloorBps,
    roundTripBps + stopOutExtraBps - Math.max(0, input.slipAlreadyInGrossBps),
  );
  return -(chargedBps / stopBps) + paperFundingCostR(stopBps, input.openedAtMs, input.exitAtMs);
}

/**
 * Slippage already inside grossR for a NON-walk (inline) close. Walk-resolved closes always pass 0 —
 * walkVariantPath computes grossR from raw prices with no execution model applied.
 */
export function slipAlreadyInGrossBps(
  kind: PaperExitKindV2,
  entrySlippageBps: number,
  tpSlippageBps: number,
  stopSlippageBps: number,
): number {
  const entry = Math.max(0, entrySlippageBps);
  // ONLY a TP-like exit nets out the TP slippage. STOP_LIKE and MARK_TO_MARKET both net out the
  // STOP figure — an MTM close exits at a candle close with no resting limit protecting it, so the
  // slippage already inside grossR is the stop-side one even though no stop was triggered and no
  // stop-out surcharge is charged. Getting this backwards changes the MTM charge from 15bps to
  // 20bps on the reference geometry; paper-cost-symmetry.test.ts case E pins it.
  const exit = kind === "TP_LIKE" ? Math.max(0, tpSlippageBps) : Math.max(0, stopSlippageBps);
  return entry + exit;
}
