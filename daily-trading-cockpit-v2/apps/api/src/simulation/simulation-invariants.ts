/**
 * Simulation invariants (Market Digital Twin, Phase-1 foundation). Structural checks a scenario/frame stream must
 * satisfy: monotonic time, OHLC validity, positivity, finiteness, provenance preservation, no silent real↔synthetic
 * mixing. Pure — returns a report, never throws (callers decide). Used by tests + the scenario builder.
 */
import type { CommonMarketFrame } from "./simulation-types.js";
import { validateFrameInvariants } from "./common-market-frame.js";
import type { SimulationProvenance } from "./simulation-provenance.js";

export interface InvariantReport {
  ok: boolean;
  frames: number;
  violations: string[];
  distinctProvenances: SimulationProvenance[];
  monotonicTime: boolean;
  anyNaNOrInfinity: boolean;
}

export function checkFrameStreamInvariants(frames: readonly CommonMarketFrame[], opts?: { expectSingleProvenance?: boolean }): InvariantReport {
  const violations: string[] = [];
  let prevAsOf = -Infinity;
  let monotonic = true;
  let anyBad = false;
  const provenances = new Set<SimulationProvenance>();

  for (const [i, f] of frames.entries()) {
    provenances.add(f.provenance);
    if (f.asOfMs < prevAsOf) { monotonic = false; violations.push(`frame ${i} asOf ${f.asOfMs} < prev ${prevAsOf} (time went backward)`); }
    prevAsOf = f.asOfMs;
    const inv = validateFrameInvariants(f);
    if (!inv.ok) { violations.push(...inv.violations.map((v) => `frame ${i}: ${v}`)); }
    for (const sf of Object.values(f.symbols)) {
      const c = sf.candle.value;
      if (c && [c.open, c.high, c.low, c.close, c.volume].some((v) => !Number.isFinite(v))) anyBad = true;
    }
  }

  // Provenance-mixing guard: a "single provenance" scenario must not silently contain more than one class.
  if (opts?.expectSingleProvenance && provenances.size > 1) {
    violations.push(`provenance mixing: expected single, found {${[...provenances].join(", ")}}`);
  }
  if (anyBad) violations.push("NaN/Infinity present in a candle");

  return {
    ok: violations.length === 0,
    frames: frames.length,
    violations,
    distinctProvenances: [...provenances],
    monotonicTime: monotonic,
    anyNaNOrInfinity: anyBad,
  };
}
