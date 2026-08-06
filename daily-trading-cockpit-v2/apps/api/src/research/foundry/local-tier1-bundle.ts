import type { FoundryExpectedCoverage } from "./derived-coverage.js";
import { importLocalBinanceCandleArchive, importLocalBinanceFundingArchive } from "./local-binance-archive-adapter.js";
import { buildTier1CapabilityReport, type Tier1CapabilityReport } from "./tier1-capability.js";

/** Builds only what local archives evidence; other Tier-1 artifacts remain explicit blockers. */
export function buildLocalTier1ArchiveBundle(input: { candleRoot: string; fundingRoot: string; candleExpectedCoverage: FoundryExpectedCoverage; fundingExpectedCoverage: FoundryExpectedCoverage; source: string; generatedAtMs: number; generationSha: string }): { candle: ReturnType<typeof importLocalBinanceCandleArchive>; funding: ReturnType<typeof importLocalBinanceFundingArchive>; capability: Tier1CapabilityReport } {
  const candle = importLocalBinanceCandleArchive({ root: input.candleRoot, expectedCoverage: input.candleExpectedCoverage, source: input.source, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha });
  const funding = importLocalBinanceFundingArchive({ root: input.fundingRoot, expectedCoverage: input.fundingExpectedCoverage, source: input.source, generatedAtMs: input.generatedAtMs, generationSha: input.generationSha });
  return { candle, funding, capability: buildTier1CapabilityReport([candle.manifest, funding.manifest]) };
}
