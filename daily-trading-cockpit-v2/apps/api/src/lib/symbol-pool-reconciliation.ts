/**
 * Reconciling the ACTIVE symbol pool against what the criteria currently produce.
 *
 * WHY THIS EXISTS. The dashboard warned "1 simbol tidak sesuai kriteria: WIF" and nothing anywhere
 * could act on it. `universe-rotation-intelligence.ts` is explicitly read-only advisory and scores
 * P&L contribution, not C1/C2; the allowlists are module-level `envSymbolSet` consts evaluated once
 * at import, so nothing can rotate them while the process runs. The pool was therefore reconciled
 * by hand, twice, and drifted again within a day.
 *
 * WHY HYSTERESIS IS THE WHOLE DESIGN, not a refinement. WIF measured $199,118/h against a $200,000
 * floor — it failed by 0.44%. Liquidity is a rolling 24h figure that wanders; a hard threshold with
 * no band makes a symbol at the line flap in and out every few hours. Each flap is not free: it
 * rewrites the pool the overlap guard compares against, and dropping a symbol mid-position is worse
 * still. So a symbol only ENTERS above the floor plus a margin, only LEAVES below the floor minus
 * that margin, and anything inside the band keeps whatever membership it already has. Membership is
 * sticky by construction, and the band is the only thing standing between "criteria-driven" and
 * "churning".
 *
 * DELIBERATELY PURE AND IMPORT-FREE. It decides; it writes nothing, calls no exchange, and reads no
 * env. Applying a decision is a separate, human-gated step — see `poolReconciliationPlan`'s notes on
 * why auto-applying is unsafe today.
 */

export interface PoolSymbolReading {
  symbol: string;
  /** Measured liquidity. `null` means UNMEASURED — never treated as a failure. */
  liquidityUsdPerHour: number | null;
  /** Minimum notional of one lot. `null` means UNMEASURED. */
  oneLotUsd: number | null;
  /** Currently in the active allowlist. */
  inPool: boolean;
  /** Has an OPEN position right now. Such a symbol is never dropped. */
  hasOpenPosition?: boolean;
}

export interface PoolThresholds {
  minLiquidityUsdPerHour: number;
  /** One lot must not exceed this. */
  maxOneLotUsd: number;
  /** Fraction, e.g. 0.10 = a symbol must clear the floor by 10% to ENTER and fall 10% below it to
   *  LEAVE. Zero reproduces the old hard-threshold behaviour, flapping included. */
  hysteresisFraction: number;
  /** Never shrink the pool below this. A cross-sectional basket needs 2*K symbols plus room for the
   *  overlap guard to find a different combination; starving it is worse than carrying a marginal
   *  symbol. */
  minPoolSize: number;
}

export type PoolAction = "KEEP" | "ADD" | "DROP" | "HOLD_BAND" | "HOLD_OPEN" | "HOLD_MIN_SIZE" | "UNMEASURED";

export interface PoolDecision {
  symbol: string;
  action: PoolAction;
  reason: string;
}

