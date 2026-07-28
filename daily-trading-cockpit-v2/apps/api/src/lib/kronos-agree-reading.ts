import type { Candidate, KronosPrediction } from "@dtc/shared";

/**
 * KRONOS-AGREE for the four-brain Direction Brain (2026-07-28, PURE — no I/O).
 *
 * WHY. Direction Brain builds its LONG and SHORT scores from five sub-signals, and `kronosAgree` was
 * hardcoded `null` in app.ts with the honest note "no sync kronos-agree producer". Together with
 * crowding and sentiment also being absent, the brain has been calling market direction on roughly
 * two of its five inputs — and calling it badly: INTRADAY/LONG measures -0.475R at a 21% hit rate
 * over 38 independent windows. Missing inputs are not the whole story, but shipping a directional
 * brain with 60% of its evidence permanently null is not a fair test of it either.
 *
 * Kronos was never unreachable. It runs on the VPS (pm2 `kronos`, 127.0.0.1:8001) and the scanner
 * already calls it every cycle. What was missing was a SYNCHRONOUS reader, which is what the
 * four-brain gather needs.
 *
 * SOURCE: the scan candidates already in memory, NOT a second predict() call. kronos.ts serialises
 * inference through one global concurrency slot (KRONOS_CONCURRENCY=1, chosen deliberately after the
 * model server was measured), so adding an independent consumer would contend with the scanner for
 * that slot on every four-brain tick. The value is already computed; this only reads it.
 *
 * MAPPING to the −1..1 the consumer expects (four-brain-live-gather-bindings.ts takes
 * `clamp01((kronos + 1) / 2)` as the long-agreeing part and the mirror for short):
 *
 *   agree = sign(bias) × confidence      LONG → +conf, SHORT → −conf
 *
 * Magnitude is the model's OWN confidence rather than a bare ±1, so a hesitant call cannot push the
 * score as hard as a certain one. UNAVAILABLE, a missing bias, or a missing confidence all yield
 * null — never 0, which the consumer would read as a real "no opinion" reading rather than as an
 * absent one, and which classifySource would then stamp FRESH.
 */
/**
 * `kronosConfidence` is on a **0–100 scale**, not 0–1. tracker.ts's own bucket thresholds settle it
 * beyond argument: `< 45 WEAK`, `< 70 MEDIUM`, `>= 70 STRONG`. Every live scan row measured on
 * 2026-07-28 carried exactly `100`.
 *
 * Both readers here used to do `Math.min(1, confidence)`, which SATURATES every non-zero confidence
 * to 1.0 — a 46 and a 99 pushed the Direction score identically hard. That silently defeated the one
 * thing the magnitude exists to do, stated in this file's own doc: "a hesitant call cannot push the
 * score as hard as a certain one." It could, and always did.
 *
 * Divide first, then clamp. A value that arrives already in 0..1 (no producer does this today) maps
 * to a near-zero magnitude rather than a saturated one — understating an opinion is the safe
 * direction here, and it stays visible instead of masquerading as certainty.
 *
 * NOTE, not fixed here: meta-label-gate.ts:213 does `clamp(kronosConfidence, 0, 1)` on the same
 * field and has the same saturation. Different lane, different consumer — flagged, not touched.
 */
export const KRONOS_CONFIDENCE_SCALE_MAX = 100;

function normalizedConfidence(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const magnitude = Math.max(0, Math.min(1, raw / KRONOS_CONFIDENCE_SCALE_MAX));
  // A zero-confidence LONG is not an opinion. Returning 0 would be indistinguishable from a genuine
  // neutral reading and would be stamped FRESH by the consumer; absent is the honest answer.
  return magnitude === 0 ? null : magnitude;
}

export interface KronosAgreeReading {
  /** −1..1, or null when Kronos had no usable opinion for this symbol. NEVER 0-as-missing. */
  agree: number | null;
  /** The scan's own finish time — the clock of the producer, not of the reader. null with agree. */
  atMs: number | null;
}

const NONE: KronosAgreeReading = { agree: null, atMs: null };

export function kronosAgreeFromScan(
  candidates: readonly Candidate[] | null | undefined,
  symbol: string,
  scanFinishedAtMs: number | null,
): KronosAgreeReading {
  if (!candidates || candidates.length === 0) return NONE;
  const target = symbol.trim().toUpperCase();
  const row = candidates.find((c) => (c.symbol ?? "").trim().toUpperCase() === target);
  if (!row) return NONE;

  // selectedKronosBias is the scanner's own resolved pick across timeframes; kronosBias is the
  // single-timeframe fallback. Prefer the resolved one, exactly as the scanner's consumers do.
  const bias = row.selectedKronosBias ?? row.kronosBias ?? null;
  if (bias !== "LONG" && bias !== "SHORT") return NONE; // UNAVAILABLE / null / anything else

  const magnitude = normalizedConfidence(row.kronosConfidence);
  if (magnitude === null) return NONE;
  if (scanFinishedAtMs === null || !Number.isFinite(scanFinishedAtMs)) return NONE;

  return { agree: bias === "LONG" ? magnitude : -magnitude, atMs: scanFinishedAtMs };
}

/**
 * The SAME mapping, applied to a prediction fetched directly rather than lifted out of a scan row.
 *
 * WHY THIS EXISTS (2026-07-28, measured). The scan reader above needs BTCUSDT to be present in the
 * scan's `top10`, and `top10` is an OPPORTUNITY RANKING — it is ordered by how tradeable a symbol
 * looks right now, so it fills with movers (measured that day: SEI, SUI, WLD, NEAR, BNB, SOL, every
 * one of them carrying a perfectly good Kronos bias). BTC is the calmest large-cap in the universe
 * and therefore almost never earns a slot. Result: `kronosAgree` read MISSING on 100% of Direction
 * decisions on both instances, with the data sitting right there.
 *
 * The defect is conceptual, not mechanical. BTC is used here as the MARKET ANCHOR, and an anchor
 * must not have to qualify as an opportunity first. So the anchor gets its own reading.
 *
 * The scan reader stays the preferred source — it is free, already in memory, and freshest. This is
 * the fallback for the (usual) case where BTC did not make the list. Its producer runs on its OWN
 * low-frequency interval rather than per four-brain tick, because kronos.ts serialises inference
 * through one global concurrency slot: a per-tick consumer would contend with the scanner for it,
 * which is exactly why the original author read from the scan instead of calling predict().
 */
export function kronosAgreeFromPrediction(
  prediction: KronosPrediction | null | undefined,
  observedAtMs: number | null,
): KronosAgreeReading {
  if (!prediction || prediction.available !== true) return NONE;
  const bias = prediction.selectedKronosBias ?? prediction.kronosBias ?? null;
  if (bias !== "LONG" && bias !== "SHORT") return NONE;
  const magnitude = normalizedConfidence(prediction.kronosConfidence);
  if (magnitude === null) return NONE;
  if (observedAtMs === null || !Number.isFinite(observedAtMs)) return NONE;
  return { agree: bias === "LONG" ? magnitude : -magnitude, atMs: observedAtMs };
}
