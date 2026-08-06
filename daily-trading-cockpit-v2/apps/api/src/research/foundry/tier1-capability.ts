import { assertCompleteFoundryArtifact, type FoundryArtifactManifest } from "./artifact-schema.js";

const TIER_1_REQUIRED = ["COMPLETED_CANDLES", "FUNDING_SETTLEMENTS", "LISTING_DELISTING_TIMELINE", "FUTURES_AVAILABILITY_TIMELINE", "MINIMUM_HISTORY_ELIGIBILITY", "PIT_LIQUIDITY_SPREAD", "CANONICAL_EPISODES", "PORTFOLIO_RISK_SNAPSHOTS"] as const;

export interface Tier1CapabilityReport { tier: "TIER_1_BASELINE"; canRun: boolean; supportedArtifacts: string[]; blockers: string[]; artifactSemanticHashes: string[]; }

/** A capability report is allowed to say incomplete; it never supplies missing history. */
export function buildTier1CapabilityReport(manifests: readonly FoundryArtifactManifest[]): Tier1CapabilityReport {
  const byKind = new Map(manifests.map((manifest) => [manifest.artifactKind, manifest])); const blockers: string[] = [];
  for (const kind of TIER_1_REQUIRED) {
    const manifest = byKind.get(kind);
    if (!manifest) { blockers.push(`MISSING_ARTIFACT:${kind}`); continue; }
    try { assertCompleteFoundryArtifact(manifest); } catch (error) { blockers.push(`INCOMPLETE_ARTIFACT:${kind}:${error instanceof Error ? error.message : "UNKNOWN"}`); }
  }
  return { tier: "TIER_1_BASELINE", canRun: blockers.length === 0, supportedArtifacts: manifests.map((manifest) => manifest.artifactKind).sort(), blockers, artifactSemanticHashes: manifests.map((manifest) => manifest.semanticManifestHash).sort() };
}
