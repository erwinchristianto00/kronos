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
 * Funding settlements CROSSED by the hold, in R, signed negative. Partial periods are deliberately
 * not prorated: the venue charges funding at discrete settlement instants, so what matters is how
 * many of those instants the position was open across — not how much wall-clock elapsed.
 *
 * Counted on the venue's own fixed UTC grid (00:00 / 08:00 / 16:00), not as elapsed-time-since-open.
 * This used to be `floor((exitAtMs - openedAtMs) / 8h)`, which measures 8h blocks from whenever the
 * position happened to open. For a hold of length L opened at phase offset r into a period, the true
 * number of crossings is floor((r + L) / 8h) >= floor(L / 8h), with equality only when r === 0 — so
 * the old form could only ever MATCH or UNDER-count real funding, never over-count, biasing paper
 * netR cheaper than reality on essentially every close (almost no open lands exactly on the grid).
 * The clearest case it got wrong: open 07:58 UTC, close 08:05 UTC pays one real funding charge but
 * scored `floor(7min / 8h) = 0`.
 *
 * The epoch is itself 00:00 UTC and 8h divides 24h evenly, so `floor(t / 8h)` IS the grid index and
 * the crossing count is just the difference. A settlement exactly at the open instant is not charged
 * (the position did not hold across it); one exactly at the exit instant is.
 */
export function paperFundingCostR(stopBps: number, openedAtMs?: number | null, exitAtMs?: number | null): number {
  if (!(stopBps > 0) || !finite(openedAtMs) || !finite(exitAtMs)) return 0;
  if (exitAtMs <= openedAtMs) return 0;
  const periods = Math.floor(exitAtMs / EIGHT_HOURS_MS) - Math.floor(openedAtMs / EIGHT_HOURS_MS);
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
  // A maker_limit order posts its ENTRY as a resting limit, but its exit is only maker when a TP
  // LIMIT fills. A stop-out exits at market, and so does a mark-to-market horizon close — both pay
  // the TAKER rate on the way out. So the all-maker round trip applies to TP_LIKE only; the other
  // two kinds are maker-in / taker-out.
  //
  // Both `roundTripBps` AND `feeOnlyFloorBps` used to be pinned to makerRoundTripBps for every kind,
  // which meant the Math.max floor could not catch the shortfall either: the most a maker-lane
  // stop-out could ever be charged was 4 + 12 = 16bps against a real ~19bps, a fixed ~3bps/stopBps
  // undercharge on every maker-lane loss. current-guard-variant-matrix.ts flagged exactly this when
  // MAKER_ROUNDTRIP_BPS was corrected to 4 ("that round trip is really 2 + 5 = 7 ... does NOT add
  // the maker->taker fee difference (3 bps) there"), and deferred it as a cost-model change. This is
  // that change. Undercharging losses specifically is the same asymmetry STOP_OUT_SLIPPAGE_BPS
  // exists to remove: it flatters low-win-rate maker lanes.
  const makerPerSideBps = input.makerRoundTripBps / 2;
  const makerInTakerOutBps = makerPerSideBps + input.realisticFeeBpsPerSide;
  const roundTripBps = !maker
    ? input.takerRoundTripBps
    : input.kind === "TP_LIKE"
      ? input.makerRoundTripBps
      : makerInTakerOutBps;
  const feeOnlyFloorBps = !maker
    ? input.realisticFeeBpsPerSide * 2
    : input.kind === "TP_LIKE"
      ? input.makerRoundTripBps
      : makerInTakerOutBps;
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
