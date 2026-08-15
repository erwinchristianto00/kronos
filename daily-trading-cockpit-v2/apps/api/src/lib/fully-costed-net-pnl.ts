/**
 * Display-side reconstruction of a single-symbol position's FULLY COSTED economics.
 *
 * `netPnlUsd` on these records is deliberately exit-side only. That is not a defect and must not
 * be "repaired" in the store: it is what the daily-loss entry gate and the consecutive-loss kill
 * switch read, and `FOLD_ENTRY_LEG_INTO_PNL` exists precisely so an operator decides when those
 * gates start seeing the entry commission. The record labels which it is
 * (`entryLegFoldedIntoPnl`) and records exactly what is missing (`entryCommissionUsd`), so a
 * READER can present the true figure without moving anything a gate consumes.
 *
 * Measured 2026-08-15 on the XSEC directional lanes: 13 closed positions, every one
 * `entryLegFoldedIntoPnl: false` with `feeSource: "EXCHANGE"`. The entry side is 4.00 bps against
 * 3.99 recorded — so the presented net was overstating by 23% of the SHORT lane's entire recorded
 * P&L ($0.5248 shown, $0.4063 real).
 *
 * The flag is STRICTLY three-valued and this module honours that:
 *   true      — the entry commission is already inside the totals; adding it would double-count.
 *   false     — totals are exit-side only; `entryCommissionUsd` is additive.
 *   undefined — NOT ANSWERABLE. Closed before the field existed, entry row never observed, or
 *               closed via the flat-estimate arm whose feeEstimateUsd already models BOTH sides.
 *               Reconstructing here would silently double-count that last case, so the value is
 *               passed through untouched and counted as uncorrected instead.
 *
 * `entryRealizedPnlUsd` is included for the same reason `fourBrainActualNet` includes it: normally
 * 0, but a NONZERO value means that "entry" actually reduced an opposite position on this netted
 * account, and the position's true economics include it.
 *
 * Pure and import-free.
 */

export interface CostedPositionLike {
  netPnlUsd: number | null;
  feeEstimateUsd?: number | null;
  entryCommissionUsd?: number | null;
  entryRealizedPnlUsd?: number | null;
  entryLegFoldedIntoPnl?: boolean | null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** True only when the entry leg is known to be missing AND its size is known. */
export function isEntryLegRecoverable(p: CostedPositionLike): boolean {
  return p.entryLegFoldedIntoPnl === false && finite(p.entryCommissionUsd) && finite(p.entryRealizedPnlUsd);
}

/**
 * Net P&L including the entry leg when that is knowable, otherwise the value as recorded.
 * Never returns null for a position whose `netPnlUsd` is a number — a display total must not
 * silently drop rows, so an unanswerable record is passed through and reported via
 * `summariseCostedPositions().uncorrected`.
 */
export function fullyCostedNetPnlUsd(p: CostedPositionLike): number | null {
  if (!finite(p.netPnlUsd)) return null;
  if (!isEntryLegRecoverable(p)) return p.netPnlUsd;
  return p.netPnlUsd + (p.entryRealizedPnlUsd as number) - (p.entryCommissionUsd as number);
}

/** Fee including the entry commission when knowable, otherwise as recorded. */
export function fullyCostedFeeUsd(p: CostedPositionLike): number | null {
  if (!finite(p.feeEstimateUsd)) return null;
  if (!isEntryLegRecoverable(p)) return p.feeEstimateUsd;
  return p.feeEstimateUsd + (p.entryCommissionUsd as number);
}

export interface CostedSummary {
  n: number;
  corrected: number;
  /** Records whose entry leg could not be reconstructed — presented as recorded. */
  uncorrected: number;
  recordedNetUsd: number;
  fullyCostedNetUsd: number;
  /** Always <= 0: the entry commission can only reduce net P&L. */
  deltaUsd: number;
}

export function summariseCostedPositions(positions: readonly CostedPositionLike[]): CostedSummary {
  let corrected = 0;
  let uncorrected = 0;
  let recorded = 0;
  let costed = 0;
  let n = 0;
  for (const p of positions) {
    if (!finite(p.netPnlUsd)) continue;
    n += 1;
    recorded += p.netPnlUsd;
    costed += fullyCostedNetPnlUsd(p) as number;
    if (isEntryLegRecoverable(p)) corrected += 1;
    else uncorrected += 1;
  }
  return {
    n,
    corrected,
    uncorrected,
    recordedNetUsd: recorded,
    fullyCostedNetUsd: costed,
    deltaUsd: costed - recorded,
  };
}
