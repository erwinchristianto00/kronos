import type { Candidate } from "@dtc/shared";

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

  const confidence = row.kronosConfidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return NONE;

  const magnitude = Math.max(0, Math.min(1, confidence));
  // A zero-confidence LONG is not an opinion. Returning 0 would be indistinguishable from a genuine
  // neutral reading and would be stamped FRESH by the consumer; absent is the honest answer.
  if (magnitude === 0) return NONE;
  if (scanFinishedAtMs === null || !Number.isFinite(scanFinishedAtMs)) return NONE;

  return { agree: bias === "LONG" ? magnitude : -magnitude, atMs: scanFinishedAtMs };
}
