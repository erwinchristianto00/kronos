import type { FoundryArtifactKind } from "./artifact-schema.js";
import type { FoundryExpectedCoverage } from "./derived-coverage.js";

export interface ExternalAcquisitionContract { artifactKind: FoundryArtifactKind; provider: string; dataset: string; schemaVersion: "v1"; requiredFields: string[]; range: { startMs: number; endMs: number; symbols: string[] }; retrievalCommand: string; }
export interface ExternalAcquisitionBlockerReport { canAssembleRealTier1: false; blockers: string[]; contracts: ExternalAcquisitionContract[]; }

const requirements: Array<Omit<ExternalAcquisitionContract, "range">> = [
  { artifactKind: "COMPLETED_CANDLES", provider: "Binance Vision / approved exchange archive", dataset: "USD-M completed kline export", schemaVersion: "v1", requiredFields: ["symbol", "open_time", "close_time", "open", "high", "low", "close", "volume"], retrievalCommand: "Provide immutable CSV export root: <candles-root>/<SYMBOL>/1h/*.csv" },
  { artifactKind: "FUNDING_SETTLEMENTS", provider: "Binance Vision / approved exchange archive", dataset: "USD-M funding settlement export plus historical schedule", schemaVersion: "v1", requiredFields: ["symbol", "calc_time", "last_funding_rate", "funding_interval_hours"], retrievalCommand: "Provide immutable CSV export root: <funding-root>/fundingRate/<SYMBOL>/*.csv and schedule metadata" },
  { artifactKind: "LISTING_DELISTING_TIMELINE", provider: "Exchange historical export", dataset: "symbol listing and delisting state intervals", schemaVersion: "v1", requiredFields: ["symbol", "effectiveTimeMs", "validUntilMs", "status", "sourceHash"], retrievalCommand: "Export authoritative historical listing/delisting intervals through range end, or an exhaustive timestamped lifecycle crawl with a source-backed validity watermark; do not query current exchange state" },
  { artifactKind: "FUTURES_AVAILABILITY_TIMELINE", provider: "Exchange historical export", dataset: "USD-M contract availability state intervals", schemaVersion: "v1", requiredFields: ["symbol", "effectiveTimeMs", "validUntilMs", "available", "sourceHash"], retrievalCommand: "Export authoritative USD-M availability intervals through range end, or an exhaustive timestamped lifecycle crawl with a source-backed validity watermark; do not infer from candles" },
  { artifactKind: "PIT_LIQUIDITY_SPREAD", provider: "Exchange historical export", dataset: "timestamped volume, liquidity notional, and spread", schemaVersion: "v1", requiredFields: ["symbol", "asOfMs", "validUntilMs", "volume", "liquidityNotional", "spreadBps", "sourceHash"], retrievalCommand: "Export PIT volume/order-book liquidity/spread snapshots covering every eligible decision tick" },
];

/** Never fetches current data. It only tells an operator exactly which immutable export is missing. */
export function buildExternalAcquisitionBlockerReport(input: { expectedCoverage: FoundryExpectedCoverage; availableArtifactKinds: readonly FoundryArtifactKind[] }): ExternalAcquisitionBlockerReport {
  const contracts = requirements.map((requirement) => ({ ...requirement, range: { startMs: input.expectedCoverage.startMs, endMs: input.expectedCoverage.endMs, symbols: [...input.expectedCoverage.symbols].sort() } }));
  return { canAssembleRealTier1: false, blockers: contracts.filter((contract) => !input.availableArtifactKinds.includes(contract.artifactKind)).map((contract) => `EXTERNAL_EXPORT_REQUIRED:${contract.artifactKind}:${contract.dataset}`), contracts };
}
