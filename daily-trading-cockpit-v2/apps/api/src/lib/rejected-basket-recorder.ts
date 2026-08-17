/**
 * Append-only sink for baskets the minScoreGap gate refused.
 *
 * 2026-08-17. `buildCrossSectionalBasket` returns null when the gap is below the floor, so a rejected
 * basket has never been written anywhere. Measured on the live store: min recorded scoreGap is 0.0202
 * for FILTERED and 0.0315 for RAW, with ZERO observations below the 0.02 floor. That makes "is this
 * gate set correctly?" unanswerable from live data no matter how long the lane runs — the data is not
 * scarce, it is never created. Rebuilt from 2 years of klines the gate turns out to reject only 29 of
 * 17,835 baskets (0.2%), i.e. it is close to inert; but that is a simulation of the rule, not of this
 * deployment, and only a real record settles it.
 *
 * Deliberately NOT an entry in the observation store, for three reasons found by tracing the readers:
 *   - `alreadyThisBucket` in cross-sectional-edge.ts would then see it and block a REAL basket from
 *     forming later in the same hourly bucket — a behaviour change, not instrumentation;
 *   - the executor's candidate filter selects on `status === "OPEN"` and `variant === targetVariant`,
 *     so a stored rejection could be picked up and EXECUTED;
 *   - `observationVariant()` derives the variant from the signal NAME as a fallback, so any new
 *     variant silently reclassifies as RAW and contaminates the RAW report.
 *
 * Only composition and timestamp are stored. Forward returns are recomputed from klines at analysis
 * time, so there is no resolution machinery to starve and nothing here can go stale.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CrossSectionalGapRejection } from "./cross-sectional-edge.js";

/** Rotates at this size so an append-only file cannot fill the disk (it is already at 94%). */
const MAX_BYTES = 8 * 1024 * 1024;

export function rejectedBasketLogPath(): string {
  return process.env.CROSS_SECTIONAL_REJECTED_LOG ?? resolve(process.cwd(), "data", "cross-sectional-rejected.jsonl");
}

/** One JSON line per rejection. Never throws — instrumentation must not break basket formation. */
export function recordRejectedBasket(info: CrossSectionalGapRejection, path = rejectedBasketLogPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, `${JSON.stringify({ ...info, recordedAt: new Date().toISOString() })}\n`);
  } catch {
    // swallowed on purpose
  }
}
