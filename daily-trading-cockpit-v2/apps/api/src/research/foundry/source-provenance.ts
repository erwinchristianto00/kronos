export type FoundryProvenanceType = "EXCHANGE_HISTORICAL_EXPORT" | "KRONOS_CANONICAL_LEDGER" | "DERIVED_FROM_FOUNDRY_ARTIFACTS" | "FIXTURE";

/** Immutable origin metadata bound into every Foundry semantic identity. */
export interface FoundrySourceProvenance {
  provenanceType: FoundryProvenanceType;
  provider: string;
  exchange: string;
  datasetId: string;
  retrievedAtMs: number;
  rawFileHash: string;
  schemaVersion: string;
  generationToolSha: string;
}

const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{7,64}$/;

export function assertFoundrySourceProvenance(value: FoundrySourceProvenance | undefined): asserts value is FoundrySourceProvenance {
  if (!value || !value.provenanceType || !value.provider || !value.exchange || !value.datasetId || !Number.isInteger(value.retrievedAtMs) || value.retrievedAtMs < 0 || !HASH.test(value.rawFileHash) || !value.schemaVersion || !SHA.test(value.generationToolSha)) throw new Error("FOUNDRY_SOURCE_PROVENANCE_INVALID");
}

export function fixtureSourceProvenance(datasetId: string, generationToolSha = "0000000"): FoundrySourceProvenance {
  return { provenanceType: "FIXTURE", provider: "test-fixture", exchange: "TEST", datasetId, retrievedAtMs: 0, rawFileHash: "0".repeat(64), schemaVersion: "v1", generationToolSha };
}