export interface PoolReconciliationPlan {
  decisions: PoolDecision[];
  /** The pool as it SHOULD be. Equal to the current pool when nothing needs to change. */
  proposedPool: string[];
  adds: string[];
  drops: string[];
  /** True when proposedPool differs from the current pool. */
  changed: boolean;
  /** Symbols the criteria dislike but that are being kept, and why. Surfaced rather than silent —
   *  a plan that quietly carries a failing symbol is how a hand-picked list survives again. */
  heldDespiteFailure: PoolDecision[];
  /** Set when the exchange read failed for every symbol: NO decision is trustworthy and the caller
   *  must not apply the plan. */
  unmeasured: boolean;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Decide the pool. Never throws; unusable input degrades to "keep what we have".
 *
 * A symbol whose liquidity is UNMEASURED is held, not dropped: a failed exchange read is not
 * evidence against a symbol, and treating it as one would empty the pool during an outage — the
 * exact failure mode `PoolReport.measured` was added to prevent on the display side.
 */
export function poolReconciliationPlan(
  readings: ReadonlyArray<PoolSymbolReading>,
  thresholds: PoolThresholds,
): PoolReconciliationPlan {
  const band = Math.max(0, thresholds.hysteresisFraction);
  const enterAt = thresholds.minLiquidityUsdPerHour * (1 + band);
  const leaveAt = thresholds.minLiquidityUsdPerHour * (1 - band);

  const decisions: PoolDecision[] = [];
  for (const r of readings) {
    const liq = r.liquidityUsdPerHour;
    const lot = r.oneLotUsd;

    if (!isNum(liq) || !isNum(lot)) {
      decisions.push({
        symbol: r.symbol,
        action: "UNMEASURED",
        reason: r.inPool
          ? "tidak terukur — dipertahankan; pembacaan yang gagal bukan bukti melawan simbol"
          : "tidak terukur — tetap di luar; tidak ada dasar untuk memasukkannya",
      });
      continue;
    }

    // C2 has no hysteresis and must not: one lot against the leg size is exchange arithmetic, not a
    // rolling measurement, so it does not wander and a band would only delay a real exclusion.
    if (lot > thresholds.maxOneLotUsd) {
      decisions.push({
        symbol: r.symbol,
        action: r.inPool ? "DROP" : "KEEP",
        reason: `satu lot $${lot.toFixed(2)} > plafon $${thresholds.maxOneLotUsd.toFixed(2)}`,
      });
      continue;
    }

    if (r.inPool) {
      if (liq >= leaveAt) {
        decisions.push({
          symbol: r.symbol,
          action: liq >= enterAt ? "KEEP" : "HOLD_BAND",
          reason: liq >= enterAt
            ? `likuiditas $${Math.round(liq).toLocaleString("en-US")}/jam di atas ambang`
            : `di dalam pita histeresis ($${Math.round(leaveAt).toLocaleString("en-US")}–$${Math.round(enterAt).toLocaleString("en-US")}) — keanggotaan dipertahankan agar tidak berkedip`,
        });
      } else {
        decisions.push({
          symbol: r.symbol,
          action: "DROP",
          reason: `likuiditas $${Math.round(liq).toLocaleString("en-US")}/jam di BAWAH batas keluar $${Math.round(leaveAt).toLocaleString("en-US")}`,
        });
      }
    } else {
      decisions.push({
        symbol: r.symbol,
        action: liq >= enterAt ? "ADD" : "KEEP",
        reason: liq >= enterAt
          ? `likuiditas $${Math.round(liq).toLocaleString("en-US")}/jam melewati batas masuk $${Math.round(enterAt).toLocaleString("en-US")}`
          : `di luar pool; $${Math.round(liq).toLocaleString("en-US")}/jam belum melewati batas masuk`,
      });
    }
  }

  // An open position is never dropped. Closing it is the executor's decision on its own schedule,
  // and pulling the symbol out from under it turns a pool edit into an execution event.
  for (const d of decisions) {
    if (d.action !== "DROP") continue;
    const r = readings.find((x) => x.symbol === d.symbol);
    if (r?.hasOpenPosition) {
      d.action = "HOLD_OPEN";
      d.reason = `${d.reason} — TAPI posisi masih terbuka, jadi tidak dikeluarkan sampai tertutup`;
    }
  }

  const current = readings.filter((r) => r.inPool).map((r) => r.symbol);
  const byAction = (a: PoolAction) => decisions.filter((d) => d.action === a).map((d) => d.symbol);

  // Floor the size LAST, so it can only ever cancel drops — never invent an add the criteria reject.
  // Drops are given up in order of worst liquidity retained first, so the pool keeps its best.
  let drops = byAction("DROP");
  if (current.length - drops.length < thresholds.minPoolSize) {
    const allowed = Math.max(0, current.length - thresholds.minPoolSize);
    const ranked = [...drops].sort((a, b) => {
      const la = readings.find((r) => r.symbol === a)?.liquidityUsdPerHour ?? 0;
      const lb = readings.find((r) => r.symbol === b)?.liquidityUsdPerHour ?? 0;
      return la - lb;
    });
    const keep = new Set(ranked.slice(allowed));
    for (const d of decisions) {
      if (d.action === "DROP" && keep.has(d.symbol)) {
        d.action = "HOLD_MIN_SIZE";
        d.reason = `${d.reason} — TAPI mengeluarkannya membuat pool di bawah minimum ${thresholds.minPoolSize}`;
      }
    }
    drops = byAction("DROP");
  }

  const adds = byAction("ADD");
  const dropSet = new Set(drops);
  const proposedPool = [...current.filter((s) => !dropSet.has(s)), ...adds].sort();

  return {
    decisions,
    proposedPool,
    adds,
    drops,
    changed: proposedPool.join(",") !== [...current].sort().join(","),
    heldDespiteFailure: decisions.filter((d) => d.action === "HOLD_BAND" || d.action === "HOLD_OPEN" || d.action === "HOLD_MIN_SIZE"),
    unmeasured: readings.length > 0 && decisions.every((d) => d.action === "UNMEASURED"),
  };
}
