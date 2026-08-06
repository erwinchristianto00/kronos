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

/** Derived rows are reproducible only when their exact immutable parents and policy are bound. */
export interface FoundryDerivationIdentity {
  version: "foundry-derivation-v1";
  policyVersion: string;
  parameters: Record<string, string | number | boolean>;
  parentSemanticManifestHashes: string[];
}

const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{7,64}$/;

export function assertFoundrySourceProvenance(value: FoundrySourceProvenance | undefined): asserts value is FoundrySourceProvenance {
  if (!value || !value.provenanceType || !value.provider || !value.exchange || !value.datasetId || !Number.isInteger(value.retrievedAtMs) || value.retrievedAtMs < 0 || !HASH.test(value.rawFileHash) || !value.schemaVersion || !SHA.test(value.generationToolSha)) throw new Error("FOUNDRY_SOURCE_PROVENANCE_INVALID");
}

export function assertFoundryDerivationIdentity(value: FoundryDerivationIdentity | undefined): asserts value is FoundryDerivationIdentity {
  if (!value || value.version !== "foundry-derivation-v1" || !value.policyVersion || !Array.isArray(value.parentSemanticManifestHashes) || value.parentSemanticManifestHashes.length === 0 || value.parentSemanticManifestHashes.some((hash, index) => !HASH.test(hash) || (index > 0 && value.parentSemanticManifestHashes[index - 1]! >= hash)) || Object.values(value.parameters).some((parameter) => (typeof parameter !== "string" && typeof parameter !== "number" && typeof parameter !== "boolean") || (typeof parameter === "number" && !Number.isFinite(parameter)))) throw new Error("FOUNDRY_DERIVATION_IDENTITY_INVALID");
}

export function fixtureSourceProvenance(datasetId: string, generationToolSha = "0000000"): FoundrySourceProvenance {
  return { provenanceType: "FIXTURE", provider: "test-fixture", exchange: "TEST", datasetId, retrievedAtMs: 0, rawFileHash: "0".repeat(64), schemaVersion: "v1", generationToolSha };
}
